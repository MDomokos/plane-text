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
// They differ in a third way as of the second pass on 2026-08-09, and it is the
// only one a user can see: on the front camera the PREVIEW is mirrored and the
// STILL is not, which is what every other camera app does. It flips the picture
// at the compose navigation. The full argument, the reversal it came from and
// the cost are at the `mirrored` const inside openCamera().
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
// WHY THE PREVIEW BUFFER IS SUPERSAMPLED, AND WHY IT WAS NOT AT FIRST.
//
// The first version of this file grabbed at exactly the dot resolution, on the
// reasoning that `encode()` would then run verbatim on a tiny buffer and the
// app would have one pipeline. It does have one pipeline. It did not have one
// COMPUTATION, and the difference was visible: the live feed crushed contrast
// against the still it was previewing.
//
// Two mechanisms, both from the same cause -- two steps of the tone chain are
// resolution-dependent, so running them on a pre-averaged buffer is not the
// same operation:
//
//   1. `unsharp` has a radius of ONE PIXEL. On a still that is sub-cell detail.
//      On a ramp preview, where the cell is 1x1 dots, one pixel IS one cell, so
//      a radius-1 unsharp becomes a whole-cell local-contrast boost, and its
//      overshoot pins cells at both ends of the ramp.
//   2. The still tone-maps and THEN averages, inside `buildGrid`'s downscale.
//      A dot-resolution preview averages and THEN tone-maps. Clip, gamma and
//      compress do not commute with averaging.
//
// Measured at 103 columns on the ramp codec, against the still as reference:
// cells pinned to the first or last glyph went 3.4% -> 6.4% (portrait) and
// 4.1% -> 8.9% (scene), and the darkest bucket was three to four times
// overpopulated. Braille barely moved, because its cell is 2x4 dots and it was
// therefore already supersampled -- which is exactly the shape of the fix.
//
// SUPERSAMPLE FACTOR: enough source samples that every cell has at least
// MIN_SAMPLES_PER_CELL along each axis. Ramp cells are 1x1 and need 2x.
// Braille (2x4) and quadrant (2x2) already qualify and pay nothing. At 2x the
// clipping returns to 3.6% / 4.0% against the still's 3.4% / 4.1%.
//
// Going past 2x tracks the still's exact cell values more closely -- 3.5% of
// cells differ at 4x against 9% at 2x -- but the clipping is already fixed at
// 2x, so that buys grid agreement rather than tone, at four times the pixels.
//
// A NOTE FOR WHOEVER TRUSTS THE HEALTH METRIC: `rampHealth`'s entropy went UP
// on the broken preview, 0.946 -> 0.967, while clipping doubled. Pushing mass
// into the end buckets flattens the histogram. Entropy and `clipped` disagree
// in sign here, and entropy alone would have called the broken preview the
// healthier of the two.
//
// ---------------------------------------------------------------------------
// WHY THE PREVIEW BUFFER IS STILL SIZED FROM THE DOT GRID.
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

// Source samples per cell edge, before `buildGrid` averages them down.
//
// Two is where the measured clipping returns to the still's. See the long note
// above; this is the number that fixes the contrast crush, and it is expressed
// per CELL rather than per dot because the cell is the unit whose interior
// detail `unsharp` needs in order to be the operation it is on a still.
export const MIN_SAMPLES_PER_CELL = 2;

// How much to supersample a codec's dot grid to reach that.
//
// Exported and pure so a test can pin it, and so the frame-budget arithmetic
// elsewhere can ask rather than assume. Ramp is 1x1 dots per cell and returns
// 2; braille (2x4) and quadrant (2x2) already clear the bar and return 1.
export function supersampleFor(codec) {
  const cell = CELL_DOTS[codec];
  if (!cell) throw new Error(`unknown codec ${codec}`);
  return Math.max(1, Math.ceil(MIN_SAMPLES_PER_CELL / Math.min(cell.w, cell.h)));
}

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

// ---------------------------------------------------------------------------
// IS A CAMERA GOING TO ARRIVE? Added 2026-08-09, on the owner's report: "when
// switching back to viewfinder mode from the gallery screen, the main screen is
// blank until the camera actually has an input."
//
// getUserMedia takes a few hundred milliseconds on a warm permission and longer
// after a flip, and for that whole time the capture screen holds a fresh blank
// canvas. It looks like the viewfinder is missing rather than starting. The fix
// is a placeholder, and the only question a placeholder has to answer is this
// one: is showing a viewfinder-like thing going to turn out to have been a lie.
//
// TWO SIGNALS, AND THE SYNCHRONOUS ONE IS THE IMPORTANT ONE.
//
// A permission query is a promise, and a placeholder that appears 30ms into a
// 300ms wait has covered nine tenths of nothing. So the primary signal is a flag
// this app sets itself the first time a camera opens: it is a fact we own, it
// reads synchronously, and it is true on every engine. The Permissions API is
// the second chance, for the case where the flag is missing but permission is
// genuinely granted -- cleared storage, or a private window.
//
// WHY NOT SHOW IT ALWAYS. On first run the browser's own permission dialog is
// up, and the screen behind it must not already be showing something that looks
// like a working camera: that is a claim about a decision the user has not made
// yet, and it stays up if they decline. Nothing has been granted, so nothing is
// promised.
const OPENED_KEY = 'planetext.camera.opened.v1';

// Set on the first successful open, and never cleared. It is a claim about the
// past -- a camera opened here once -- not about the present, so a user who
// later revokes permission in browser settings gets a placeholder for as long as
// getUserMedia takes to reject, and then the notice. That is the right failure:
// under a second of an honest guess, replaced by the truth.
function rememberOpened() {
  try { localStorage.setItem(OPENED_KEY, '1'); } catch { /* private mode; the guess is just weaker */ }
}

export function cameraOpenedBefore() {
  try { return localStorage.getItem(OPENED_KEY) === '1'; } catch { return false; }
}

// The second chance. Resolves false on any engine that does not implement the
// `camera` permission name -- Safari rejects, Firefox rejects -- which is the
// same shape as the clipboard check in pipeline.js and correct for the same
// reason: the placeholder is an enhancement, so a platform that cannot answer
// the question loses only the enhancement.
export async function cameraPermissionGranted() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return false;
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state === 'granted';
  } catch {
    return false;
  }
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
  //
  // This resolving on the timeout rather than on a frame is NOT a failure and
  // must not be treated as one. Re-acquiring the sensor immediately after
  // track.stop() on the same hardware -- which is exactly what the flip control
  // does -- routinely takes longer than the deadline, and the honest answer is
  // to hand back a camera that is not producing frames yet. Every grab below
  // returns null while videoWidth is 0, `live` reports false, and the
  // viewfinder's loop keeps ticking and paints the moment frames start. See the
  // null-frame note in viewfinder.js tick().
  await waitForFrame(video);

  // A camera has opened on this device, which is what the next visit's
  // placeholder decision is made from. Here rather than at the call site: this
  // is the line past which the open cannot fail, and a screen that forgot to
  // record it would leave the flag describing the wrong thing.
  rememberOpened();

  // ---------------------------------------------------------------------------
  // MIRRORING THE FRONT CAMERA: THE PREVIEW ONLY. 2026-08-09, SECOND PASS.
  //
  // Read off the track, not off the request. `facingMode: { ideal: ... }` is a
  // preference: a laptop with one webcam hands back that webcam whatever we
  // asked for, so the request is not evidence about which way the lens points.
  // getSettings().facingMode is the device's own answer. Where it is absent --
  // Firefox reports no facingMode on desktop -- fall back to what we asked for,
  // which is the only other thing anyone here knows. This is per-camera state
  // captured at open, never a module-level flag: openStill() below wears the
  // same interface for an imported library photo, and an imported photo has no
  // facing to mirror by.
  //
  // THIS FILE MIRRORED BOTH GRABS EARLIER TODAY. THAT IS REVERSED.
  //
  // The argument it was reversed from, stated fairly because it is not a silly
  // one: a stock camera app can mirror the preview and save the file unmirrored
  // because the preview is not the product, and here it is. This app's promise,
  // stated in capture.js's header, in tokens.css and in state.js, is WYSIWYG --
  // the viewfinder is a render of the artefact the shutter sends, at the output
  // column count, through the output codec. Mirroring one grab and not the
  // other therefore breaks the one property the whole screen is built around.
  // So both mirrored, and the accepted cost was that lettering in a selfie --
  // a sign, a book cover, a T-shirt -- read backwards in the message as well as
  // in the preview, where a stock app would have got it right.
  //
  // The repo owner overruled it: "Fix the screen and image mirroring to match
  // other camera apps." Stock behaviour wins, and it wins on the ground the
  // earlier argument never addressed -- a photograph of the world is evidence
  // about the world, and a camera that silently hands back a left-right
  // inversion of what its lens saw is wrong about the scene in a way no amount
  // of internal consistency repairs. Every other camera the user owns agrees.
  //
  // SO THE PREVIEW MIRRORS AND THE STILL DOES NOT, AND THAT COSTS SOMETHING.
  //
  // Committing a selfie now FLIPS THE PICTURE between the viewfinder and the
  // compose screen. There is no way to hide that and no attempt is made to:
  // compose renders the unmirrored still, so the art the user is asked to send
  // is a mirror image of the art they framed. On a face nobody will notice; on
  // anything with lettering or an asymmetric composition they will, and the
  // moment of surprise is the navigation, not the shutter. The same note is at
  // commit() in app/screens/capture.js, which is the code that hands the still
  // onward and the place someone hitting the surprise will look first.
  //
  // ONE PLACE DECIDES. Do not "fix" the flip with a second transform on the
  // compose side, on the canvas, or in the wrapper. Two transforms that have to
  // agree is the shape of every bug this file already carries a paragraph
  // about; if the decision is ever reversed again, it is reversed here, in the
  // pixel path, in `drawDown` -- which is also the only form that works at all,
  // since compose renders into a <pre> where a canvas transform does not exist.
  //
  // THE CROP. Re-checked now that only one path mirrors, because the claim
  // written here before was true of the code it described and is HALF WRONG
  // about this one.
  //
  // Still true: cropRect() below is centred on both axes, so on the preview
  // path mirroring the destination is the same image as mirroring the source
  // and then cropping. The mirror can therefore stay on the last draw of the
  // halving chain, which is where drawDown() puts it.
  //
  // No longer true: that encode()'s focus-point crop needs no thought. It runs
  // on the STILL, which is now unmirrored, while the preview a focus point
  // would be read off is mirrored -- so the two frames disagree about which way
  // round x runs, which they did not when both mirrored. Nothing in the app
  // passes a focus point today (it defaults to 0.5, which is its own mirror
  // image; only tools/crop.js and tools/bench.js pass anything else), so there
  // is nothing to correct yet. But the advice this comment used to give -- flip
  // it, focusX -> 1 - focusX, at the point the tap is taken -- was WRONG when
  // it was written, because a tap at x on a mirrored preview was at x in a
  // mirrored still and needed no flip at all. It is right now, for the opposite
  // reason. If tap-to-focus is ever built: `mirrored` above is the flag, the
  // flip belongs at the tap site in capture.js, and this paragraph is why.
  // ---------------------------------------------------------------------------
  const track = stream.getVideoTracks()[0];
  const reported = track && typeof track.getSettings === 'function'
    ? track.getSettings().facingMode
    : null;
  const mirrored = (reported || facingMode) === 'user';

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
    // The flip goes on the LAST draw only, and as of the reversal above this is
    // the ONLY mirrored draw in the file. Mirroring an intermediate of the
    // halving chain would mirror again on every subsequent step, so at two
    // halvings the frame would come out the right way round and the bug would
    // depend on the downscale ratio -- which is to say on the column count.
    //
    // setTransform rather than scale(), and inside a save/restore pair: these
    // canvases are kept warm across frames, so a relative transform would
    // accumulate and an unbalanced one would leak into the next grab at this
    // size. The absolute form is idempotent whatever state it finds.
    const out = canvasFor(dw, dh);
    out.ctx.save();
    if (mirrored) out.ctx.setTransform(-1, 0, 0, 1, dw, 0);
    out.ctx.drawImage(source, cx, cy, cw, ch, 0, 0, dw, dh);
    out.ctx.restore();
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
    // Exposed so the decision is inspectable rather than inferred from a
    // picture, and so a test can pin that openStill() answers false.
    //
    // It reports what the PREVIEW does. Since the reversal above the still is
    // never mirrored, so there is no second flag to report and no way for the
    // two to be asked about separately -- which is deliberate: one place
    // decides.
    get mirrored() { return mirrored; },

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

      // Supersample so the tone chain has sub-cell detail to work on, and so
      // the averaging happens inside buildGrid AFTER the tone chain, which is
      // the order the still uses. k is 1 for the cell codecs, so they grab
      // exactly what they did before.
      const k = supersampleFor(codec);
      const grabW = dotsW * k;
      const grabH = dotsH * k;

      const { sx, sy, sw, sh } = cropRect(CAPTURE_ASPECT);
      const out = drawDown(sx, sy, sw, sh, grabW, grabH);
      const img = out.ctx.getImageData(0, 0, grabW, grabH);

      return {
        rgba: img.data,
        width: grabW,
        height: grabH,
        rows,
        supersample: k,
        // The buffer's own ratio, so encode()'s fitToAspect is a no-op. Scaling
        // both axes by the same k leaves this identical to the dot grid's
        // ratio, which is what keeps rowsFor() recovering the same row count.
        aspect: grabW / grabH,
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
      // NOT MIRRORED, on purpose, whichever way the lens points. This is the
      // photograph, and a photograph is true to the lens; the mirror is the
      // viewfinder's, and the viewfinder's alone. See the reversal note above
      // for the argument and for what it costs at the compose navigation.
      //
      // No save/restore pair, because there is no transform here to balance.
      // These canvases are shared with drawDown() and kept warm across frames,
      // so the identity transform this draw relies on is not an assumption: it
      // is what drawDown()'s own restore() guarantees on the way out.
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

// ---------------------------------------------------------------------------
// A STILL, WEARING THE CAMERA'S INTERFACE. Added 2026-08-09 for §6e.
//
// The hole this fills: "style was chosen at capture" was false for an imported
// photo, because there was no capture. The file picker on `paste` dropped the
// user straight into `compose`, so a library import had no moment at which
// style could be chosen at all.
//
// The fix routes imports THROUGH capture: picking a file lands on a frozen
// capture screen showing the still, with the live style row and a shutter that
// reads [ USE ]. That keeps state.js's single-owner-per-field table intact --
// styleId still has exactly one writer.
//
// Rather than teach capture.js and viewfinder.js about a second kind of source,
// the still is given the camera's shape. openStill() returns the same object
// openCamera() does, minus the stream. The viewfinder cannot tell the
// difference and does not need to: it asks for a preview grab at a column
// count and gets one, at the same dot resolution, through the same
// supersampled downscale, cropped to the same aspect.
//
// The one honest difference is that grabStill() returns the ORIGINAL buffer
// rather than a fresh sensor read. There is no sensor. The still is already
// the still, and re-deriving it from a downscale would be a lossy round trip
// for no reason. paste.js has already limited the decode to MAX_SOURCE_PX, so
// this buffer is the full-resolution source as far as this app is concerned.
// ---------------------------------------------------------------------------
export function openStill(photo) {
  if (!photo || !photo.rgba || !photo.width || !photo.height) {
    throw new CameraError('failed', 'That photo could not be read.');
  }

  // One canvas, painted once. Every preview grab is a drawImage out of it, so
  // the source pixels are uploaded a single time however many style changes
  // and resizes follow.
  const source = makeCanvas(photo.width, photo.height);
  const sctx = source.getContext('2d', { willReadFrequently: true });
  // createImageData + set, rather than `new ImageData(buffer, w, h)`. The
  // constructor form needs the ImageData global, which is the newer API and the
  // one an environment is likeliest to lack, and this is the only place that
  // would need it. It also sidesteps the constructor's requirement that the
  // buffer be exactly a Uint8ClampedArray, which `photo.rgba` is only on one of
  // the two paths that produce it.
  const img = sctx.createImageData(photo.width, photo.height);
  img.data.set(photo.rgba);
  sctx.putImageData(img, 0, 0);

  const canvases = new Map();
  let stopped = false;

  function canvasFor(w, h) {
    const key = `${w}x${h}`;
    let entry = canvases.get(key);
    if (!entry) {
      const canvas = makeCanvas(w, h);
      entry = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
      canvases.set(key, entry);
    }
    return entry;
  }

  function cropRect(aspect) {
    const w = photo.width;
    const h = photo.height;
    if (w / h > aspect) {
      const cw = Math.round(h * aspect);
      return { sx: Math.round((w - cw) / 2), sy: 0, sw: cw, sh: h };
    }
    const ch = Math.round(w / aspect);
    return { sx: 0, sy: Math.round((h - ch) / 2), sw: w, sh: ch };
  }

  return {
    video: null,

    get width() { return photo.width; },
    get height() { return photo.height; },
    // Always live while mounted. There is no frame to wait for, which is why
    // the frozen sub-mode never shows the "waiting for the camera" path.
    get live() { return !stopped; },
    // Never. An imported photo has no facing, so there is nothing to mirror
    // BY, and mirroring it would silently flip a picture the user already has
    // the right way round on their phone. This is the reason the flag lives on
    // the camera object rather than being read from state.facing wherever a
    // grab happens: state.facing is whatever the last live open set, and it
    // survives into the import sub-mode, which does not open a camera at all.
    get mirrored() { return false; },

    // Deliberately no multi-step downscale. openCamera() steps down in halves
    // because a 1920px video frame to a 130px grid is a 15x reduction and one
    // drawImage at that ratio aliases badly on some GPUs. paste.js already caps
    // an imported photo at 1600px on the long edge, and the browser's own
    // resizeQuality:'high' did that reduction, so the remaining ratio here is
    // small enough for a single call.
    grabPreview(codec, cols) {
      if (stopped) return null;
      const cell = CELL_DOTS[codec];
      if (!cell) throw new Error(`unknown codec ${codec}`);

      const rows = rowsFor(cols, CAPTURE_ASPECT, 1, codec);
      const k = supersampleFor(codec);
      const grabW = cols * cell.w * k;
      const grabH = rows * cell.h * k;

      const { sx, sy, sw, sh } = cropRect(CAPTURE_ASPECT);
      const out = canvasFor(grabW, grabH);
      out.ctx.drawImage(source, sx, sy, sw, sh, 0, 0, grabW, grabH);
      const img = out.ctx.getImageData(0, 0, grabW, grabH);

      return {
        rgba: img.data,
        width: grabW,
        height: grabH,
        rows,
        supersample: k,
        aspect: grabW / grabH,
      };
    },

    // The original, uncropped, so encode() does the aspect fit with a focus
    // point exactly as it does for a shot frame.
    grabStill() {
      if (stopped) return null;
      return { rgba: photo.rgba, width: photo.width, height: photo.height };
    },

    stop() {
      if (stopped) return;
      stopped = true;
      canvases.clear();
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
