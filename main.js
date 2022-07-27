'use strict';

const canvas = document.querySelector('canvas');
const webglRenderer = new THREE.WebGLRenderer({canvas});
webglRenderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdddddd);

const camera = new THREE.PerspectiveCamera(
	60, // FOV
	window.innerWidth / window.innerHeight, // Aspect
	1, // Near
	64000, // Far
);
camera.position.set(0, 10000, 10000);
camera.lookAt(0, 0, 0);

const lines = txt.split('\n');
const fields = Object.fromEntries(lines[0].split(',').map((field, index) => [field, index]));
const data = lines.slice(1).map(line => line.split(',').map(str => parseFloat(str))).filter(entry => !entry.some(n => isNaN(n)));
const cellCount = new Set(data.map(entry => entry[fields.Cell])).size;
const years = new Set(data.map(entry => entry[fields.Year]));
const firstYear = Math.min(...years);
const lastYear  = Math.max(...years);
const yearCount = lastYear - firstYear;
let slaMax = 0;
data.forEach(entry => slaMax = Math.max(slaMax, entry[fields.SLA]));
let longevityMax = 0;
data.forEach(entry => longevityMax = Math.max(longevityMax, entry[fields.Longevity]));
let wooddensMax = 0;
data.forEach(entry => wooddensMax = Math.max(wooddensMax, entry[fields.Wooddens]));
let heightMax = 0;
data.forEach(entry => heightMax = Math.max(heightMax, entry[fields.Height]));
let ageMax = 0;
data.forEach(entry => ageMax = Math.max(ageMax, entry[fields.Age]));

const cellTreeCounts = new Uint8Array(cellCount * yearCount);
data.forEach(entry => {
	cellTreeCounts[(cellCount*(entry[fields.Year]-firstYear)) + entry[fields.Cell]]++;
});
let maxTreesPerCell = 0;
cellTreeCounts.forEach(count => maxTreesPerCell = Math.max(maxTreesPerCell, count));

const cellGridWidth = Math.floor(Math.sqrt(cellCount));
const textureCellWidth = 6;
const textureCellArea = textureCellWidth*textureCellWidth;
const textureWidth = cellGridWidth * textureCellWidth;
const textureDepth = yearCount;
const texturePixelCount = textureWidth * textureWidth * textureDepth;
const textureData = new Uint8Array(texturePixelCount);
console.log(`Texture size: ${textureData.length/1024}kb`);

const cellTreeIdMap = new Uint32Array(cellCount * textureCellArea);

let prevYear = firstYear;

for (const entry of data) {
	prevYear = entry[fields.Year];
	const cell = entry[fields.Cell];
	if (cell >= (cellGridWidth*cellGridWidth)) {
		continue;
	}

	const treeIdHash = MurmurHash3('string');
	treeIdHash.hash(String(entry[fields.SLA]));
	treeIdHash.hash(String(entry[fields.Longevity]));
	treeIdHash.hash(String(entry[fields.Wooddens]));
	const treeId = treeIdHash.result();
	let treeIndexInCell = 0;
	for (let i=cell*textureCellArea; i<cell*(textureCellArea+1); i++) {
		if (cellTreeIdMap[i] === treeId || cellTreeIdMap[i] === 0) {
			treeIndexInCell = i - (cell*textureCellArea);
			if (cellTreeIdMap[i] === 0) {
				cellTreeIdMap[i] = treeId;
			}
			break;
		}
	}

	const shuffledTreeIndexInCell = (cell+treeIndexInCell) * 833 % 36;

	const slaRatio = entry[fields.SLA] / slaMax;
	const wooddensRatio = entry[fields.Wooddens] / wooddensMax;
	const x = (textureCellWidth*(cell%cellGridWidth)) + (shuffledTreeIndexInCell%6);
	const y = (textureCellWidth*Math.floor(cell/cellGridWidth)) + (Math.floor(shuffledTreeIndexInCell/6));
	const z = entry[fields.Year] - firstYear;
	const textureIndex = (textureWidth*textureWidth*z) + (textureWidth*y) + x;
	const heightRatio = entry[fields.Height] / heightMax;
	textureData[textureIndex] = Math.round(255 * heightRatio);
}

const texture = new THREE.Data3DTexture(
	textureData,
	textureWidth,
	textureWidth,
	textureDepth,
);
texture.format = THREE.RedFormat;
texture.magFilter = THREE.LinearFilter;
texture.needsUpdate = true;

const groundPlane = new THREE.Mesh(
	new THREE.PlaneGeometry(10000, 10000),
	new THREE.ShaderMaterial({
		vertexShader: `
			out vec2 uvVarying;
			void main() {
				uvVarying = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1);
			}
		`,
		fragmentShader: `
			in vec2 uvVarying;
			uniform float t;
			uniform mediump sampler3D textureSampler;
			const float textureWidth = ${textureWidth.toFixed(1)};
			const float cellGridWidth = ${cellGridWidth.toFixed(1)};
			const float textureCellWidth = ${textureCellWidth.toFixed(1)};
			const float halfPixel = (1.0/textureWidth)/2.0;
			void main() {
				//vec4 textureColor = texture(textureSampler, vec3(uvVarying.xy, t));
				float cellX = mod(uvVarying.x * cellGridWidth, 1.0);
				float cellY = mod(uvVarying.y * cellGridWidth, 1.0);
				float treeX = round(textureCellWidth * cellX);
				float treeY = round(textureCellWidth * cellY);
				vec4 textureColor = texture(
					textureSampler,
					vec3(
						(floor(uvVarying.x*cellGridWidth)/cellGridWidth) + ((1.0/cellGridWidth)*(treeX/textureCellWidth)) + halfPixel,
						(floor(uvVarying.y*cellGridWidth)/cellGridWidth) + ((1.0/cellGridWidth)*(treeY/textureCellWidth)) + halfPixel,
						t
					)
				);
				gl_FragColor = vec4(0, textureColor.r, 0, 1);
			}
		`,
		uniforms: {
			textureSampler: {type: 't', value: texture},
			t: {type: 'f', value: 0},
		}
	})
);
groundPlane.rotation.x = -Math.PI / 2;
scene.add(groundPlane);

let isRendering = false;
function render() {
	if (isRendering) {
		return;
	}
	isRendering = true;
	requestAnimationFrame(() => {
		webglRenderer.render(scene, camera);
		isRendering = false;
	});
}

function handleWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	webglRenderer.setSize(window.innerWidth, window.innerHeight, false);
	render();
}
handleWindowResize();
window.addEventListener('resize', handleWindowResize);

window.requestAnimationFrame(function callback(timestamp) {
	groundPlane.material.uniforms.t.value = (timestamp / 5000) % 1;
	render();
	window.requestAnimationFrame(callback);
});

const orbitControls = new OrbitControls(camera, webglRenderer.domElement);
orbitControls.addEventListener('change', render);
