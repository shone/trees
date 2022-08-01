'use strict';

const webglRenderer = new THREE.WebGLRenderer({canvas: document.querySelector('canvas')});
let viewport = new THREE.Vector4();

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

loadTreeDataCsv(txt);

function loadTreeDataCsv(csvText) {
	const lines = csvText.split('\n');
	const fields = Object.fromEntries(lines[0].split(',').map((field, index) => [field, index]));
	const data = lines.slice(1).map(line => line.split(',').map(str => parseFloat(str))).filter(entry => !entry.some(n => isNaN(n)));

	const cellCount = new Set(data.map(entry => entry[fields.Cell])).size;

	const years = new Set(data.map(entry => entry[fields.Year]));
	const firstYear = Math.min(...years);
	const lastYear  = Math.max(...years);
	const yearCount = lastYear - firstYear;

	let heightMax = 0; data.forEach(entry => heightMax = Math.max(heightMax,    entry[fields.Height]));

	const cellTreeCounts = new Uint8Array(cellCount * yearCount);
	data.forEach(entry => cellTreeCounts[(cellCount*(entry[fields.Year]-firstYear)) + entry[fields.Cell]]++);
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

	for (const entry of data) {
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
				out vec2 uvw;
				void main() {
					uvw = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1);
				}
			`,
			fragmentShader: `
				in vec2 uvw;
				uniform float time;
				uniform mat4 viewMatrixInverse;
				uniform mat4 projectionMatrixInverse;
				//uniform mat4 modelViewProjectionMatrixInverse;
				uniform vec4 viewport;
				uniform mediump sampler3D textureSampler;

				const float cellGridWidth = ${cellGridWidth.toFixed(1)};
				const float textureCellWidth = ${textureCellWidth.toFixed(1)};

				struct Ray {
					vec3 origin;
					vec3 dir; // assumed to be unit length
				};

				//return t of smaller hit point
				float sphereRayIntersect(const vec3 spherePosition, const float sphereRadius, const Ray ray) {
					vec3 oc = ray.origin - spherePosition;
					float dotDirOC = dot(oc, ray.dir);
					float root = dotDirOC * dotDirOC - (dot(oc, oc) - sphereRadius * sphereRadius);
					const float epsilon = 0.001;
					if(root < epsilon) {
						return -1.0;
					}
					float p = -dotDirOC;
					float q = sqrt(root);
					return (p - q) > 0.0 ? p - q : p + q;
				}

				// return normal of sphere in direction of point
				vec3 sphereNormal(const vec3 spherePosition, const vec3 point) {
					return normalize(point - spherePosition);
				}

				// Convert a point in viewport coordinates to NDC (normalized device coordinates).
				//
				// viewport coordinates are relative to the window, whereby the lower-left
				// corner of the viewport is x:0,y:0. The centers of pixels
				// are at half-steps, e.g. the center of the lower-left
				// pixel is at x:.5,y:.5
				// z is the depth of the object being rendered from the screen (near
				// clipping-plane). It's in the range [gl_DepthRange.near,gl_DepthRange.far]
				// w is the inverse of the clip-space W component, i.e. 1/clipspace.w
				//
				// In NDC space, x, y, and z range from [-1,1] with x:0,y:0 at the
				// center of the viewport. +x and +y extend in the right and upper
				// directions respectively.
				vec4 transformPointViewportToNdc(vec4 point) {
					return vec4(
						((2. * gl_FragCoord.xy) / viewport.zw) - 1.,
						((2. * gl_FragCoord.z) - gl_DepthRange.diff) / gl_DepthRange.diff,
						1.
					);
				}

				void main() {
					// gl_FragCoord is the position of the pixel being rendered in viewport coordinates.
					// Convert gl_FragCoord through the various coordinate systems to get it in world coordinates.
					vec4 fragCoordNdc = transformPointViewportToNdc(gl_FragCoord);
					vec4 fragCoordClip = fragCoordNdc / gl_FragCoord.w; // Perform perspective divide
					vec4 fragCoordEye = projectionMatrixInverse * fragCoordClip;
					vec4 fragCoordWorld = viewMatrixInverse * fragCoordEye;

	// 				// Debug visualization of world coordinates
	// 				gl_FragColor = vec4(
	// 					mod(fragCoordWorld.x, 500.) / 500.,
	// 					mod(fragCoordWorld.y, 500.) / 500.,
	// 					0.,
	// 					1
	// 				);
	// 				return;

					vec4 nearClipPos = vec4(fragCoordNdc.xy, 1., 1.) / gl_FragCoord.w;
					vec4 nearClipPosEye = projectionMatrixInverse * nearClipPos;
					vec4 nearClipPosWorld = viewMatrixInverse * nearClipPosEye;

					Ray cameraRay = Ray(nearClipPosWorld.xyz, normalize(fragCoordWorld.xyz - nearClipPosWorld.xyz));

					vec2 cellPos = floor(uvw.xy*cellGridWidth) / cellGridWidth;
					vec2 fragPosInCell = mod(uvw.xy * cellGridWidth, 1.);
					vec2 treePosInCell = (floor(fragPosInCell * textureCellWidth)+.5) / textureCellWidth;
					vec2 texturePos = cellPos + ((1./cellGridWidth)*treePosInCell);
					float treeHeight = texture(textureSampler, vec3(texturePos, time)).r;

					//intersection
					vec2 treeWorldPos = ((cellPos + (treePosInCell*(1./cellGridWidth)))-.5) * 10000.;
					float maxSphereRadius = (10000./(cellGridWidth*textureCellWidth)) * .15;
					float maxSphereHeight = (10000./(cellGridWidth*textureCellWidth)) * -.9;
					float sphereY = treeHeight * maxSphereHeight;
					float t = sphereRayIntersect(vec3(treeWorldPos.xy, sphereY), maxSphereRadius, cameraRay);

					//final color
					if(t < 0.) {
						gl_FragColor = vec4(0., 0., 0., 1.); // background
					} else {
						gl_FragColor = vec4(0., 1., 0., 1.); // sphere
						//sphere diffuse coloring
						//vec3 normal = sphereNormal(C, cameraPos + t * camDir);
					}
				}
			`,
			uniforms: {
				textureSampler: {type: 't', value: texture},
				time: {type: 'f', value: 0},
				viewport: {type: 'v4', value: viewport},
				projectionMatrixInverse: {type: 'm4', value: camera.projectionMatrixInverse},
				viewMatrixInverse: {type: 'm4', value: camera.matrixWorld},
				//modelViewProjectionMatrixInverse: {type: 'm4', value: camera.projectionMatrix.clone().multiply(camera.modelViewMatrix).invert()},
			}
		})
	);
	// groundPlane.rotation.x = -Math.PI / 2;
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
		webglRenderer.setSize(window.innerWidth, window.innerHeight, false);
		camera.updateProjectionMatrix();
		webglRenderer.getViewport(viewport);
		groundPlane.material.uniforms.viewport.value = viewport;
		render();
	}
	handleWindowResize();
	window.addEventListener('resize', handleWindowResize);

	window.requestAnimationFrame(function callback(timestamp) {
		groundPlane.material.uniforms.time.value = (timestamp / 5000) % 1;
		render();
		window.requestAnimationFrame(callback);
	});

	const orbitControls = new OrbitControls(camera, webglRenderer.domElement);
	orbitControls.addEventListener('change', () => {
		camera.updateMatrixWorld();
		groundPlane.material.uniforms.viewMatrixInverse.value = camera.matrixWorld;
		//groundPlane.material.uniforms.modelViewProjectionMatrixInverse.value = camera.projectionMatrix.clone().multiply(camera.modelViewMatrix).invert();
		render();
	});
}
