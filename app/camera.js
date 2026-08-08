// Plane Text: the camera source (spec 5.8).
//
// This replaces app/mock.js as the origin of pixels. It hands back exactly what
// mock.js handed back -- `{ rgba, width, height }` -- so nothing downstream of
// `encode()` knows or cares which one produced the frame. That was the whole
// point of making the stub a photo source rather than an ASCII generator.
//
// ---------------------------------------------------------------------------
// TWO GRABS, AND THEY ARE DELIBERATELY DIFFERENT.
//
//   grabPreview()  downscales to the DOT resolution of the target grid, crops
//                  to the capture aspect in the same drawImage call, and hands
//                  back a buffer of a few tens of thousands of pixels.
//   grabStill()    grabs the full sensor frame, uncropped, and lets encode()
//                  do the aspect fit with a real focus point.
//
// The preview approximates; the capture is correct. Spec 5.8 says so about the
// tone endpoints and the same reasoning applies to resolution: a preview exists
// to communicate framing, and a still exists to be sent.
//
// ---------------------------------------------------------------------------
// WHY THE PREVIEW DOWNSCALES WITH drawImage AND NOT A CELL LOOP.
//
// VectorCamera averages each cell with `inputPixelsPerCol = width / cols`,
// integer division, remainder discarded (teardown 5.3). At 108 columns on a
// 1920px source that is 1920/108 = 17, and 108 x 17 = 1836: eighty-four pixels,
// 4.4% of the frame, sheared off the right edge, and the same again off the
// bottom. It reads as a crop, so nobody notices. The cells are also unevenly
// spaced across the source.
//
// `drawImage` with an explicit source rectangle is one call, no loop, correct
// fractional coverage, and hardware area-averaging. It is strictly better than
// the loop it replaces.
//
// ---------------------------------------------------------------------------
// WHY THE PREVIEW BUFFER IS ALREADY DOT-SIZED.
//
// It means `encode()` runs on it verbatim -- the real tone chain, the real
// codec, the real wrapper -- rather than the viewfinder growing a private
// pipeline beside it. README.md documents five instances of a harness drifting
// from the artefact it tests. A second tone chain for the preview would have
// been the sixth, and it would have been the one the user actually looks at.
//
// The size arithmetic is the only subtle part. `encode()` calls
// `rowsFor(cols, srcW, srcH, codec)`, so feeding it a `cols*cell.w` by
// `rows*cell.h` buffer makes it recover exactly the `rows` we sized for:
//
//   rowsFor = round(cols * (dotsH/dotsW) * (cell.w/cell.h))
//           = round(cols * (rows*cell.h)/(cols*cell.w) * cell.w/cell.h)
//           = rows
//
// and `downscale()` inside `buildGrid` then becomes a 1:1 copy.

import { CELL_DOTS, CAPTURE_ASPECT } from '../src/constants.js';
import { rowsFor } from '../src/sizing.js';

// What the camera is asked for. Ideal, not exact: a phone that cannot do this
// gives us what it has, and every path here reads the real dimensions back off
// the video element rather than assuming these landed.
const IDEAL_WIDTH = 1920;
const IDEAL_HEIGHT = 1440;

// Above this downscale ratio, halve in steps rather than in one draw.
//
// A single 7x reduction is where canvas downscaling stops being trustworthy:
// some engines sample bilinearly from the nearest mip level rather than
// area-averaging the full footprint, and the result aliases -- which on a
// halftone shows up as moire in exactly the fine detail the codec is spending
// its resolution on. Two or three halvings cost two or three GPU blits of a
// shrinking image, which is nothing, and the last step lands on the odd target
// size with a ratio under 2.
const MAX_STEP_RATIO = 4;

export class CameraError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

// Map the DOMException names getUserMedia actually throws onto something a
// screen can branch on. The distinction that matters to spec 8 is "the user
// said no", which is recoverable by going to the library, versus "there is no
// camera here", which is not recoverable at all and must not be presented as
// though retrying might help.
function classify(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new CameraError('denied', 'Camera permission was declined.');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return new CameraError('none', 'No camera is available on this device.');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return new CameraError('busy', 'The camera is in use by another app.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return new CameraError('unsupported', 'This browser cannot open a camera.');
  }
  return new CameraError('failed', (err && err.message) || 'The camera could not be started.');
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export async function openCamera({ facingMode = 'environment', host = null } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new CameraError('unsupported', 'This browser cannot open a camera.');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: IDEAL_WIDTH },
        height: { ideal: IDEAL_HEIGHT },
      },
    });
  } catch (err) {
    throw classify(err);
  }

  const video = document.createElement('video');
  video.playsInline = true;      // iOS goes fullscreen without it, over our UI
  video.muted = true;            // and refuses to autoplay without this
  video.autoplay = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  // iOS keeps a detached video element's frames stale, so it goes in the DOM.
  // Not display:none either, which has the same effect on some builds -- it is
  // present, sized, and invisible.
  video.style.cssText =
    'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
  (host || document.body).append(video);
  video.srcObject = stream;

  try {
    await video.play();
  } catch (err) {
    stopStream(stream, video);
    throw classify(err);
  }

  // A track can report 0x0 for a frame or two after play() resolves, and a
  // grab at 0x0 throws from drawImage rather than returning something a screen
  // can show. Wait for real dimensions, but not forever.
  await waitForFrame(video);

  // One canvas per distinct grab size, kept warm. `willReadFrequently` is what
  // keeps the buffer on the CPU side: without it every getImageData is a
  // GPU readback, which is the single most expensive thing this file can do at
  // twenty frames a second.
  const canvases = new Map();
  function canvasFor(w, h) {
    const key = `${w}x${h}`;
    let entry = canvases.get(key);
    if (!entry) {
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      entry = { canvas, ctx };
      canvases.set(key, entry);
    }
    return entry;
  }

  // Scratch canvases for the halving chain. Separate from the grab canvases
  // because these are GPU-side intermediates and must NOT be willReadFrequently.
  const steps = new Map();
  function stepFor(w, h) {
    const key = `${w}x${h}`;
    let entry = steps.get(key);
    if (!entry) {
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      entry = { canvas, ctx };
      steps.set(key, entry);
    }
    return entry;
  }

  let stopped = false;

  // Draw `src` region of the video down to dw x dh, halving where the ratio is
  // steep enough to alias.
  function drawDown(sx, sy, sw, sh, dw, dh) {
    let source = video;
    let cx = sx, cy = sy, cw = sw, ch = sh;
    while (cw / dw > MAX_STEP_RATIO && ch / dh > MAX_STEP_RATIO) {
      const nw = Math.max(dw, Math.round(cw / 2));
      const nh = Math.max(dh, Math.round(ch / 2));
      const step = stepFor(nw, nh);
      step.ctx.drawImage(source, cx, cy, cw, ch, 0, 0, nw, nh);
      source = step.canvas;
      cx = 0; cy = 0; cw = nw; ch = nh;
    }
    const out = canvasFor(dw, dh);
    out.ctx.drawImage(source, cx, cy, cw, ch, 0, 0, dw, dh);
    return out;
  }

  // The centred crop of the current frame at a given width/height ratio.
  function cropRect(aspect) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w / h > aspect) {
      const cw = Math.round(h * aspect);
      return { sx: Math.round((w - cw) / 2), sy: 0, sw: cw, sh: h };
    }
    const ch = Math.round(w / aspect);
    return { sx: 0, sy: Math.round((h - ch) / 2), sw: w, sh: ch };
  }

  return {
    video,

    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    get live() { return !stopped && video.videoWidth > 0; },

    // A frame at the dot resolution of a `cols`-wide grid in `codec`.
    //
    // Returns `aspect` alongside the pixels, and the caller must pass it to
    // `encode()`. dotsW/dotsH is within a rounding error of CAPTURE_ASPECT but
    // not equal to it, and the difference is the difference between
    // `fitToAspect` returning early and it slicing a row of dots off a buffer
    // that is already exactly one dot per dot. That slice would shift every
    // cell below it by a quarter of a cell -- a shear, silent, and of the
    // precise kind this project keeps finding after the fact.
    grabPreview(codec, cols) {
      if (stopped) return null;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;

      const cell = CELL_DOTS[codec];
      if (!cell) throw new Error(`unknown codec ${codec}`);

      // rowsFor wants source dimensions, and the source we are about to make is
      // the crop, so ask it about the crop's shape rather than the sensor's.
      const rows = rowsFor(cols, CAPTURE_ASPECT, 1, codec);
      const dotsW = cols * cell.w;
      const dotsH = rows * cell.h;

      const { sx, sy, sw, sh } = cropRect(CAPTURE_ASPECT);
      const out = drawDown(sx, sy, sw, sh, dotsW, dotsH);
      const img = out.ctx.getImageData(0, 0, dotsW, dotsH);

      return {
        rgba: img.data,
        width: dotsW,
        height: dotsH,
        rows,
        // Exactly the buffer's own ratio, so encode()'s fitToAspect is a no-op.
        aspect: dotsW / dotsH,
      };
    },

    // The full sensor frame, uncropped and unscaled.
    //
    // Uncropped on purpose: `encode()` crops with a focus point, and handing it
    // a pre-cropped buffer would silently take that control away. Unscaled
    // because this runs once per shutter press, where the cost does not matter
    // and the resolution does -- the still is the thing that gets sent.
    grabStill() {
      if (stopped) return null;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return null;
      const out = canvasFor(w, h);
      out.ctx.drawImage(video, 0, 0, w, h);
      const img = out.ctx.getImageData(0, 0, w, h);
      return { rgba: img.data, width: w, height: h };
    },

    // Called from unmount(), never from ctx.signal.
    //
    // A MediaStreamTrack has no `signal` option, which is the entire reason the
    // screen contract keeps unmount() around. A camera left streaming behind a
    // hidden screen holds the sensor, keeps the recording indicator lit, and
    // costs battery that nothing on screen reports.
    stop() {
      if (stopped) return;
      stopped = true;
      stopStream(stream, video);
      canvases.clear();
      steps.clear();
    },
  };
}

function stopStream(stream, video) {
  for (const track of stream.getTracks()) track.stop();
  try { video.pause(); } catch { /* already gone */ }
  video.srcObject = null;
  video.remove();
}

// Resolve once the video is actually producing frames.
//
// `requestVideoFrameCallback` is the honest signal and Safari 15.4+ and Chrome
// both have it. The polling fallback is for Firefox, where `loadeddata` fires
// before videoWidth is reliable on some builds. Both give up after a second
// rather than hanging the mount: a viewfinder that never appears is worse than
// one that appears with a black first frame.
function waitForFrame(video) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const deadline = setTimeout(finish, 1000);
    const ok = () => { clearTimeout(deadline); finish(); };

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(ok);
      return;
    }
    const poll = () => {
      if (done) return;
      if (video.videoWidth > 0 && video.readyState >= 2) { ok(); return; }
      requestAnimationFrame(poll);
    };
    poll();
  });
}
