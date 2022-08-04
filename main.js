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

loadTreeDataCsv(txt);

function loadTreeDataCsv(csvText) {
	const lines = csvText.split('\n');
	const fields = Object.fromEntries(lines[0].split(',').map((field, index) => [field, index]));
	const data = lines.slice(1).map(line => line.split(',').map(str => parseFloat(str))).filter(entry => !entry.some(n => isNaN(n)));

	let cellCount = 0; data.forEach(entry => cellCount = Math.max(cellCount, entry[fields.Cell]+1));

	let firstYear = null;
	let lastYear  = null;
	let heightMax = 0;

	const maxTreeDisplayHeight = 40;

	data.forEach(entry => {
		firstYear = Math.min(firstYear||entry[fields.Year], entry[fields.Year]);
		lastYear  = Math.max(lastYear ||entry[fields.Year], entry[fields.Year]);
		heightMax = Math.max(heightMax, entry[fields.Height])
	});

	const yearCount = lastYear - firstYear;

	const cellTreeCounts = new Uint8Array(cellCount * yearCount);
	data.forEach(entry => cellTreeCounts[(cellCount*(entry[fields.Year]-firstYear)) + entry[fields.Cell]]++);
	let maxTreesPerCell = 0;
	cellTreeCounts.forEach(count => maxTreesPerCell = Math.max(maxTreesPerCell, count));

	const cellRowsPerTile = Math.floor(Math.sqrt(cellCount));
	const cellsPerTile = cellRowsPerTile * cellRowsPerTile;
	const treeRowsPerCell = 6;
	const treesPerCell = treeRowsPerCell * treeRowsPerCell;
	const treeRowsPerTile = cellRowsPerTile * treeRowsPerCell;
	const tileTextureData = new Uint8Array(treeRowsPerTile * treeRowsPerTile * yearCount);
	console.log(`Tile texture size: ${tileTextureData.length/1024}kb`);

	const cellTreeIdMap = new Uint32Array(cellCount * treesPerCell);

	for (const entry of data) {
		const cell = entry[fields.Cell];
		if (cell >= cellsPerTile) {
			continue;
		}

		const treeIdHash = MurmurHash3('string');
		treeIdHash.hash(String(entry[fields.SLA]));
		treeIdHash.hash(String(entry[fields.Longevity]));
		treeIdHash.hash(String(entry[fields.Wooddens]));
		const treeId = treeIdHash.result();

		let treeIndexInCell = 0;
		for (let i=cell*treesPerCell; i<cell*(treesPerCell+1); i++) {
			if (cellTreeIdMap[i] === treeId || cellTreeIdMap[i] === 0) {
				treeIndexInCell = i - (cell*treesPerCell);
				if (cellTreeIdMap[i] === 0) {
					cellTreeIdMap[i] = treeId;
				}
				break;
			}
		}

		const shuffledTreeIndexInCell = (cell+treeIndexInCell) * 833 % treesPerCell;

		const x = (treeRowsPerCell*(cell%cellRowsPerTile)) + (shuffledTreeIndexInCell%treeRowsPerCell);
		const y = (treeRowsPerCell*Math.floor(cell/cellRowsPerTile)) + (Math.floor(shuffledTreeIndexInCell/treeRowsPerCell));
		const z = entry[fields.Year] - firstYear;
		const textureIndex = (treeRowsPerTile*treeRowsPerTile*z) + (treeRowsPerTile*y) + x;
		const heightRatio = entry[fields.Height] / heightMax;
		tileTextureData[textureIndex] = Math.round(255 * heightRatio);
	}

	const tileTexture = new THREE.Data3DTexture(
		tileTextureData,
		treeRowsPerTile,
		treeRowsPerTile,
		yearCount,
	);
	tileTexture.format = THREE.RedFormat;
	tileTexture.magFilter = THREE.LinearFilter;
	tileTexture.needsUpdate = true;

	const tileBoundingMesh = new THREE.Mesh(
		new THREE.BoxGeometry(10000, 10000, 40),
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
				uniform vec3 cameraPositionLocal;
				uniform mat4 modelViewProjectionMatrixInverse;
				uniform vec4 viewport;
				uniform mediump sampler3D tileTextureSampler;

				const float maxTreeDisplayHeight = ${maxTreeDisplayHeight.toFixed(1)};
				const float cellRowsPerTile = ${cellRowsPerTile.toFixed(1)};
				const float treeRowsPerCell = ${treeRowsPerCell.toFixed(1)};
				const float treeRowsPerTile = ${treeRowsPerTile.toFixed(1)};

				struct Ray {
					vec3 origin;
					vec3 dir; // assumed to be unit length
				};

				//return t of smaller hit point
				float raySphereIntersect(const Ray ray, const vec3 spherePosition, const float sphereRadius) {
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

				struct BoxIntersect {
					float near;
					float far;
				};
				BoxIntersect rayBoxIntersect(const Ray ray, vec3 boxSize) {
					// Adapted from https://iquilezles.org/articles/intersectors
					// https://www.shadertoy.com/view/ld23DV
					vec3 m = 1./ray.dir;
					vec3 n = m*ray.origin;
					vec3 k = abs(m)*boxSize;
					vec3 t1 = -n - k;
					vec3 t2 = -n + k;
					float tN = max(max(t1.x, t1.y), t1.z);
					float tF = min(min(t2.x, t2.y), t2.z);
					if (tN>tF || tF<0.) {
						return BoxIntersect(-1., -1.); // no intersection
					}
					return BoxIntersect(tN, tF);
				}

				vec4 rayCylinderIntersect(const Ray ray, in vec3 pa, in vec3 pb, float ra) {
					vec3 ca = pb-pa;
					vec3 oc = ray.origin-pa;
					float caca = dot(ca,ca);
					float card = dot(ca,ray.dir);
					float caoc = dot(ca,oc);
					float a = caca - card*card;
					float b = caca*dot( oc, ray.dir) - caoc*card;
					float c = caca*dot( oc, oc) - caoc*caoc - ra*ra*caca;
					float h = b*b - a*c;
					if( h<0.0 ) return vec4(-1.0); //no intersection
					h = sqrt(h);
					float t = (-b-h)/a;
					// body
					float y = caoc + t*card;
					if( y>0.0 && y<caca ) return vec4( t, (oc+t*ray.dir-ca*y/caca)/ra );
					// caps
					t = (((y<0.0)?0.0:caca) - caoc)/card;
					if( abs(b+a*t)<h ) return vec4( t, ca*sign(y)/caca );
					return vec4(-1.0); //no intersection
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

				vec4 renderTree(const Ray ray, vec3 texturePosition) {
					float treeHeightRatio = texture(tileTextureSampler, texturePosition).r;
					if (treeHeightRatio <= 0.) {
						return vec4(0.);
					}

					float sphereIntersection = -1.;
					vec4 cylinderIntersection = vec4(-1.);

					vec2 treeWorldPos = (texturePosition.xy-.5) * 10000.;
					float treeHeight = maxTreeDisplayHeight * treeHeightRatio;
					float maxSphereRadius = maxTreeDisplayHeight * .25;
					float sphereRadius = maxSphereRadius * treeHeightRatio;
					vec3 spherePosition = vec3(treeWorldPos.xy, treeHeight - sphereRadius);

					sphereIntersection = raySphereIntersect(ray, spherePosition, sphereRadius);

					cylinderIntersection = rayCylinderIntersect(ray, vec3(treeWorldPos.xy, 0.), vec3(treeWorldPos.xy, treeHeight - (sphereRadius*2.)), sphereRadius * .3);

					//final color
					if(sphereIntersection > 0.) {
						return vec4(0., 1., 0., 1.); // sphere
						//sphere diffuse coloring
						//vec3 normal = sphereNormal(C, cameraPos + sphereIntersection * camDir);
					} else if (cylinderIntersection.x != -1.) {
						return vec4(151./255., 90./255., 33./255., 1.);
					} else {
						return vec4(0.);
					}
				}

				const int maxTextureSamples = 20;

				vec4 renderTreesAlongTileTextureLine(const Ray ray, ivec2 p0, ivec2 p1) {
					// TODO: use this algorithm instead: https://gamedev.stackexchange.com/a/81332

					int dx = abs(p1.x - p0.x);
					int sx = p0.x < p1.x ? 1 : -1;
					int dy = -abs(p1.y - p0.y);
					int sy = p0.y < p1.y ? 1 : -1;
					int error = dx + dy;

					for (int i=0; i<maxTextureSamples; i++) {
						vec4 treeColor = renderTree(ray, vec3((vec2(p0)+.5)/treeRowsPerTile, time));
						if (treeColor.a > 0.) {
							return treeColor;
						}

						if (p0 == p1) {
							break;
						}
						int e2 = 2 * error;
						if (e2 >= dy) {
							if (p0.x == p1.x) {
								break;
							}
							error += dy;
							p0.x += sx;
						} else if (e2 <= dx) { // Use 'else' according to https://stackoverflow.com/a/12934943
							if (p0.y == p1.y) {
								break;
							}
							error += dx;
							p0.y += sy;
						}
					}

					return vec4(0.);
				}

				void main() {
					// gl_FragCoord is the position of the pixel being rendered in viewport coordinates.
					// Convert gl_FragCoord through the various coordinate systems to get it in world coordinates.
					vec4 fragCoordNdc = transformPointViewportToNdc(gl_FragCoord);
					vec4 fragCoordClip = fragCoordNdc / gl_FragCoord.w; // Perform perspective divide
					vec4 fragCoordWorld = modelViewProjectionMatrixInverse * fragCoordClip;

					Ray cameraRay = Ray(cameraPositionLocal, normalize(fragCoordWorld.xyz - cameraPositionLocal));

					BoxIntersect boxIntersect = rayBoxIntersect(Ray(cameraRay.origin - vec3(0.,0.,maxTreeDisplayHeight/2.), cameraRay.dir), vec3(10000., 10000., maxTreeDisplayHeight));
					if (boxIntersect.near == -1. && boxIntersect.far == -1.) {
						gl_FragColor = vec4(1., 1., 1., 1.);
						return;
					}

					vec3 boxIntersectNearPos = cameraRay.origin + (cameraRay.dir * boxIntersect.near) + vec3(0.,0.,maxTreeDisplayHeight/2.);
					vec3 boxIntersectFarPos  = cameraRay.origin + (cameraRay.dir * boxIntersect.far)  + vec3(0.,0.,maxTreeDisplayHeight/2.);

					vec2 texturePosNear = ((boxIntersectNearPos.xy/10000.)+.5) * (cellRowsPerTile*treeRowsPerCell);
					vec2 texturePosFar  = ((boxIntersectFarPos.xy /10000.)+.5) * (cellRowsPerTile*treeRowsPerCell);
					if (length(texturePosFar-texturePosNear) > float(maxTextureSamples)) {
						texturePosFar = texturePosNear + (normalize(texturePosFar-texturePosNear)*float(maxTextureSamples));
					}

					vec4 treeColor = renderTreesAlongTileTextureLine(
						cameraRay,
						ivec2(floor(texturePosNear)),
						ivec2(floor(texturePosFar))
					);
					if (treeColor.a > 0.) {
						gl_FragColor = treeColor;
					} else {
						// Debug display of tree coordinates
						vec2 fragPosInCell = mod(((boxIntersectFarPos.xy/10000.)+.5) * cellRowsPerTile, 1.);
						float intensity = max(abs(fragPosInCell.x - .5) / .5, abs(fragPosInCell.y - .5) / .5) > .95 ? 0. : .5;
						gl_FragColor = vec4(
							intensity,
							intensity,
							intensity,
							1.
						);
					}
				}
			`,
			uniforms: {
				tileTextureSampler: {type: 't', value: tileTexture},
				time: {type: 'f', value: 0},
				viewport: {type: 'v4', value: viewport},
				cameraPositionLocal: {type: 'v3', value: new THREE.Vector3()},
				modelViewProjectionMatrixInverse: {type: 'm4', value: new THREE.Matrix4()},
			}
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
