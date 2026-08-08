// Plane Text: output quality metrics (spec 11.7, "a bench harness").
//
// Every ratio in the spec is an estimate. This module exists so they can be
// replaced by measurements, and so that "which codec looks better" stops being
// settled by argument.
//
// THE COMPARISON HAS TO BE AT EQUAL DISPLAYED SIZE. Braille at 150 columns is
// 300x400 dots and ramp at 106 columns is 106x141 cells; comparing those in
// their own units measures nothing, because the phone shows both at the same
// physical width. So every codec is reconstructed to a common canvas at the
// width it will actually occupy, and compared there.
//
// This is the honest test the spec admits nobody has run: "a phone can't
// display 1200x900 either, so the honest test is at equal displayed size".

import { CODEC, CELL_DOTS } from './constants.js';
import { downscale } from './tone.js';

// ---------------------------------------------------------------------------
// Reconstruct what the recipient sees, as source-luminance in 0..1.
//
// Polarity has to be undone here or every measurement comes out inverted. The
// encoder flips before quantisation (a dot marks a bright source pixel on a
// dark ground), so the reconstruction has to flip back to compare against the
// original photo.
// ---------------------------------------------------------------------------
// `coverage` is the measured ink coverage of each ramp glyph, 0..1. Without it
// the reconstruction assumes index i means coverage i/(n-1), which is the
// assumption the encoder makes and the assumption calibration exists to make
// true. Passing the real table turns a ramp score from an upper bound into a
// measurement.
export function reconstruct(grid, invert = true, coverage = null) {
  const { codec, cols, rows, values, ramp } = grid;
  const cell = CELL_DOTS[codec];
  const w = cols * cell.w;
  const h = rows * cell.h;
  const out = new Float64Array(w * h);

  if (codec === CODEC.RAMP) {
    const n = ramp.length - 1;
    for (let i = 0; i < values.length; i++) {
      // values[i] = round((1 - postInvertLuma) * n): what the encoder meant.
      // What the reader sees is the glyph's real coverage, which is only the
      // same thing on a calibrated ramp.
      const shown = coverage ? coverage[values[i]] : values[i] / n;
      const post = 1 - shown;
      out[i] = invert ? 1 - post : post;
    }
    return { data: out, w, h };
  }

  // Cell codecs: one bit per dot. Bit layout differs, so read it back through
  // the same tables the serialiser uses rather than assuming raster order.
  const bit = codec === CODEC.BRAILLE
    ? [[0, 3], [1, 4], [2, 5], [6, 7]]
    : [[0, 1], [2, 3]];

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const v = values[cy * cols + cx];
      for (let dy = 0; dy < cell.h; dy++) {
        for (let dx = 0; dx < cell.w; dx++) {
          const ink = (v >> bit[dy][dx]) & 1;
          const post = 1 - ink;
          out[(cy * cell.h + dy) * w + (cx * cell.w + dx)] = invert ? 1 - post : post;
        }
      }
    }
  }
  return { data: out, w, h };
}

// Resample to the width the art actually occupies on the phone. Area-average on
// the way down, bilinear on the way up. A ramp cell is a large flat patch, and
// nearest-neighbour would flatter it by making its edges look crisp when the
// display will not.
export function toDisplay(img, targetW, targetH) {
  if (img.w >= targetW) return { data: downscale(img.data, img.w, img.h, targetW, targetH), w: targetW, h: targetH };
  const out = new Float64Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    const sy = ((y + 0.5) * img.h) / targetH - 0.5;
    const y0 = Math.max(0, Math.min(img.h - 1, Math.floor(sy)));
    const y1 = Math.min(img.h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < targetW; x++) {
      const sx = ((x + 0.5) * img.w) / targetW - 0.5;
      const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(sx)));
      const x1 = Math.min(img.w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const a = img.data[y0 * img.w + x0] * (1 - fx) + img.data[y0 * img.w + x1] * fx;
      const b = img.data[y1 * img.w + x0] * (1 - fx) + img.data[y1 * img.w + x1] * fx;
      out[y * targetW + x] = a * (1 - fy) + b * fy;
    }
  }
  return { data: out, w: targetW, h: targetH };
}

// ---------------------------------------------------------------------------
// Viewing blur. This is the load-bearing modelling choice in the harness, so it
// is stated here rather than buried in a constant.
//
// Comparing a halftone against a continuous-tone reference pixel-for-pixel
// always says the halftone is terrible. The first run of this bench scored
// braille at SSIM 0.10 against ramp's 0.77, which measures nothing: it is the
// metric noticing that braille is made of dots. Every pixel-wise metric does
// this to halftones. The standard correction is to low-pass both images first,
// modelling the fact that the eye does not resolve individual dots at arm's
// length.
//
// So: blur both, then score. The blur radius is not a free parameter to be
// tuned until the answer is nice, it is a physical quantity. At ~30cm, one
// arcminute of visual acuity subtends about 0.087mm; a modern phone pixel is
// around 0.055mm, and at DPR 3 that makes one CSS pixel about 0.165mm. So the
// eye integrates roughly half a CSS pixel, and sigma in the 0.5-1.0 range is
// the defensible band.
//
// The interesting output is not one number, it is the crossover. Braille
// carries more information at higher spatial frequency; ramp carries fewer,
// larger, more accurate samples. So ramp must win at low blur and braille must
// win at high blur, and the question is whether the crossover falls inside or
// outside the physically plausible band. That is the "equal displayed size"
// comparison the spec admits nobody has run.
// ---------------------------------------------------------------------------
export function gaussianBlur(img, sigma) {
  if (sigma <= 0) return img;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const { data, w, h } = img;
  const tmp = new Float64Array(data.length);
  const out = new Float64Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, ws = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= w) continue;
        s += data[y * w + xx] * k[i + r]; ws += k[i + r];
      }
      tmp[y * w + x] = s / ws;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, ws = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x] * k[i + r]; ws += k[i + r];
      }
      out[y * w + x] = s / ws;
    }
  }
  return { data: out, w, h };
}

// ---------------------------------------------------------------------------
// SSIM, 8x8 windows, standard constants.
//
// Why SSIM and not RMSE for judging a tone curve: auto-levels changes the pixel
// values by design, so RMSE against the original punishes the tone curve for
// doing its job. SSIM separates into luminance, contrast and structure, and the
// structure term is invariant to linear changes in brightness and contrast. A
// curve that remaps levels while preserving structure scores well; one that
// crushes regions flat destroys structure and scores badly. Crushing is the
// failure the ink-coverage band was invented to catch on braille, and this is
// its general form.
// ---------------------------------------------------------------------------
export function ssim(a, b, w, h, win = 8) {
  const C1 = 0.01 * 0.01, C2 = 0.03 * 0.03, C3 = C2 / 2;
  let sS = 0, sL = 0, sC = 0, sStruct = 0, n = 0;
  for (let y = 0; y + win <= h; y += win) {
    for (let x = 0; x + win <= w; x += win) {
      let ma = 0, mb = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
        ma += a[(y + j) * w + x + i]; mb += b[(y + j) * w + x + i];
      }
      const N = win * win;
      ma /= N; mb /= N;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
        const da = a[(y + j) * w + x + i] - ma, db = b[(y + j) * w + x + i] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= N - 1; vb /= N - 1; cov /= N - 1;
      const sa = Math.sqrt(Math.max(0, va)), sb = Math.sqrt(Math.max(0, vb));
      const l = (2 * ma * mb + C1) / (ma * ma + mb * mb + C1);
      const c = (2 * sa * sb + C2) / (va + vb + C2);
      const s = (cov + C3) / (sa * sb + C3);
      sL += l; sC += c; sStruct += s; sS += l * c * s; n++;
    }
  }
  return n
    ? { ssim: sS / n, luminance: sL / n, contrast: sC / n, structure: sStruct / n }
    : { ssim: 0, luminance: 0, contrast: 0, structure: 0 };
}

export function rmse(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}

// ---------------------------------------------------------------------------
// Ramp health: the metric the default codec never had.
//
// Ink coverage answers the right question for a 1-bit halftone: what fraction
// of dots carry ink, and is the curve crushing regions to flat white. Applied
// to a ramp it computes the mean glyph index instead, and the 30-60% band it is
// checked against was derived for dot coverage. Two ordinary photographs land
// at 30.7% and 59.1%, at opposite edges of a band that was never meant for
// them. The band means nothing here.
//
// The ramp's failure mode is different: it has N levels and the failure is not
// using them. So measure occupancy directly.
//   levels    how many glyphs carry a meaningful share
//   entropy   normalised 0..1. 1.0 means every level equally used
//   clipped   share sitting on the two end glyphs, where detail is lost
// ---------------------------------------------------------------------------
export function rampHealth(grid) {
  const n = grid.ramp.length;
  const hist = new Array(n).fill(0);
  for (const v of grid.values) hist[v]++;
  const total = grid.values.length;
  let entropy = 0, used = 0;
  for (const c of hist) {
    if (c / total > 0.005) used++;
    if (c > 0) { const p = c / total; entropy -= p * Math.log2(p); }
  }
  return {
    levels: used,
    levelsAvailable: n,
    entropy: entropy / Math.log2(n),
    clipped: (hist[0] + hist[n - 1]) / total,
    mean: grid.values.reduce((a, v) => a + v, 0) / total / (n - 1),
  };
}
