// Plane Text: the live viewfinder loop (spec 5.8).
//
//   video -> drawImage to the dot grid -> encode() -> atlas blit -> canvas
//
// The middle step is the whole design. `encode()` is the real encoder, the real
// tone chain, the real codec -- not a preview-shaped copy of it. app/camera.js
// hands back a buffer that is already exactly one pixel per dot, so the
// downscale inside buildGrid becomes a 1:1 copy and the encoder costs what a
// few tens of thousands of pixels cost. There is one pipeline in this app and
// the viewfinder is looking through it.
//
// ---------------------------------------------------------------------------
// PREVIEW RESOLUTION EQUALS OUTPUT RESOLUTION. Decided 2026-08-09.
//
// Spec 5.8 fixes the preview at 60x45 and calls it a legibility cap. SHELL.md
// item 10 says that at 65 columns you cannot tell whether a face is in shot,
// which is the viewfinder's entire job. The spec's number is a fillText limit
// dressed as a legibility one, and the atlas is what removes it. So the preview
// runs at currentCols(), the same grid the shutter will send, and the grid is
// coarsened only under MEASURED load -- never by default, and never as a
// starting assumption. See the degradation ladder at the bottom.
//
// ---------------------------------------------------------------------------
// TEMPORAL SMOOTHING IS NOT OPTIONAL AND IT IS NOT OBVIOUS.
//
// Per-frame auto-levels flickers. As the subject moves, the 2nd and 98th
// percentiles shift, the mapping jumps, and the whole image pulses -- not in
// one region, everywhere at once, which reads as a fault in the app rather than
// as a property of the scene. Smooth the ENDPOINTS, not the pixels.
//
// The snap-to-current is the other half. An EMA over ten frames takes half a
// second to settle, so without a snap, pointing the camera somewhere new gives
// you half a second of a wrongly-exposed image. Above a 20% endpoint jump the
// scene has changed rather than moved, and averaging across the change is
// averaging two different scenes.

import { encode } from '../src/encode.js';
import { currentStyle, currentCols } from './state.js';
import { fitFontSize } from './art.js';
import { getAtlas, blitGrid, measureAdvance } from './atlas.js';
import { createGlyphRenderer } from './glyphgl.js';

// The EMA. Roughly a ten-frame window: fast enough that walking into shade
// tracks, slow enough that a hand passing the lens does not repaint the world.
const EMA = 0.1;

// Endpoint delta above which we stop averaging and jump. Expressed in luma
// units, on a 0..1 scale, so 0.2 is a fifth of the full range.
const SNAP_DELTA = 0.2;

// The frame budget, in ms, at each rung of the ladder. A frame is "late" when
// the work takes longer than this; the interval between frames is separate and
// comes from the rung's fps.
const LATE_FACTOR = 0.9;

// Consecutive late frames before stepping down. Thirty at 20fps is a second and
// a half of sustained overrun, which is long enough that a single slow frame --
// a GC pause, a style change, the OS deciding to do something else -- cannot
// trip it.
const LATE_LIMIT = 30;

// Consecutive comfortable frames before stepping back up. Deliberately much
// longer than the step-down count: oscillating between two rungs is more
// visible than sitting on the lower one, because every transition is a visible
// change in either frame rate or grid size.
const RECOVER_LIMIT = 150;

// The ladder. Spec 5.8's is 20fps -> 12fps -> 40x30 -> static; this inserts one
// rung before any of that, because the cheapest thing to give up is not frame
// rate or resolution but how often the tone endpoints are re-measured.
//
// measureLevels() sorts the whole luma buffer, which at 103 braille columns is
// a 64k-element sort every frame. The EMA makes measuring on a subset of frames
// safe -- the endpoints already move slowly by construction -- and the snap
// still fires on the frames where we do measure, so a scene change costs at
// worst three extra frames of the old exposure. That is a far better trade than
// halving the frame rate.
const LADDER = [
  { fps: 20, levelsEvery: 1, colScale: 1,    label: 'full' },
  { fps: 20, levelsEvery: 4, colScale: 1,    label: 'sampled levels' },
  { fps: 12, levelsEvery: 4, colScale: 1,    label: '12fps' },
  { fps: 12, levelsEvery: 8, colScale: 0.66, label: 'coarse' },
  { fps: 0,  levelsEvery: 1, colScale: 0.66, label: 'static' },
];

export function startViewfinder({
  camera,
  canvas,
  stage,
  store,
  signal,
  onStats = null,
}) {
  const css = getComputedStyle(document.documentElement);
  const font = css.getPropertyValue('--pt-mono').trim() || 'monospace';
  const ink = css.getPropertyValue('--pt-art-ink').trim() || '#fff';
  const bg = css.getPropertyValue('--pt-art-bg').trim() || '#000';

  let rung = 0;
  let lateRun = 0;
  let goodRun = 0;
  let frame = 0;
  let raf = 0;
  let busy = false;
  let stopped = false;
  let last = 0;
  let paused = false;

  // Frozen is not paused, and the two must not share a flag.
  //
  // `paused` is the platform's business: the tab went away, come back when it
  // returns. `frozen` is the caller's: this source is a still, so there is
  // nothing to loop over. Added 2026-08-09 with the import sub-mode, where
  // capture shows a picked photo through this same renderer.
  //
  // Sharing one flag would mean the visibilitychange handler un-freezing a
  // still every time the app came to the foreground, and a frozen viewfinder
  // quietly burning a 20fps encode loop on an image that cannot change.
  let frozen = false;

  // --- the drawing surface ------------------------------------------------
  //
  // WebGL where it exists, the 2D atlas blit where it does not. Measured, the
  // gap is not marginal: ~30ms of drawImage calls per frame at 65 columns on a
  // desktop against one draw call. See the header of glyphgl.js.
  //
  // A canvas can only ever have one kind of context, so these two cannot share
  // an element. That matters on context loss -- the GPU can take the context
  // away at any time, most often when the OS is under memory pressure, which on
  // a phone is exactly when someone is trying to take a photograph. Recovering
  // means putting a NEW canvas in the old one's place. Hence the indirection.
  //
  // ---------------------------------------------------------------------------
  // A CANVAS ELEMENT IS SINGLE-USE HERE, AND THAT IS NOT OPTIONAL. 2026-08-09.
  //
  // The caller must hand a FRESH element to every startViewfinder() call. It is
  // a hard requirement of the DOM rather than a preference of this file, and
  // ignoring it is what made the front/rear flip hang:
  //
  //   stop() calls renderer.dispose(), which ends with ext.loseContext() to
  //   hand the GPU back rather than wait for GC. getContext() is specified to
  //   return the SAME context object for an element that already has one, and a
  //   context lost that way is never restored, so a second startViewfinder() on
  //   the same element got a dead WebGL context; createGlyphRenderer() then
  //   failed to compile against it and returned null; useCanvas2d() ran; and
  //   getContext('2d') on an element that already holds a WebGL context returns
  //   NULL. `ctx2d.imageSmoothingEnabled = false` threw, synchronously, out of
  //   startViewfinder, out of the caller's await, leaving `vf` null with no
  //   loop and a canvas showing the last frame the dead context painted.
  //
  // Which is precisely the reported symptom: dead until you navigate away and
  // back, because a fresh mount builds a fresh <canvas>.
  //
  // capture.js now mounts a new element per source. The null-context branch
  // below stays as the net -- degrading to a 2D blit is survivable, throwing
  // out of the constructor is not -- and warns, because if it ever fires the
  // caller has broken the contract and the user is paying ~30ms a frame for it.
  // ---------------------------------------------------------------------------
  let surface = canvas;
  let renderer = null;
  let ctx2d = null;

  // The last CSS size written to the surface, so an unchanged frame writes
  // nothing. A style write on an element the next frame is about to read from
  // is what turns a cheap read into a full layout flush.
  //
  // Declared up here rather than beside the other per-frame state because
  // replaceSurface() has to clear it, and replaceSurface() runs during
  // construction on the fallback path -- a `let` further down the file would
  // still be in its temporal dead zone at that point.
  let cssW = '';
  let cssH = '';

  // Swap the drawing surface for a clone of itself: same class, same role, same
  // aria-label, same position in the stage, no context of any kind.
  function replaceSurface() {
    const replacement = surface.cloneNode(false);
    replacement.width = 0;
    replacement.height = 0;
    surface.replaceWith(replacement);
    surface = replacement;
    // The replacement carries none of the old element's inline size, and the
    // memo above exists to SKIP writing a size it believes is already there.
    // Without this the next frame writes nothing and the canvas lays out at its
    // attribute size instead of its CSS size -- a picture that is suddenly the
    // wrong scale, with no error anywhere.
    cssW = '';
    cssH = '';
  }

  function useCanvas2d() {
    renderer = null;
    ctx2d = surface.getContext('2d');
    if (!ctx2d) {
      // Only reachable when the element arrived here already carrying a WebGL
      // context. See the contract note above; this is the net, not the fix.
      console.warn('viewfinder: canvas already had a context, replacing it');
      replaceSurface();
      ctx2d = surface.getContext('2d');
    }
    // The blit is a 1:1 device-pixel copy. Smoothing would only ever cost time
    // here, and on a fractional DPR it would soften every glyph edge in the
    // atlas -- which is the coverage information rule 1 exists to preserve.
    ctx2d.imageSmoothingEnabled = false;
  }

  function onContextLost() {
    console.warn('viewfinder: WebGL context lost, falling back to canvas2d');
    replaceSurface();
    if (renderer) renderer.dispose();
    useCanvas2d();
    // The atlas is unchanged, but the new canvas has painted nothing yet, and
    // the rAF gate could be up to a frame away. Paint on the next tick rather
    // than synchronously: we are inside the GPU's own event handler here.
    if (!stopped) setTimeout(() => { if (!stopped) renderOnce(); }, 0);
  }

  renderer = createGlyphRenderer(surface, { ink, bg, onLost: onContextLost });
  if (!renderer) useCanvas2d();

  // The stage box, kept current by observation rather than measured per frame.
  let boxWidth = 0;
  let boxHeight = 0;
  const ro = new ResizeObserver((entries) => {
    const r = entries[entries.length - 1].contentRect;
    if (r.width > 0 && r.height > 0) {
      boxWidth = r.width;
      boxHeight = r.height;
    }
  });
  ro.observe(stage);

  // The smoothed endpoints, in post-unsharp luma space. Null until the first
  // measured frame, which is also the frame that renders unsmoothed -- there is
  // nothing to average against yet and inventing a starting value would put a
  // visible settle on every mount.
  let levels = null;

  // Frame timing, kept as a short ring so the readout shows something stable
  // rather than the last frame's noise.
  const times = new Float64Array(30);
  let timeIdx = 0;
  let timeCount = 0;

  // The most recent successful encode, so the shutter and the readout can read
  // real numbers rather than recomputing them.
  let latest = null;

  function meanFrameMs() {
    if (!timeCount) return 0;
    let sum = 0;
    for (let i = 0; i < timeCount; i++) sum += times[i];
    return sum / timeCount;
  }

  function step(next) {
    if (next === rung) return;
    rung = next;
    lateRun = 0;
    goodRun = 0;
    // Frame times from the previous rung say nothing about this one.
    timeCount = 0;
    timeIdx = 0;
  }

  function renderOnce() {
    const s = store.get();
    const style = currentStyle(s);
    const cfg = LADDER[rung];

    // The one place the preview column count is decided. currentCols() is the
    // app's only character-count-to-columns conversion; scaling its result is
    // the degradation, and at colScale 1 -- every rung but the last two -- the
    // preview grid IS the output grid.
    const cols = Math.max(8, Math.round(currentCols(s) * cfg.colScale));

    const grabbed = camera.grabPreview(style.codec, cols);
    if (!grabbed) return null;

    const measuring = levels === null || frame % cfg.levelsEvery === 0;

    let result;
    try {
      result = encode(grabbed.rgba, grabbed.width, grabbed.height, {
        codec: style.codec,
        cols,
        ...(style.ramp ? { ramp: style.ramp } : {}),
        invert: s.invert,
        // The buffer's own ratio, so fitToAspect returns early instead of
        // slicing a row of dots off a buffer that is already dot-exact.
        aspect: grabbed.aspect,
        // Render with the smoothed endpoints; measure this frame's own only
        // when the rung says to.
        ...(levels ? { levels } : {}),
        reportLevels: measuring,
        title: 'Preview',
      });
    } catch (err) {
      // A custom charset that fails its lint is the likely cause, and the user
      // needs the screen they would fix it from. One bad frame must not end the
      // loop -- an exception inside rAF is a viewfinder that goes black and
      // stays black.
      console.error('viewfinder: encode failed', err);
      return null;
    }

    // Feed the EMA.
    const raw = result.stats.rawLevels;
    if (raw) {
      if (!levels) {
        levels = { lo: raw.lo, hi: raw.hi };
      } else if (
        Math.abs(raw.lo - levels.lo) > SNAP_DELTA ||
        Math.abs(raw.hi - levels.hi) > SNAP_DELTA
      ) {
        // Scene change, not subject movement. Averaging across it would be
        // averaging two different scenes.
        levels = { lo: raw.lo, hi: raw.hi };
      } else {
        levels = {
          lo: levels.lo * (1 - EMA) + raw.lo * EMA,
          hi: levels.hi * (1 - EMA) + raw.hi * EMA,
        };
      }
    }

    // --- geometry -------------------------------------------------------
    const rows = result.stats.rows;
    // The box comes from the ResizeObserver, not from a measurement taken here.
    //
    // getBoundingClientRect() is a layout READ, and the previous frame ended by
    // WRITING styles -- the canvas size, the readout text. A read after a write
    // forces a synchronous style and layout flush, and doing that twenty times
    // a second is the classic layout-thrash shape. The observer already knows
    // the answer and knows it without flushing anything.
    const boxW = boxWidth || stage.clientWidth || 1;
    const boxH = boxHeight || stage.clientHeight || 1;

    // Measure the advance before choosing a font size, then build the atlas at
    // that size. The <pre> path cannot do this -- it sets a size and finds out
    // afterwards -- and it is why the CSS baseline exists at all. Here we can
    // measure, so the guess is not used.
    const advance = measureAdvance(style.codec, style.ramp, font);
    const fontSize = fitFontSize({ codec: style.codec, cols, rows }, boxW, boxH, advance);

    const dpr = window.devicePixelRatio || 1;
    const atlas = getAtlas({ codec: style.codec, ramp: style.ramp, fontSize, dpr, font, ink });

    const wantW = cols * atlas.dw;
    const wantH = rows * atlas.dh;

    let drawn = false;
    if (renderer && !renderer.lost) {
      // The GL path sizes its own drawing buffer: setting canvas.width from out
      // here would reset the viewport behind its back.
      drawn = renderer.draw(atlas, result.grid);
      if (!drawn) {
        // A codec whose atlas will not fit an 8-bit index texture. Not an
        // error, just outside what this renderer can address.
        onContextLost();
      }
    }
    if (!drawn) {
      if (surface.width !== wantW || surface.height !== wantH) {
        surface.width = wantW;
        surface.height = wantH;
        // Resizing a canvas resets its context state, so this has to be re-set
        // rather than set once at construction. A quiet source of soft output.
        ctx2d.imageSmoothingEnabled = false;
      }
      blitGrid(ctx2d, atlas, result.grid, { bg });
    }

    const wantCssW = `${cols * atlas.cellW}px`;
    const wantCssH = `${rows * atlas.cellH}px`;
    if (cssW !== wantCssW || cssH !== wantCssH) {
      surface.style.width = wantCssW;
      surface.style.height = wantCssH;
      cssW = wantCssW;
      cssH = wantCssH;
    }

    latest = { result, cols, rows, atlas, fontSize };
    return latest;
  }

  function tick(now) {
    raf = 0;
    if (stopped) return;
    schedule();

    const cfg = LADDER[rung];
    if (paused || frozen || cfg.fps === 0) return;
    if (busy) return;

    const interval = 1000 / cfg.fps;
    if (now - last < interval) return;
    last = now;

    busy = true;
    const t0 = performance.now();
    let painted = null;
    try {
      painted = renderOnce();
    } finally {
      busy = false;
    }
    const dt = performance.now() - t0;

    // A FRAME THAT PAINTED NOTHING IS NOT A FAST FRAME. Added 2026-08-09.
    //
    // renderOnce() returns null when grabPreview() had no pixels -- the sensor
    // is not producing yet -- or when encode() threw on a bad charset. Both
    // return in well under a millisecond, and the code below used to feed that
    // into the ring, the ladder and onStats as though it were a rendered frame.
    //
    // This is the flip's window. Re-acquiring the camera after track.stop() on
    // the same hardware can go a few hundred milliseconds with videoWidth at 0,
    // which at 20fps is a run of empty frames long enough to move goodRun a
    // fifth of the way to RECOVER_LIMIT and to drag meanFrameMs toward zero --
    // the ladder climbing on evidence that does not exist, and the perf readout
    // reporting a frame time for frames that never happened.
    //
    // Returning here rather than stopping is the recovery: schedule() already
    // ran at the top of this tick, so the loop keeps turning at display rate
    // and the first frame the camera produces is rendered by the ordinary path.
    // The viewfinder needs no signal that the source came back, and there is
    // nothing for the flip to await -- which is why extending waitForFrame's
    // deadline in camera.js would have been the wrong fix.
    if (!painted) return;

    times[timeIdx] = dt;
    timeIdx = (timeIdx + 1) % times.length;
    if (timeCount < times.length) timeCount++;

    frame++;

    // --- the ladder -----------------------------------------------------
    // Measured, not assumed. Nothing steps down because of a device string, a
    // core count or a guess about what a phone can do; it steps down because
    // frames were late, here, on this hardware, on this scene.
    const budget = interval * LATE_FACTOR;
    if (dt > budget) {
      lateRun++;
      goodRun = 0;
      if (lateRun >= LATE_LIMIT && rung < LADDER.length - 1) step(rung + 1);
    } else {
      goodRun++;
      lateRun = 0;
      // Only climb back if there is real headroom, not merely an absence of
      // overrun: recovering into a rung we will immediately fall out of is the
      // oscillation RECOVER_LIMIT is guarding against.
      if (goodRun >= RECOVER_LIMIT && rung > 0 && dt < budget * 0.6) step(rung - 1);
    }

    if (onStats) {
      onStats({
        frameMs: dt,
        meanMs: meanFrameMs(),
        fps: cfg.fps,
        rung,
        rungLabel: cfg.label,
        degraded: rung > 0,
        backend: renderer ? renderer.backend : 'canvas2d',
        result: latest ? latest.result : null,
        cols: latest ? latest.cols : 0,
      });
    }
  }

  function schedule() {
    if (stopped || raf) return;
    raf = requestAnimationFrame(tick);
  }

  // A backgrounded tab stops firing rAF anyway, but a phone that locks with the
  // app open holds the camera. Releasing on hide and re-acquiring on show is
  // the difference between a warm pocket and a flat battery.
  const onVisibility = () => {
    paused = document.hidden;
    if (!paused) {
      // The scene is very likely different now.
      levels = null;
      last = 0;
      schedule();
    }
  };
  // Registered against this viewfinder's own lifetime, not the caller's.
  //
  // Both listeners used to take ctx.signal, which only aborts on unmount. A
  // screen that starts a second viewfinder without navigating -- the flip, and
  // the retry button in the failure notice -- therefore accumulated a
  // visibilitychange listener and an abort listener per attempt, every one of
  // them still pointing at a stopped instance. They were inert (schedule() and
  // tick() both return early once `stopped` is set) but they were also
  // unbounded, and "inert" is a property of the current early returns rather
  // than a guarantee. Chaining an owned controller off the caller's signal
  // keeps the unmount behaviour identical and makes stop() the one thing that
  // ends this instance, whoever called it.
  const own = new AbortController();
  document.addEventListener('visibilitychange', onVisibility, { signal: own.signal });
  if (signal) signal.addEventListener('abort', () => stop(), { signal: own.signal });

  function stop() {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro.disconnect();
    own.abort();
    // A browser caps live WebGL contexts per page at a low number, and it
    // evicts the oldest silently. Navigating to compose and back a few times
    // would otherwise cost us the context we are still using.
    if (renderer) { renderer.dispose(); renderer = null; }
  }

  schedule();

  return {
    stop,
    // Force a frame outside the rAF gate. This is what "tap to refresh" calls
    // on the static rung, and what a style change calls so the picture updates
    // on the tap rather than up to 80ms later.
    refresh() {
      if (stopped || busy) return latest;
      busy = true;
      try { return renderOnce(); } finally { busy = false; }
    },
    get latest() { return latest; },
    get backend() { return renderer ? renderer.backend : 'canvas2d'; },
    // The live canvas, which is NOT necessarily the one the caller passed in:
    // a lost GL context is recovered by putting a fresh element in its place.
    get canvas() { return surface; },
    // Stop looping. The caller drives with refresh() from here on.
    //
    // Used by capture's frozen sub-mode, where the source is a picked photo.
    // The loop would otherwise re-encode an unchanging image twenty times a
    // second and, worse, the degradation ladder would start stepping down on a
    // still -- reporting "coarse" about a picture that was never moving.
    freeze() { frozen = true; },
    get isStatic() { return frozen || LADDER[rung].fps === 0; },
    get rung() { return rung; },
    get rungLabel() { return LADDER[rung].label; },
    get meanFrameMs() { return meanFrameMs(); },
    // Dropping the smoothed endpoints. Called after a capture, because the
    // shutter path deliberately measures the still's own levels at full
    // resolution and the preview should not carry the old ones into the next
    // shot as though they were still true.
    resetLevels() { levels = null; },
  };
}
