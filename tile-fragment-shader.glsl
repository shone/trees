precision mediump float;
precision mediump int;

in vec2 uvw;
uniform float time;
uniform vec3 cameraPositionLocal;
uniform mat4 modelViewProjectionMatrixInverse;
uniform vec4 viewport;
uniform mediump sampler3D tileTextureSampler;

struct Ray {
	vec3 origin;
	vec3 dir; // assumed to be unit length
};

float rayPlaneIntersect(const Ray ray, vec3 p) {
	return -dot(ray.origin,p) / dot(ray.dir,p);
}

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

float pointBoxIntersect(vec3 p, vec3 boxSize) {
	// Adapted from https://stackoverflow.com/a/26697650
	vec3 s = step(boxSize, abs(p));
	return (1.-s.x) * (1.-s.y) * (1.-s.z);
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

vec4 renderTree(const Ray ray, const vec2 treePosition, const float treeHeightRatio) {
	float treeHeight = treeboxHeight * treeHeightRatio;

	// Canopy
	const float maxCanopyRadius = 2.;
	float canopyRadius = maxCanopyRadius * treeHeightRatio;
	vec3 canopyPosition = vec3(treePosition.xy, treeHeight - canopyRadius);
	if (raySphereIntersect(ray, canopyPosition, canopyRadius) > 0.) {
		return vec4(0., 1., 0., 1.); // sphere
		//sphere diffuse coloring
		//vec3 normal = sphereNormal(C, cameraPos + sphereIntersection * camDir);
	}

	// Trunk
	vec3 trunkTopPosition = vec3(treePosition.xy, treeHeight - canopyRadius);
	const float maxTrunkRadius = .4;
	float trunkRadius = maxTrunkRadius * treeHeightRatio;
	if (rayCylinderIntersect(ray, vec3(treePosition.xy, 0.), trunkTopPosition, trunkRadius).x != -1.) {
		return vec4(151./255., 90./255., 33./255., 1.);
	}

	return vec4(0.);
}

const int maxTextureSamples = 120;

vec4 renderTreesAlongLine(const Ray ray, vec2 start, vec2 end) {
	// Grid traversal algorythm adapted from https://gamedev.stackexchange.com/a/182143

	//Grid cells are 1.0 X 1.0.
	vec2 treeboxPosition = floor(start);
	vec2 diff = end - start;
	vec2 signStep = sign(diff);

	//Ray/Slope related maths.
	//Straight distance to the first vertical grid boundary.
	float xOffset = end.x > start.x ? (ceil(start.x) - start.x) : (start.x - floor(start.x));
	//Straight distance to the first horizontal grid boundary.
	float yOffset = end.y > start.y ? (ceil(start.y) - start.y) : (start.y - floor(start.y));
	//Angle of ray/slope.
	float angle = atan(-diff.y, diff.x);
	//NOTE: These can be divide by 0's, but JS just yields Infinity! :)
	//How far to move along the ray to cross the first vertical grid cell boundary.
	float tMaxX = xOffset / cos(angle);
	//How far to move along the ray to cross the first horizontal grid cell boundary.
	float tMaxY = yOffset / sin(angle);
	//How far to move along the ray to move horizontally 1 grid cell.
	float tDeltaX = 1. / cos(angle);
	//How far to move along the ray to move vertically 1 grid cell.
	float tDeltaY = 1. / sin(angle);

	//Travel one grid cell at a time.
	vec2 manhattanVec = abs(floor(end) - floor(start));
	float manhattanDistance = manhattanVec.x + manhattanVec.y;
	float maxT = min(manhattanDistance, float(maxTextureSamples));
	for (float t = 0.; t <= maxT; ++t) {
		vec2 treePosition = treeboxPosition + .5;
		vec3 texturePosition = vec3((treeboxPosition+.5).xy/treeRowsPerTile, time);
		float treeHeightRatio = texture(tileTextureSampler, texturePosition).r;

		vec4 treeColor = renderTree(ray, treePosition, treeHeightRatio);
		if (treeColor.a > 0.) {
			return treeColor;
		}

		//Only move in either X or Y coordinates, not both.
		if (abs(tMaxX) < abs(tMaxY)) {
			tMaxX += tDeltaX;
			treeboxPosition.x += signStep.x;
		} else {
			tMaxY += tDeltaY;
			treeboxPosition.y += signStep.y;
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

	vec3 tileDimensionsHalf = vec3(tileWidth/2., tileWidth/2., treeboxHeight/2.);
	BoxIntersect tileIntersect = rayBoxIntersect(Ray(cameraRay.origin - tileDimensionsHalf, cameraRay.dir), tileDimensionsHalf);
	vec3 tileIntersectNearPos = cameraRay.origin + (cameraRay.dir * tileIntersect.near);
	vec3 tileIntersectFarPos  = cameraRay.origin + (cameraRay.dir * tileIntersect.far);
	if (pointBoxIntersect(cameraRay.origin - tileDimensionsHalf, tileDimensionsHalf) > 0.) {
		tileIntersectNearPos = cameraRay.origin;
	}

	vec4 treeColor = renderTreesAlongLine(cameraRay, tileIntersectNearPos.xy, tileIntersectFarPos.xy);
	if (treeColor.a > 0.) {
		gl_FragColor = treeColor;
		return;
	}

	float groundPlaneIntersection = rayPlaneIntersect(cameraRay, vec3(0., 0., 1.));
	if (groundPlaneIntersection > 0.) {
		vec2 groundPlanePos = (cameraRay.origin + (cameraRay.dir * groundPlaneIntersection)).xy;
		// Debug display of tree coordinates
		vec2 fragPosInCell = mod(((groundPlanePos/tileWidth)+.5) * cellRowsPerTile, 1.);
		float intensity = max(abs(fragPosInCell.x - .5) / .5, abs(fragPosInCell.y - .5) / .5) > .95 ? 0. : .5;
		gl_FragColor = vec4(
			intensity,
			intensity,
			intensity,
			1.
		);
		return;
	}

	gl_FragColor = vec4(0.);
}
