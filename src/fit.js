// Plane Text: fit a source image to the fixed capture aspect (spec 5.1).
//
// The viewfinder is 4:3 portrait and so is every output. This crops the source
// to match rather than letterboxing, because a letterboxed image spends the
// scarce resource, width, on empty bars.

import { CAPTURE_ASPECT } from './constants.js';

export function fitToAspect(rgba, w, h, aspect = CAPTURE_ASPECT, focusX = 0.5, focusY = 0.5) {
  const src = w / h;
  let cw, ch;
  if (src > aspect) {
    ch = h;
    cw = Math.round(h * aspect);
  } else {
    cw = w;
    ch = Math.round(w / aspect);
  }
  if (cw === w && ch === h) return { rgba, w, h, cropped: false };

  let x0 = Math.max(0, Math.min(w - cw, Math.round(focusX * w - cw / 2)));
  let y0 = Math.max(0, Math.min(h - ch, Math.round(focusY * h - ch / 2)));

  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const s = ((y0 + y) * w + x0) * 4;
    out.set(rgba.subarray(s, s + cw * 4), y * cw * 4);
  }
  return { rgba: out, w: cw, h: ch, cropped: true, from: { x0, y0 } };
}
