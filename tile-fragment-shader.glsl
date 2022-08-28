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

const int maxTextureSamples = 120;

vec4 renderTreesAlongTileTextureLine(const Ray ray, vec2 start, vec2 end) {
	// Grid traversal algorythm adapted from https://gamedev.stackexchange.com/a/182143

	//Grid cells are 1.0 X 1.0.
	vec2 texturePos = floor(start);
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
	float manhattanDistance = abs(floor(end.x) - floor(start.x)) + abs(floor(end.y) - floor(start.y));
	for (float t = 0.; t <= manhattanDistance; ++t) {
		vec4 treeColor = renderTree(ray, vec3((texturePos+.5)/treeRowsPerTile, time));
		if (treeColor.a > 0.) {
			return treeColor;
		}
		//Only move in either X or Y coordinates, not both.
		if (abs(tMaxX) < abs(tMaxY)) {
			tMaxX += tDeltaX;
			texturePos.x += signStep.x;
		} else {
			tMaxY += tDeltaY;
			texturePos.y += signStep.y;
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

	Ray cameraRay = Ray(cameraPositionLocal + vec3(0.,0.,maxTreeDisplayHeight/2.), normalize(fragCoordWorld.xyz - cameraPositionLocal));

	BoxIntersect boxIntersect = rayBoxIntersect(Ray(cameraRay.origin - vec3(0.,0.,maxTreeDisplayHeight/2.), cameraRay.dir), vec3(5000., 5000., maxTreeDisplayHeight/2.));
	if (boxIntersect.near == -1. && boxIntersect.far == -1.) {
		gl_FragColor = vec4(1., 1., 1., 1.);
		return;
	}

	vec3 boxIntersectNearPos = (cameraRay.origin + vec3(0.,0.,maxTreeDisplayHeight/2.)) + (cameraRay.dir * boxIntersect.near);
	vec3 boxIntersectFarPos  = (cameraRay.origin + vec3(0.,0.,maxTreeDisplayHeight/2.)) + (cameraRay.dir * boxIntersect.far);

	if (cameraRay.origin.z >= .0 && cameraRay.origin.z <= maxTreeDisplayHeight && abs(cameraRay.origin.x) < 5000. && abs(cameraRay.origin.y) < 5000.) {
		boxIntersectNearPos = cameraRay.origin;
	}

	vec2 texturePosNear = ((boxIntersectNearPos.xy/10000.)+.5) * (cellRowsPerTile*treeRowsPerCell);
	vec2 texturePosFar  = ((boxIntersectFarPos.xy /10000.)+.5) * (cellRowsPerTile*treeRowsPerCell);
	if (length(texturePosFar-texturePosNear) > float(maxTextureSamples)) {
		texturePosFar = texturePosNear + (normalize(texturePosFar-texturePosNear)*float(maxTextureSamples));
	}

	vec4 treeColor = renderTreesAlongTileTextureLine(cameraRay, texturePosNear, texturePosFar);
	if (treeColor.a > 0.) {
		gl_FragColor = treeColor;
		return;
	}

	float groundPlaneIntersection = rayPlaneIntersect(cameraRay, vec3(0., 0., 1.));
	if (groundPlaneIntersection > 0.) {
		vec2 groundPlanePos = (cameraRay.origin + (cameraRay.dir * groundPlaneIntersection)).xy;
		// Debug display of tree coordinates
		vec2 fragPosInCell = mod(((groundPlanePos/10000.)+.5) * cellRowsPerTile, 1.);
		float intensity = max(abs(fragPosInCell.x - .5) / .5, abs(fragPosInCell.y - .5) / .5) > .95 ? 0. : .5;
		gl_FragColor = vec4(
			intensity,
			intensity,
			intensity,
			1.
		);
		return;
	}

	gl_FragColor = vec4(95./255., 165./255., 1., 1.);
}
