// Plane Text: tone mapping (spec 5.7).
//
// With resolution capped by the viewport, this module is doing more of the
// quality work than it used to. It is a pure function of pixel data: no DOM,
// no canvas, testable in Node.

// Rec.709 perceptual luminance. Not (r+g+b)/3: green carries most of the
// perceived brightness and averaging makes foliage and skin read wrong.
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// RGBA byte array -> Float64Array of 0..1 luminance.
export function toLuma(rgba, w, h) {
  const out = new Float64Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = luminance(rgba[p], rgba[p + 1], rgba[p + 2]) / 255;
  }
  return out;
}

// Percentile clip. The failure on flat images is not too many grey levels, it
// is that the histogram only occupies a third of the ramp, so redistribute
// rather than discard (spec: auto-levels, not posterization).
export function autoLevels(luma, lowPct = 2, highPct = 98) {
  const sorted = Float64Array.from(luma).sort();
  let lo = sorted[Math.floor((lowPct / 100) * (sorted.length - 1))];
  let hi = sorted[Math.floor((highPct / 100) * (sorted.length - 1))];

  // Degenerate percentiles. On sparse or strongly bimodal content (a line
  // drawing, a document scan, a silhouette) the clip percentiles can land on
  // the same value, because the interesting pixels are a small minority. A
  // 97%-white line drawing has its 4th and 96th percentile both at 1.0.
  //
  // The old code filled the buffer with 0.5 in that case, which SILENTLY
  // DELETED THE IMAGE. It destroyed the Test D geometry target and would do the
  // same to any real photograph with a similar histogram. Fall back to the true
  // range instead, and if even that is flat, pass the input through untouched
  // rather than inventing a value.
  if (hi - lo < 1e-6) {
    lo = sorted[0];
    hi = sorted[sorted.length - 1];
  }
  const span = hi - lo;
  const out = new Float64Array(luma.length);
  if (span < 1e-6) {
    out.set(luma);
    return out;
  }
  for (let i = 0; i < luma.length; i++) {
    out[i] = Math.min(1, Math.max(0, (luma[i] - lo) / span));
  }
  return out;
}

export function gamma(luma, g = 1.2) {
  const out = new Float64Array(luma.length);
  const inv = 1 / g;
  for (let i = 0; i < luma.length; i++) out[i] = Math.pow(luma[i], inv);
  return out;
}

// Unsharp mask before downscaling. Downscaling is a low-pass filter, so it
// removes exactly the high-frequency detail the eye uses to judge sharpness.
// At 108 columns the downscale is aggressive, so there is more to recover here
// than when the target was 200+ columns.
export function unsharp(luma, w, h, amount = 0.6, radius = 1) {
  const blur = boxBlur(luma, w, h, radius);
  const out = new Float64Array(luma.length);
  for (let i = 0; i < luma.length; i++) {
    out[i] = Math.min(1, Math.max(0, luma[i] + amount * (luma[i] - blur[i])));
  }
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        sum += src[y * w + xx];
        n++;
      }
      tmp[y * w + x] = sum / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        sum += tmp[yy * w + x];
        n++;
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

// Box-filter downscale to the dot grid. Area-averaging, not nearest-neighbour:
// nearest-neighbour at these ratios aliases badly and throws away most of the
// source.
export function downscale(luma, sw, sh, dw, dh) {
  const out = new Float64Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          sum += luma[yy * sw + xx];
          n++;
        }
      }
      out[y * dw + x] = n ? sum / n : 0;
    }
  }
  return out;
}

// Ordered (Bayer) dithering.
//
// Added 2026-08-08 after measuring against the VectorCamera reference. The
// reasoning that made Floyd-Steinberg the default assumed braille dots would be
// sub-pixel and average into grey. They are not: at 108 columns on a DPR-3
// phone a dot is ~5.4 device pixels and is crisply resolved. Error diffusion's
// aperiodic pattern therefore reads as grain, which is what makes our output
// look noisy next to a smooth 7-level ramp.
//
// An ordered matrix produces a regular screen instead, the same trick as
// newspaper halftone. It reads as texture rather than noise because the eye
// recognises it as a pattern. It also costs less compute and, unlike error
// diffusion, is not decorrelating, so it would compress if gzip ever returns.
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

export function orderedDither(luma, w, h, levels = 2) {
  const out = new Float64Array(luma.length);
  const step = 1 / (levels - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = (BAYER8[y & 7][x & 7] + 0.5) / 64 - 0.5;
      const v = luma[i] + t * step;
      out[i] = Math.min(1, Math.max(0, Math.round(v / step) * step));
    }
  }
  return out;
}

// Floyd-Steinberg error diffusion, in place on a copy.
// Zero character cost: a claim that was briefly untrue while gzip was in the
// pipeline and is true again now that it is not.
export function dither(luma, w, h, levels = 2) {
  const buf = Float64Array.from(luma);
  const step = 1 / (levels - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const q = Math.round(old / step) * step;
      buf[i] = q;
      const err = old - q;
      if (x + 1 < w) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) buf[i + w - 1] += (err * 3) / 16;
        buf[i + w] += (err * 5) / 16;
        if (x + 1 < w) buf[i + w + 1] += (err * 1) / 16;
      }
    }
  }
  return buf;
}
