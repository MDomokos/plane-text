// Plane Text: ramp calibration (spec 5.7, "calibrate the ramp to the font").
//
// The conventional ramp " .:-=+ox#%@" is not perceptually even. The coverage
// step from '.' to ':' is far smaller than from '#' to '@', so mid-tones
// compress and highlights stretch. The encoder assumes index i means coverage
// i/(n-1); wherever the real glyph does not deliver that, the picture has a
// tone error no amount of curve tuning can reach.
//
// This is the binding uncertainty in every number about the default codec. The
// bench can only report an upper bound on ramp quality until the ramp the
// encoder assumes and the ramp the font draws are the same thing.
//
// Measurement is injected. Coverage depends on the rendered font, which differs
// by platform: in the browser it comes from canvas, in Node from a rasteriser,
// and neither belongs in this module. What lives here is the part that is the
// same everywhere: the selection, the rules, and the checks.

import { BANNED_ALL, RAMP_BLANK } from './constants.js';

// The safe alphabet (spec 5.7). No WhatsApp markdown, no HTML-significant
// characters. The second group because escaped entities inside a <pre> break
// the one-character-per-cell correspondence, not because escaping is expensive.
export const SAFE_ALPHABET = [
  RAMP_BLANK,
  ...'.,:;-=+^!/|()[]{}?abcdefghijklmnopqrstuvwxyz',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%@$',
];

// Four construction rules, all learned from the VectorCamera teardown. They
// belong with the measurement, but they are asserted here so a bad measurer
// cannot silently produce a plausible-looking ramp:
//
//   1. Antialiasing ON, read the alpha channel. VectorCamera's blit is a binary
//      keying test, so no coverage information survives its pipeline at all.
//      A measurer that returns only 0 or 1 has made the same mistake.
//   2. Centre each glyph in its cell by its own advance, or wide glyphs bleed
//      into their neighbours.
//   3. Pad above and below the baseline, or every descender (g p y q ,) is
//      silently chopped.
//   4. Expect 2 and 3 to have shaped any hand-tuned ramp you are comparing
//      against. VectorCamera's shipped ramps are narrow, ascender-free glyphs
//      throughout, which looks like taste and is at least partly a bug.
//
// Rule 4 matters most: the corruption is silent. It shows up as a ramp that is
// not monotonic in coverage, at exactly the glyphs that made it long.

// Build a coverage-even ramp of `length` glyphs from measured candidates.
//
//   measure(glyph) -> 0..1 mean alpha coverage
//
// Returns { ramp, coverage, rejected, maxStepError }.
export function calibrateRamp(measure, {
  length = 11,
  alphabet = SAFE_ALPHABET,
  blank = RAMP_BLANK,
} = {}) {
  if (length < 2) throw new Error('a ramp needs at least two levels');

  const measured = [];
  const rejected = [];
  for (const g of alphabet) {
    if (BANNED_ALL.includes(g)) { rejected.push({ glyph: g, why: 'banned character' }); continue; }
    if (g === ' ') { rejected.push({ glyph: g, why: 'U+0020 is trimmed at line start' }); continue; }
    const c = measure(g);
    if (!Number.isFinite(c) || c < 0 || c > 1) { rejected.push({ glyph: g, why: 'unmeasurable' }); continue; }
    measured.push({ glyph: g, coverage: c });
  }
  if (measured.length < length) throw new Error(`only ${measured.length} glyphs measurable, need ${length}`);

  // A measurer that reports no intermediate coverage has antialiasing off, or
  // is thresholding. That is rule 1, and it produces a ramp that looks fine and
  // carries no tone.
  const distinct = new Set(measured.map((m) => m.coverage.toFixed(3))).size;
  if (distinct < Math.min(8, measured.length)) {
    throw new Error(
      `only ${distinct} distinct coverage values. The measurer is probably ` +
      `thresholding rather than reading alpha (spec 5.7 rule 1)`,
    );
  }

  measured.sort((a, b) => a.coverage - b.coverage);

  // The blank anchors the light end. It has to be the lightest thing in the
  // ramp or index 0 stops meaning "empty", and it must not be U+0020.
  const lightest = measured[0];
  if (lightest.glyph !== blank) {
    const b = measured.find((m) => m.glyph === blank);
    if (b) { measured.splice(measured.indexOf(b), 1); measured.unshift(b); }
  }

  // Select evenly spaced coverage, not evenly spaced indices. Picking every
  // k-th glyph from a coverage-sorted list is the same mistake as the
  // uncalibrated ramp, one level up.
  //
  // Dynamic programming, replacing a greedy nearest-target walk 2026-08-09.
  // Greedy is wrong whenever two targets want the same glyph: the first target
  // takes it, the second is pushed to a worse one, and the error compounds
  // along the ramp. It also had to sort afterwards, which is the tell: a
  // selection that can come out unordered is a selection that can come out
  // non-monotonic. Walking the coverage-sorted pool with strictly increasing
  // indices makes an inversion unreachable rather than merely unlikely.
  //
  // Cost is O(pool x length), nothing for 11 glyphs from ~90 candidates, and it
  // returns the exact minimiser of squared error to the ladder.
  const lo = measured[0].coverage;
  const hi = measured[measured.length - 1].coverage;
  const span = hi - lo || 1;
  const n = measured.length;
  const norm = (i) => (measured[i].coverage - lo) / span;

  const cost = Array.from({ length }, () => new Float64Array(n).fill(Infinity));
  const back = Array.from({ length }, () => new Int32Array(n).fill(-1));
  for (let j = 0; j < n; j++) {
    const e = norm(j) - 0;
    cost[0][j] = e * e;
  }
  for (let s = 1; s < length; s++) {
    const target = s / (length - 1);
    let best = Infinity, bestJ = -1;
    for (let j = 0; j < n; j++) {
      if (j > 0 && cost[s - 1][j - 1] < best) { best = cost[s - 1][j - 1]; bestJ = j - 1; }
      if (bestJ >= 0) {
        const e = norm(j) - target;
        cost[s][j] = best + e * e;
        back[s][j] = bestJ;
      }
    }
  }
  let endJ = -1, endCost = Infinity;
  for (let j = 0; j < n; j++) {
    if (cost[length - 1][j] < endCost) { endCost = cost[length - 1][j]; endJ = j; }
  }
  if (endJ < 0) throw new Error('no monotonic selection exists in this candidate pool');
  const idx = new Array(length);
  for (let s = length - 1, cur = endJ; s >= 0; s--) {
    idx[s] = cur;
    cur = back[s][cur];
    if (cur < 0 && s > 0) throw new Error('selection backtrack failed');
  }
  const picked = idx.map((j) => measured[j]);

  // How far the calibrated ramp still is from perfectly even. This is the
  // number the encoder's index-means-coverage assumption is wrong by, so it is
  // also the residual error the bench cannot see.
  let maxStepError = 0;
  for (let i = 0; i < picked.length; i++) {
    const assumed = i / (picked.length - 1);
    const actual = (picked[i].coverage - lo) / (hi - lo || 1);
    maxStepError = Math.max(maxStepError, Math.abs(assumed - actual));
  }

  // Usable levels: the number the redesign was for. Reordering removes
  // inversions at zero cost, so a ramp can be perfectly monotonic and still be
  // bad. The shipped Art ramp measured monotonic-after-reorder and delivered
  // only 7 distinguishable tones out of 11, because four glyph pairs sat within
  // 0.05 coverage of each other. Merge those and count what is left.
  let usableLevels = 1;
  for (let i = 1; i < picked.length; i++) {
    if ((picked[i].coverage - picked[i - 1].coverage) / span >= USABLE_STEP) usableLevels++;
  }

  return {
    ramp: picked.map((p) => p.glyph).join(''),
    coverage: picked.map((p) => p.coverage),
    rejected,
    maxStepError,
    usableLevels,
    candidates: measured.length,
  };
}

// Two glyphs closer than this in normalised coverage cannot produce
// distinguishable tones, so they occupy two ramp slots and deliver one.
export const USABLE_STEP = 0.05;

// How wrong is a ramp that was never calibrated? Same measurement, applied to
// the ramp we ship, so the cost of not doing this is a number rather than an
// argument.
export function rampEvenness(ramp, measure) {
  const cov = [...ramp].map((g) => measure(g));
  const lo = Math.min(...cov), hi = Math.max(...cov);
  const span = hi - lo || 1;
  let maxStepError = 0, monotonic = true;
  const inversions = [];
  const glyphs = [...ramp];
  for (let i = 0; i < cov.length; i++) {
    if (i && cov[i] < cov[i - 1]) {
      monotonic = false;
      inversions.push(`${glyphs[i - 1]}->${glyphs[i]}`);
    }
    maxStepError = Math.max(maxStepError, Math.abs(i / (cov.length - 1) - (cov[i] - lo) / span));
  }

  // Same measure as calibrateRamp, on a ramp nobody selected. This is the
  // number that condemned the DejaVu-calibrated Art ramp on a Pixel: monotonic
  // once reordered, and still only 7 usable levels of 11.
  const sorted = [...cov].sort((a, b) => a - b);
  let usableLevels = 1;
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] - sorted[i - 1]) / span >= USABLE_STEP) usableLevels++;
  }

  return { coverage: cov, maxStepError, monotonic, inversions, usableLevels };
}

// Fix the order of an existing ramp without changing its glyphs. The free half
// of the repair: it removes every inversion and cannot touch clustering, so a
// ramp that is short on usable levels stays short. Kept separate from
// calibrateRamp so the distinction is visible in the API rather than only in a
// comment. Confusing the two is what made "Art is calibrated" sound like a
// stronger claim than it was.
export function resortRamp(ramp, measure) {
  return [...ramp].sort((a, b) => measure(a) - measure(b)).join('');
}
