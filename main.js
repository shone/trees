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
camera.position.set(0, 800, 1000);
camera.lookAt(0, 0, 0);

const progressEl = document.getElementById('progress');

const tileLoader = new Worker('tile-loader.js');
tileLoader.postMessage('trait_ind_ref_laegeren_rcp2p6_run1.txt');
tileLoader.onmessage = event => {
	if (event.data.task || event.data.progress) {
		progressEl.textContent = event.data.task;
		if (event.data.progress) {
			progressEl.textContent += ' ' + Math.round(event.data.progress * 100) + '%';
		}
	} else if (event.data.tileTextureData) {
		loadTileTexture(event.data);
		progressEl.remove();
	}
}

const tileFragmentShaderFetch = fetch('tile-fragment-shader.glsl').then(response => response.text());

async function loadTileTexture({cellRowsPerTile, treeRowsPerCell, treeRowsPerTile, yearCount, tileTextureData}) {
	const tileTexture = new THREE.Data3DTexture(
		tileTextureData,
		treeRowsPerTile,
		treeRowsPerTile,
		yearCount,
	);
	tileTexture.format = THREE.RedFormat;
	tileTexture.magFilter = THREE.LinearFilter;
	tileTexture.needsUpdate = true;

	const maxTreeDisplayHeight = 160;

	const tileBoundingMesh = new THREE.Mesh(
		new THREE.BoxGeometry(10000, 10000, maxTreeDisplayHeight),
		new THREE.ShaderMaterial({
			vertexShader: `
				out vec2 uvw;
				void main() {
					uvw = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1);
				}
			`,
			fragmentShader: `
				const float maxTreeDisplayHeight = ${maxTreeDisplayHeight.toFixed(1)};
				const float cellRowsPerTile = ${cellRowsPerTile.toFixed(1)};
				const float treeRowsPerCell = ${treeRowsPerCell.toFixed(1)};
				const float treeRowsPerTile = ${treeRowsPerTile.toFixed(1)};
			` + await tileFragmentShaderFetch,
			uniforms: {
				tileTextureSampler: {type: 't', value: tileTexture},
				time: {type: 'f', value: 0},
				viewport: {type: 'v4', value: viewport},
				cameraPositionLocal: {type: 'v3', value: new THREE.Vector3()},
				modelViewProjectionMatrixInverse: {type: 'm4', value: new THREE.Matrix4()},
			},
			side: THREE.BackSide,
		})
	);
	tileBoundingMesh.rotation.x = -Math.PI / 2;
	tileBoundingMesh.position.y = maxTreeDisplayHeight/2;
	tileBoundingMesh.updateMatrixWorld();
	scene.add(tileBoundingMesh);

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
		tileBoundingMesh.material.uniforms.modelViewProjectionMatrixInverse.value = tileBoundingMesh.matrixWorld.clone().invert().multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse);

		webglRenderer.setSize(window.innerWidth, window.innerHeight);
		webglRenderer.getViewport(viewport);
		tileBoundingMesh.material.uniforms.viewport.value = viewport;

		render();
	}
	handleWindowResize();
	window.addEventListener('resize', handleWindowResize);

	window.requestAnimationFrame(function callback(timestamp) {
		tileBoundingMesh.material.uniforms.time.value = (timestamp / 5000) % 1;
		render();
		window.requestAnimationFrame(callback);
	});

	const orbitControls = new OrbitControls(camera, webglRenderer.domElement);
	function oncamerachange() {
		camera.updateMatrixWorld();
		tileBoundingMesh.material.uniforms.cameraPositionLocal.value = camera.position.clone().applyMatrix4(tileBoundingMesh.matrixWorld.clone().invert());
		tileBoundingMesh.material.uniforms.modelViewProjectionMatrixInverse.value = tileBoundingMesh.matrixWorld.clone().invert().multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
		render();
	}
	oncamerachange();
	orbitControls.addEventListener('change', oncamerachange);
}
