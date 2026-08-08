// Plane Text: capture.
//
// Style is chosen here, not in the composer (spec 5.1). This screen owns
// state.styleId and writes nothing else.
//
// What is real: the style selector, the action bar, the shutter and its clamp,
// the word rotation, the layout, and the encode. The character and column
// counts under the viewfinder come from src/encode.js run on an actual image.
//
// What is stubbed: where the pixels come from. app/mock.js hands back a
// procedural photograph, and the viewfinder shows one encoded still rather than
// a live feed. Replacing it is getUserMedia plus a frame grab into a canvas,
// and nothing else on this screen changes.
//
// The live viewfinder is the highest-risk piece in the app and it is not here.
// Spec 9 puts it last in the build order: it is the highest-risk performance
// work and steps 1-7 are a complete app without it. Everything on this screen
// assumes an encode at ~103 columns at a usable frame rate, and that is
// unmeasured. If it turns out not to hold, the fallback is not "no viewfinder",
// it is a lower preview column count than the send, and that is a decision
// rather than an optimisation: spec 5.1's WYSIWYG promise is about style, not
// size. Read that before reaching for a half-resolution preview.
//
// When the real one lands it needs a MediaStream stopped in unmount() (not via
// ctx.signal, since a track has no signal option, which is why unmount()
// exists), a requestAnimationFrame loop cancelled on abort, and an encode
// budget that skips frames rather than queueing them.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { currentStyle, currentCols } from '../state.js';
import { styleList } from '../../src/styles.js';
import { actionBar } from '../actionbar.js';
import { paintArt, autoFit, publishArtWidth } from '../art.js';
import { currentWord, advanceWord, messageName } from '../words.js';
import { nextMockPhoto } from '../mock.js';
import { encodePhoto, setSubject } from '../pipeline.js';

// Whether the clipboard holds one of our messages, which is what puts the gold
// dot on OPEN.
//
// Stubbed, and it may have to stay that way on one platform. Reading the
// clipboard without a user gesture needs the clipboard-read permission, which
// Chromium grants and WebKit does not implement. The real version queries the
// permission, reads only if it is already granted, and returns false on Safari.
// The dot is an enhancement and OPEN is always tappable, so a constant is safe
// until then.
function clipboardMayHavePayload() {
  return false;
}

export default register(defineScreen({
  id: 'capture',
  title: 'Capture',

  mount(el, ctx) {
    const state = ctx.state;

    // Build into a child, never onto `el` itself. `el` is #app-screen and it
    // carries the shell's own class; assigning el.className wipes it, which
    // silently drops .app-screen's padding, overflow-y and min-height. A child
    // root is also self-cleaning, because the router calls replaceChildren()
    // on navigation.
    const root = document.createElement('div');
    root.className = 'sc-capture';
    el.append(root);

    // Style selector. A segmented control with no box: words with a gold
    // underline on the active one. Style is the expressive choice and it is
    // made first, so it sits at the top, visible and out of the thumb's way.
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

    // Viewfinder.
    const stage = document.createElement('div');
    stage.className = 'sc-stage';
    const pre = document.createElement('pre');
    pre.className = 'sc-art';
    // A picture, not text to be read out cell by cell. Same treatment the
    // wrapper gives it.
    pre.setAttribute('role', 'img');
    pre.setAttribute('aria-label', 'Live preview');
    stage.append(pre);

    // Readout. Secondary by construction (spec 5.2): the character count is
    // information, not a control, and there is no slider on this screen to act
    // on it with. It stays because it is the one number that says whether the
    // message will be large before you take it.
    const readout = document.createElement('p');
    readout.className = 'sc-readout';

    root.append(styles, stage, readout);

    let photo = nextMockPhoto();
    let encoded = null;
    let word = currentWord();

    function reencode() {
      const s = state.get();
      try {
        encoded = encodePhoto(s, photo, { title: messageName(word) });
      } catch (err) {
        // An encode failure must not blank the viewfinder. The likeliest cause
        // is a custom charset failing its lint, and the user needs to see the
        // screen they would fix it from.
        console.error('capture: encode failed', err);
        encoded = null;
      }
    }

    function draw(w, h) {
      if (!encoded) { pre.textContent = ''; return; }
      const s = state.get();
      const painted = paintArt(pre, encoded.lines, {
        codec: currentStyle(s).codec,
        cols: encoded.stats.cols,
        rows: encoded.stats.rows,
      }, w, h);
      // The chrome clamps to the picture, not to the window.
      publishArtWidth(painted.width);
    }

    const refit = autoFit(stage, draw, { signal: ctx.signal });

    function render() {
      const s = state.get();
      const style = currentStyle(s);
      const cols = currentCols(s);

      for (const [id, b] of styleButtons) {
        const on = id === style.id;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
      }

      const chars = encoded ? encoded.stats.messageChars : s.sizeChars;
      readout.textContent = `${chars.toLocaleString()} chars · ${cols} cols`;
      // The legibility cap warns and does not clamp (2026-08-09). It fires at
      // the top of the slider for both codecs by construction (SHELL.md
      // disagreement 3), so it has to read as advice. An error colour here
      // would have the app crying wolf at its own maximum.
      readout.classList.toggle('is-warn', Boolean(encoded && encoded.warnings.length));

      bar.hero.querySelector('.pt-hero-label').textContent = word;
    }

    // Action bar. Leftmost leaves the screen; capture is the root, so here that
    // is OPEN, a lateral move rather than a back. See actionbar.js.
    //
    // 24/76 is a floor, not a preference: at 390px it puts OPEN on 48px, and
    // above about 80/20 it drops under the tap minimum. actionbar.js throws if
    // it does.
    const bar = actionBar(ctx.bottomBar, [
      {
        label: 'OPEN',
        flex: 24,
        dot: clipboardMayHavePayload(),
        onTap: () => ctx.navigate('paste'),
      },
      {
        label: word,
        // The label is a sound, not an instruction, so it is not the accessible
        // name. A screen reader says "Capture".
        aria: 'Capture',
        flex: 76,
        hero: true,
        onTap: async () => {
          if (!encoded) return;
          // The clamp is the whole capture feedback: no flash over the frame,
          // no shutter sound. Await it so the screen change lands after the
          // acknowledgement rather than on top of it.
          await bar.fire();
          setSubject({
            kind: 'mine',
            photo,
            word,
            takenAt: Date.now(),
            source: 'shot',
          });
          // The contract's own field, kept accurate for anyone who reads it.
          // The pixels are not in here; see pipeline.js.
          state.set({
            capture: { source: 'shot', width: photo.width, height: photo.height, takenAt: Date.now() },
          });
          // Rotate only after a capture is taken. The bar is promising a word,
          // and a promise that changes because you looked at it is not one.
          word = advanceWord();
          photo = nextMockPhoto();
          ctx.navigate('compose');
        },
      },
    ], { signal: ctx.signal });

    // Re-encode whenever anything the encode depends on moves. sizeChars is
    // compose's field, but it is read here so the readout agrees with what
    // compose will produce. If they disagree, the number appears to change on
    // navigation, which reads as a bug.
    state.subscribe((_s, changed) => {
      if (changed.has('styleId') || changed.has('sizeChars') || changed.has('customCharsets') || changed.has('invert')) {
        reencode();
        render();
        refit();
      }
    }, { signal: ctx.signal });

    reencode();
    render();
    refit();
  },
}));
