#!/usr/bin/env node
// Plane Text: measure real glyph ink coverage (spec 5.7, step 1-2).
//
//   node tools/glyph-coverage.js [--font PATH] [--length 11]
//
// Rasterises each candidate glyph and reads its mean alpha coverage, builds a
// coverage-even ramp from the result, and reports how wrong the uncalibrated
// one was.
//
// Shells out to Python/Pillow, the same escape hatch image.js uses, so the
// project keeps its no-npm-dependencies rule. In the browser the measurement
// comes from canvas; src/calibrate.js holds the part that is identical either
// way.
//
// THE FONT MATTERS AND IS NOT THE PHONE'S. DejaVu Sans Mono here stands in for
// whatever `font-family: monospace` resolves to on the recipient's device: SF
// Mono on iOS, Roboto Mono on Android, Consolas on Windows. So this produces a
// real calibration for one font and, more usefully, a real measurement of how
// uneven a conventional ramp is at all. The per-device version has to run on
// the device.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrateRamp, rampEvenness, SAFE_ALPHABET } from '../src/calibrate.js';
import { DEFAULT_RAMP } from '../src/constants.js';

const FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf',
  '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/SFNSMono.ttf',
];

const argv = process.argv.slice(2);
let fontPath = null, length = 11;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--font') fontPath = argv[++i];
  else if (argv[i] === '--length') length = +argv[++i];
}
fontPath = fontPath || FONTS.find((f) => existsSync(f));
if (!fontPath) {
  console.error('no monospace font found; pass --font PATH');
  process.exit(1);
}

// Rule 1: antialiasing on, read the alpha channel. A binary keying test
// destroys the only information this measurement exists to collect.
// Rule 2: centre by the glyph's own advance.
// Rule 3: pad above and below the baseline so descenders survive.
const PY = `
import sys, json
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype(sys.argv[1], 64)
glyphs = json.loads(sys.argv[2])
adv = font.getlength("M")
W, H = int(round(adv)), 64 * 2          # rule 3: generous vertical padding
out = {}
for g in glyphs:
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    try:
        gw = font.getlength(g)
    except Exception:
        gw = adv
    x = (W - gw) / 2.0                   # rule 2: centre by advance
    d.text((x, H / 2), g, fill=255, font=font, anchor="lm")
    px = img.load()
    total = 0
    for y in range(H):
        for xx in range(W):
            total += px[xx, y]           # rule 1: mean ALPHA, not a threshold
    out[g] = total / (255.0 * W * H)
print(json.dumps(out))
`;

const dir = mkdtempSync(join(tmpdir(), 'txcam-'));
const script = join(dir, 'cov.py');
writeFileSync(script, PY);

const wanted = Array.from(new Set([...SAFE_ALPHABET, ...DEFAULT_RAMP]));
const raw = execFileSync('python3', [script, fontPath, JSON.stringify(wanted)], {
  encoding: 'utf8', maxBuffer: 1 << 24,
});
const table = JSON.parse(raw);
const measure = (g) => (g in table ? table[g] : NaN);

// Normalise so the blank is 0 and the densest glyph is 1. Absolute alpha
// depends on the raster size; only the spacing matters.
const vals = Object.values(table);
const lo = Math.min(...vals), hi = Math.max(...vals);
const norm = (g) => (measure(g) - lo) / (hi - lo);

console.log(`\nfont: ${fontPath}`);
console.log(`candidates measured: ${wanted.length}\n`);

const before = rampEvenness(DEFAULT_RAMP, norm);
console.log('CURRENT RAMP  ' + JSON.stringify(DEFAULT_RAMP));
console.log('  glyph      coverage   assumed   error');
[...DEFAULT_RAMP].forEach((g, i) => {
  const assumed = i / (DEFAULT_RAMP.length - 1);
  const actual = before.coverage[i];
  const err = actual - assumed;
  const flag = Math.abs(err) > 0.1 ? '  <-- ' + (err > 0 ? 'too dark' : 'too light') : '';
  console.log(`  ${JSON.stringify(g).padEnd(9)}  ${actual.toFixed(3).padStart(8)}  ${assumed.toFixed(3).padStart(8)}  ${(err >= 0 ? '+' : '') + err.toFixed(3)}${flag}`);
});
console.log(`  monotonic: ${before.monotonic}   worst error: ${(before.maxStepError * 100).toFixed(1)}% of the tonal range\n`);

const cal = calibrateRamp(norm, { length });
console.log(`CALIBRATED (${length} levels)  ` + JSON.stringify(cal.ramp));
console.log('  glyph      coverage   assumed   error');
[...cal.ramp].forEach((g, i) => {
  const assumed = i / (cal.ramp.length - 1);
  const actual = cal.coverage[i];
  console.log(`  ${JSON.stringify(g).padEnd(9)}  ${actual.toFixed(3).padStart(8)}  ${assumed.toFixed(3).padStart(8)}  ${((actual - assumed) >= 0 ? '+' : '') + (actual - assumed).toFixed(3)}`);
});
console.log(`  worst error: ${(cal.maxStepError * 100).toFixed(1)}% of the tonal range`);
console.log(`  improvement: ${(before.maxStepError * 100).toFixed(1)}% -> ${(cal.maxStepError * 100).toFixed(1)}%\n`);
writeFileSync('out/glyph-coverage.json', JSON.stringify({
  font: fontPath,
  normalised: Object.fromEntries(wanted.map((g) => [g, norm(g)])),
  currentRamp: { ramp: DEFAULT_RAMP, coverage: before.coverage, monotonic: before.monotonic, maxStepError: before.maxStepError },
  calibrated: { ramp: cal.ramp, coverage: cal.coverage, maxStepError: cal.maxStepError },
}, null, 2));
console.log('  wrote out/glyph-coverage.json. bench.js will use it if present\n');
console.log('  This is one font. The recipient resolves `monospace` to something else,');
console.log('  so the shipped calibration has to run on the device, but the size of the');
console.log('  error is the point: it is the tone error the encoder currently assumes away.\n');
