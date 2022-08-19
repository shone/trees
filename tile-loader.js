importScripts('xxhash.min.js');

onmessage = async function(event) {
	const csvPath = event.data;
	postMessage({
		task: 'Downloading CSV',
	});
	let csvText = '';
	try {
		const csvResponse = await fetch(csvPath);
		const csvSize = parseInt(csvResponse.headers.get('Content-Length'));
		const reader = csvResponse.body.getReader();
		const decoder = new TextDecoder();
		let fetchedBytes = 0;
		while (true) {
			const {value, done} = await reader.read();
			if (done) {
				break;
			}
			csvText += decoder.decode(value, {stream: true});
			fetchedBytes += value.length;
			postMessage({
				task: 'Downloading CSV',
				progress: fetchedBytes / csvSize,
			});
		}
	} catch (error) {
		postMessage({
			task: 'Failed to download CSV: ' + error,
		});
		return;
	}

	let lineStartIndex = 0;
	let lineEndIndex = 0;
	function readLine() {
		while (lineEndIndex < csvText.length) {
			if (csvText[lineEndIndex] === '\n') {
				const line = csvText.slice(lineStartIndex, lineEndIndex);
				lineStartIndex = lineEndIndex+1;
				lineEndIndex++;
				return line;
			}
			lineEndIndex++;
		}
		return '';
	}

	performance.mark('start_read_lines');
	const firstLine = readLine();
	const fields = Object.fromEntries(firstLine.split(',').map((field, index) => [field, index]));
	const fieldCount = Object.keys(fields).length;

	const approxLineCount = Math.floor(csvText.length / 50);
	const dataBuffer = new Float32Array(fieldCount * approxLineCount);
	let dataBufferLinesCount = 0;

	for (let lineIndex=0; lineIndex<approxLineCount;) {
		const line = readLine();
		if (line === '') {
			break;
		}

		const fieldStrings = line.split(',');
		if (fieldStrings.length < fieldCount) {
			// Skip empty line when the year increments
			continue;
		}

		dataBuffer[(lineIndex*fieldCount) + fields.Year]      = +(fieldStrings[fields.Year]);
		dataBuffer[(lineIndex*fieldCount) + fields.Cell]      = +(fieldStrings[fields.Cell]);
		dataBuffer[(lineIndex*fieldCount) + fields.SLA]       = +(fieldStrings[fields.SLA]);
		dataBuffer[(lineIndex*fieldCount) + fields.Wooddens]  = +(fieldStrings[fields.Wooddens]);
		dataBuffer[(lineIndex*fieldCount) + fields.Longevity] = +(fieldStrings[fields.Longevity]);
		dataBuffer[(lineIndex*fieldCount) + fields.Height]    = +(fieldStrings[fields.Height]);

		if ((lineIndex % 10000) === 0) {
			postMessage({
				task: 'Parsing CSV',
				progress: (lineIndex/approxLineCount)
			});
		}

		lineIndex++;
		dataBufferLinesCount++;
	}
	performance.mark('finish_read_lines');
	performance.measure('read_lines', 'start_read_lines', 'finish_read_lines');
	console.log(`approxLineCount: ${approxLineCount}, actual count: ${lineEndIndex}`);

	function forEachDataEntry(callback) {
		for (let lineIndex=0; lineIndex<dataBufferLinesCount; lineIndex++) {
			callback(dataBuffer.subarray(lineIndex*fieldCount, (lineIndex+1)*fieldCount), lineIndex);
		}
	}
	
	performance.mark('start_calc_data_bounds');
	let cellCount = 0;
	let firstYear = 0;
	let lastYear  = 0;
	let heightMax = 0;
	forEachDataEntry(entry => {
		cellCount = Math.max(cellCount, entry[fields.Cell]+1);
		firstYear = Math.min(firstYear||entry[fields.Year], entry[fields.Year]);
		lastYear  = Math.max(lastYear ||entry[fields.Year], entry[fields.Year]);
		heightMax = Math.max(heightMax, entry[fields.Height])
	});
	performance.mark('finish_calc_data_bounds');
	performance.measure('calc_data_bounds', 'start_calc_data_bounds', 'finish_calc_data_bounds');

	const yearCount = lastYear - firstYear;

	const cellTreeCounts = new Uint8Array(cellCount * yearCount);
	forEachDataEntry(entry => cellTreeCounts[(cellCount*(entry[fields.Year]-firstYear)) + entry[fields.Cell]]++);
	let maxTreesPerCell = 0;
	cellTreeCounts.forEach(count => maxTreesPerCell = Math.max(maxTreesPerCell, count));
	console.log('Max number of trees per cell: ' + maxTreesPerCell);

	const cellRowsPerTile = Math.floor(Math.sqrt(cellCount));
	const cellsPerTile = cellRowsPerTile * cellRowsPerTile;
	const treeRowsPerCell = 6;
	const treesPerCell = treeRowsPerCell * treeRowsPerCell;
	const treeRowsPerTile = cellRowsPerTile * treeRowsPerCell;
	const tileTextureData = new Uint8Array(treeRowsPerTile * treeRowsPerTile * yearCount);
	console.log(`Tile texture size: ${tileTextureData.length/1024}kb`);

	const cellTreeIdMap = new Uint32Array(cellCount * treesPerCell);

	performance.mark('start_convert_to_texture');
	const hashBuffer = new Float32Array(3);
	const treeIdHasher = XXH.h32(0);
	forEachDataEntry((entry, lineIndex) => {
		if ((lineIndex % 10000) === 0) {
			postMessage({
				task: 'Processing data',
				progress: (lineIndex/dataBufferLinesCount)
			});
		}

		const cell = entry[fields.Cell];
		if (cell >= cellsPerTile) {
			return;
		}

		treeIdHasher.init(0);
		hashBuffer[0] = entry[fields.SLA];
		hashBuffer[1] = entry[fields.Longevity];
		hashBuffer[1] = entry[fields.Wooddens];
		treeIdHasher.update(hashBuffer.buffer);
		const treeId = treeIdHasher.digest().toNumber();

		let treeIndexInCell = treeId % treesPerCell;
		for (let i=0; i<treesPerCell; i++) {
			const lookupId = cellTreeIdMap[(cell*treesPerCell)+treeIndexInCell];
			if (lookupId === treeId) {
				break;
			}
			if (lookupId === 0) {
				cellTreeIdMap[(cell*treesPerCell)+treeIndexInCell] = treeId;
				break;
			}
			treeIndexInCell = (treeIndexInCell+1) % treesPerCell;
		}

		const shuffledTreeIndexInCell = (cell+treeIndexInCell) * 833 % treesPerCell;

		const x = (treeRowsPerCell*(cell%cellRowsPerTile)) + (shuffledTreeIndexInCell%treeRowsPerCell);
		const y = (treeRowsPerCell*Math.floor(cell/cellRowsPerTile)) + (Math.floor(shuffledTreeIndexInCell/treeRowsPerCell));
		const z = entry[fields.Year] - firstYear;
		const textureIndex = (treeRowsPerTile*treeRowsPerTile*z) + (treeRowsPerTile*y) + x;
		const heightRatio = entry[fields.Height] / heightMax;
		tileTextureData[textureIndex] = Math.round(255 * heightRatio);
	})
	performance.mark('finish_convert_to_texture');
	performance.measure('convert_to_texture', 'start_convert_to_texture', 'finish_convert_to_texture');

	postMessage(
		{
			cellRowsPerTile,
			treeRowsPerCell,
			treeRowsPerTile,
			firstYear,
			lastYear,
			yearCount,
			tileTextureData,
		},
		[tileTextureData.buffer]
	);
}
