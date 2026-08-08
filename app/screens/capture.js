// Plane Text: capture.
//
// Style is chosen here, not in the composer (spec 5.1). This screen owns
// state.styleId and writes nothing else.
//
// ---------------------------------------------------------------------------
// THE VIEWFINDER IS LIVE AS OF 2026-08-09. What changed, and what did not.
//
// The pixels now come from app/camera.js instead of app/mock.js, and the art is
// drawn on a canvas through a glyph atlas instead of into a <pre>. Everything
// else on this screen is what it was: the style selector, the action bar, the
// shutter and its clamp, the word rotation, the readout, and the encode. The
// character and column counts still come from src/encode.js run on a real
// image, because the frame the viewfinder encodes IS a real image.
//
// Three decisions in that sentence are worth stating rather than leaving to be
// inferred from the code:
//
// 1. THE PREVIEW RUNS AT THE OUTPUT COLUMN COUNT. Spec 5.8 fixes it at 60x45;
//    SHELL.md item 10 says a 65-column grid cannot be framed with. The spec's
//    cap was a fillText limit described as a legibility one, and the atlas is
//    what removes it. WYSIWYG here covers size as well as style. The grid
//    coarsens only when frames are measured late, never by assumption.
//
// 2. THE CANVAS REPLACES THE <pre> ON THIS SCREEN ONLY. compose and paste keep
//    art.js and a real <pre>, because that is the render that proves what the
//    recipient's font will do -- the advance, the line-height, the shim. That
//    proof belongs where you decide whether to send. Here it is dead weight,
//    and spec 5.1 asks for a canvas in as many words. The two renderers can
//    disagree, but only across a navigation, and both take their geometry from
//    src/sizing.js, so the disagreement is bounded to glyph rasterisation.
//
// 3. THE STILL IS NOT THE PREVIEW FRAME. The shutter takes a fresh full-
//    resolution grab and lets it measure its own tone endpoints. The preview
//    approximates; the capture is correct (spec 5.8).
//
// ---------------------------------------------------------------------------
// STILL STUBBED: clipboardMayHavePayload(), below, and for a platform reason
// rather than an effort one.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { currentStyle, currentCols } from '../state.js';
import { styleList } from '../../src/styles.js';
import { actionBar } from '../actionbar.js';
import { autoFit, publishArtWidth } from '../art.js';
import { currentWord, advanceWord, messageName } from '../words.js';
import { openCamera, CameraError } from '../camera.js';
import { startViewfinder } from '../viewfinder.js';
import { clearAtlasCache } from '../atlas.js';
import { setSubject } from '../pipeline.js';

// Whether the clipboard is holding one of our messages, which is what puts the
// gold dot on OPEN.
//
// STUBBED, and honestly it may have to stay that way on one platform. Reading
// the clipboard without a user gesture needs the `clipboard-read` permission,
// which Chromium grants and WebKit does not implement. So the real version is:
// query the permission, read only if it is already granted, and on Safari
// return false forever. The dot is an enhancement -- OPEN is always tappable --
// which is why it is safe to ship as a constant until then.
function clipboardMayHavePayload() {
  return false;
}

// Per-visit resources that unmount() has to reach.
//
// The screen contract says per-visit state goes in closures inside mount(), and
// everything that can does. These two cannot: unmount() takes no arguments, and
// a MediaStream and a rAF loop are exactly the things it exists for -- a track
// has no `signal` option, and a camera left streaming behind a hidden screen
// holds the sensor and the recording indicator while nothing on screen reports
// it. One holder, written by mount, cleared by unmount.
let live = null;

export default register(defineScreen({
  id: 'capture',
  title: 'Capture',

  async mount(el, ctx) {
    const state = ctx.state;

    el.className = 'sc-capture';

    // --- style selector -------------------------------------------------
    // A segmented control with no box: words with a gold underline on the
    // active one. Style is an expressive choice and it is chosen first, so it
    // sits at the top where it is visible and out of the thumb's way.
    const styles = document.createElement('div');
    styles.className = 'sc-styles';
    styles.setAttribute('role', 'tablist');
    styles.setAttribute('aria-label', 'Style');

    const styleButtons = new Map();
    for (const style of styleList()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-style';
      b.setAttribute('role', 'tab');
      b.textContent = style.name.toUpperCase();
      b.title = style.description;
      b.addEventListener('click', () => state.set({ styleId: style.id }), { signal: ctx.signal });
      styleButtons.set(style.id, b);
      styles.append(b);
    }

    // --- viewfinder -----------------------------------------------------
    const stage = document.createElement('div');
    stage.className = 'sc-stage';
    const canvas = document.createElement('canvas');
    canvas.className = 'sc-art';
    // The art is a picture, not text to be read out cell by cell. Same
    // treatment the wrapper gives it, and the same reason a canvas gets a role
    // at all: without one it is an unlabelled graphic.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Live preview');
    stage.append(canvas);

    // Shown instead of the canvas when there is no camera to show.
    const notice = document.createElement('div');
    notice.className = 'sc-notice';
    notice.hidden = true;
    stage.append(notice);

    // --- readout --------------------------------------------------------
    // Secondary by construction (spec 5.2): the character count is information,
    // not a control, and there is no slider on this screen to act on it with.
    // It stays because it is the one number that tells you whether the message
    // is going to be enormous before you take it.
    const readout = document.createElement('p');
    readout.className = 'sc-readout';

    el.append(styles, stage, readout);

    // --- state ----------------------------------------------------------
    let word = currentWord();
    let camera = null;
    let vf = null;
    let cameraError = null;

    // Frame timings are a developer's number, not a user's, so they are behind
    // a route parameter: #/capture?perf=1. Spec 5.8's whole instruction about
    // WebGL is "measure before reaching for it", and this is what measuring
    // looks like on a real handset rather than in an argument.
    const showPerf = ctx.route.params.perf === '1';

    function showNotice(title, body) {
      canvas.hidden = true;
      notice.hidden = false;
      notice.textContent = '';
      const h = document.createElement('p');
      h.className = 'sc-notice-title';
      h.textContent = title;
      const p = document.createElement('p');
      p.className = 'sc-notice-body';
      p.textContent = body;
      notice.append(h, p);
    }

    function render(stats) {
      const s = state.get();
      const style = currentStyle(s);

      for (const [id, b] of styleButtons) {
        const on = id === style.id;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
      }

      const result = stats && stats.result;
      const chars = result ? result.stats.messageChars : s.sizeChars;
      const cols = stats && stats.cols ? stats.cols : currentCols(s);

      let text = `${chars.toLocaleString()} chars · ${cols} cols`;
      // Only surface degradation once it has actually happened. A frame-rate
      // readout that is always on trains the user to ignore it.
      if (stats && stats.degraded) text += ` · ${stats.rungLabel}`;
      if (showPerf && stats) text += ` · ${stats.meanMs.toFixed(1)}ms @${stats.fps}`;
      readout.textContent = text;

      // The legibility cap warns and does not clamp (2026-08-09). Note this
      // fires at the top of the slider for both codecs by construction --
      // SHELL.md disagreement 3 -- so it must read as advice, never as an
      // error, or the app cries wolf at its own maximum.
      readout.classList.toggle('is-warn', Boolean(result && result.warnings.length));

      bar.hero.querySelector('.pt-hero-label').textContent = word;
    }

    // --- action bar -----------------------------------------------------
    // Leftmost leaves the screen. Capture is the root, so here that means OPEN,
    // which is a lateral move rather than a back. See actionbar.js.
    //
    // 24/76 is a floor, not a preference: at a 390px viewport it puts OPEN on
    // 48px, and anything above about 80/20 drops it under the tap minimum.
    // actionbar.js throws if it does.
    const bar = actionBar(ctx.bottomBar, [
      {
        label: 'OPEN',
        flex: 24,
        dot: clipboardMayHavePayload(),
        onTap: () => ctx.navigate('paste'),
      },
      {
        label: word,
        // The label is a sound, not an instruction, so it is not the
        // accessible name. A screen reader says "Capture".
        aria: 'Capture',
        flex: 76,
        hero: true,
        onTap: async () => {
          // No camera means no shot. The library is the way out and OPEN is
          // already offering it, so this does nothing rather than pretending.
          if (!camera || !camera.live) return;

          // The still, at full sensor resolution and uncropped. encode() on the
          // compose side does the aspect fit with a focus point and measures
          // this image's own tone endpoints -- NOT the preview's smoothed ones.
          // "The preview approximates; the capture is correct" (spec 5.8).
          const photo = camera.grabStill();
          if (!photo) return;

          // The clamp is the whole capture feedback -- there is no flash over
          // the frame and no shutter sound. Await it so the screen change lands
          // after the acknowledgement rather than on top of it.
          await bar.fire();

          setSubject({
            kind: 'mine',
            photo,
            word,
            takenAt: Date.now(),
            source: 'shot',
          });
          // The contract's own field, kept accurate for anyone who reads it.
          // The pixels are not in here on purpose; see pipeline.js.
          state.set({
            capture: { source: 'shot', width: photo.width, height: photo.height, takenAt: Date.now() },
          });
          // Rotate only after a capture is actually taken. The bar is promising
          // a word, and a promise that changes because you looked at it is not
          // one.
          word = advanceWord();
          ctx.navigate('compose');
        },
      },
    ], { signal: ctx.signal });

    // --- the camera -----------------------------------------------------
    try {
      camera = await openCamera({ host: el });
    } catch (err) {
      cameraError = err instanceof CameraError ? err : new CameraError('failed', String(err));
    }

    // The router honours a navigation that happened during the await and
    // discards the late mount -- but it cannot know about a camera we opened in
    // the meantime, and that camera would stream forever behind a screen that
    // no longer exists.
    if (ctx.signal.aborted) {
      if (camera) camera.stop();
      return;
    }

    if (cameraError) {
      // Spec 8: declining the camera is not a dead end. The library is the way
      // through and it is one tap away on the same screen, so this is a notice
      // rather than an error state with its own layout.
      const body = cameraError.code === 'denied'
        ? 'Open a photo from your library instead — the button below on the left.'
        : 'You can still open a photo from your library — the button below on the left.';
      showNotice(cameraError.message, body);
      render(null);
      publishArtWidth(stage.getBoundingClientRect().width);
    } else {
      vf = startViewfinder({
        camera,
        canvas,
        stage,
        store: state,
        signal: ctx.signal,
        onStats: (stats) => render(stats),
      });

      // Re-fit on rotate, on the URL bar collapsing, on a desktop window drag.
      // The loop already re-fits every frame, so this matters on the static
      // rung and on the very first paint, where it is the thing that publishes
      // the art width the chrome clamps itself to.
      autoFit(stage, () => {
        const shot = vf.refresh();
        if (shot) publishArtWidth(shot.cols * shot.atlas.cellW);
      }, { signal: ctx.signal });
    }

    live = { camera, vf };

    // Re-render whenever anything the encode depends on moves. sizeChars is
    // compose's field, but it is read here because the readout has to agree
    // with what compose will produce -- if they disagree the user learns the
    // number changes when they navigate, which reads as a bug.
    //
    // The loop picks all of these up on its next frame by itself; refresh() is
    // called so a style tap repaints on the tap rather than up to 80ms later,
    // and so the static rung updates at all.
    state.subscribe((_s, changed) => {
      if (changed.has('styleId') || changed.has('sizeChars') || changed.has('customCharsets') || changed.has('invert')) {
        if (vf) vf.refresh();
        render(vf ? { result: vf.latest && vf.latest.result, cols: vf.latest && vf.latest.cols } : null);
      }
    }, { signal: ctx.signal });

    render(null);
  },

  // The one thing ctx.signal cannot do.
  unmount() {
    if (!live) return;
    if (live.vf) live.vf.stop();
    if (live.camera) live.camera.stop();
    // Atlases are per font size, and the next visit will very likely mount at a
    // different one. Holding a few megabytes of canvas for a screen nobody is
    // looking at is the same class of leak as the stream itself.
    clearAtlasCache();
    live = null;
  },
}));
