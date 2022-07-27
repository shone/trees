'use strict';

function hsl2rgb(h,s,l) {
	const a = s*Math.min(l,1-l);
	const f = (n,k=(n+h/30)%12) => l - a*Math.max(Math.min(k-3,9-k,1),-1);
	return {r: f(0), g: f(8), b: f(4)};
}
