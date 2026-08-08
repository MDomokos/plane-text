// Plane Text: the placeholder image source.
//
// This file is the stub. Step two deletes it.
//
// Everything else in app/ is real. The screens run this through src/encode.js:
// the real tone chain, codec and wrapper. Every character count, column count,
// warning and payload the UI shows is true. Only the origin of the pixels is
// fake.
//
// That is why this is a photo source rather than an ASCII generator. A mock
// that produced plausible-looking ASCII would let the UI display numbers no
// encoder ever produced, which is the failure this project keeps recording: a
// harness that drifts from the artefact it tests. Faking the input and running
// the real pipeline cannot drift, because there is only one pipeline.
//
// What replaces it, in three places:
//   capture  getUserMedia plus a frame grab into a canvas (spec 5.8)
//   library  <input type="file" accept="image/*"> plus createImageBitmap
//   paste    none of this; a pasted message is decoded, not encoded
//
// All three hand back what this does: RGBA plus dimensions. Nothing downstream
// of encode() knows which.

// A procedural scene, evaluated per pixel. Two subjects, because one is not
// enough to judge a tone curve on. The 2026-08-08 bench decision found the ramp
// had been accidentally tuned for a single photograph, and a single mock invites
// the same mistake in the UI.
//
// portrait  a face-ish blob: bright oval, two dark eye sockets, shadowed jaw.
//           Mid-tones everywhere, which is what the ramp is for.
// scene     a horizon: bright sky, a sun, dark foreground. A hard tonal split,
//           which is what exposes clipping and dithering.

function portrait(u, v) {
  let g = 0.5 - v * 0.55;
  g += 0.46 * Math.exp(-(u * u * 3.0 + (v + 0.1) * (v + 0.1) * 4.6) * 6.5);
  g -= 0.34 * Math.exp(-((u + 0.2) * (u + 0.2) * 110 + (v + 0.04) * (v + 0.04) * 190));
  g -= 0.34 * Math.exp(-((u - 0.2) * (u - 0.2) * 110 + (v + 0.04) * (v + 0.04) * 190));
  g += 0.10 * Math.exp(-(u * u * 180 + (v - 0.1) * (v - 0.1) * 140));
  g -= 0.18 * Math.exp(-(u * u * 46 + (v - 0.27) * (v - 0.27) * 150));
  g -= 0.20 * Math.exp(-((u + 0.34) * (u + 0.34) * 26 + (v + 0.3) * (v + 0.3) * 26));
  return g;
}

function scene(u, v) {
  if (v < 0.04) {
    let g = 0.9 + v * 0.5;
    g -= 0.32 * Math.exp(-((u - 0.22) * (u - 0.22) * 260 + (v + 0.28) * (v + 0.28) * 260));
    g -= 0.30 * Math.exp(-((u + 0.1) * (u + 0.1) * 70 + (v + 0.34) * (v + 0.34) * 400));
    return g;
  }
  let g = 0.44 - (v - 0.04) * 0.55;
  g += 0.22 * Math.exp(-((u + 0.28) * (u + 0.28) * 30 + (v - 0.14) * (v - 0.14) * 300));
  g -= 0.16 * Math.exp(-((u - 0.18) * (u - 0.18) * 40 + (v - 0.3) * (v - 0.3) * 160));
  return g;
}

const SUBJECTS = { portrait, scene };

// 480 x 640 is 3:4 already, so fitToAspect() has nothing to crop. That is a
// convenience for the mock and not an assumption the app may make: a real
// camera frame is 4:3 or 16:9 landscape and the crop carries weight.
export function mockPhoto({ width = 480, height = 640, subject = 'portrait', seed = 0 } = {}) {
  const fn = SUBJECTS[subject] || portrait;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = y / height - 0.5;
    for (let x = 0; x < width; x++) {
      const u = x / width - 0.5;
      // High-frequency texture. Without it the downscale produces perfectly
      // smooth gradients, dithering has nothing to do, and the result flatters
      // the codec in a way a photograph never would.
      const noise = 0.05 * Math.sin(x * 0.37 + y * 0.21 + seed) + 0.02 * Math.sin(x * 1.9 - y * 1.3);
      const g = Math.max(0, Math.min(1, fn(u, v) + noise));
      const b = Math.round(g * 255);
      const i = (y * width + x) * 4;
      rgba[i] = b; rgba[i + 1] = b; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return { rgba, width, height };
}

// A different subject each capture, so the prototype does not look like one
// frozen frame. Sequential for the same reason the word list is.
let n = 0;
export function nextMockPhoto() {
  const subject = n % 2 === 0 ? 'portrait' : 'scene';
  const photo = mockPhoto({ subject, seed: n });
  n++;
  return photo;
}
