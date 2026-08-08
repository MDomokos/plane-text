// Plane Text: the viewer. One screen for every image.
//
// A picture you just shot, one you picked from the library, and one someone
// sent you are the same thing on screen: full-bleed art, a name, and back /
// save / share. Two things differ, and both follow from one fact, that a
// received message is already encoded and there is nothing left to decide
// about it:
//
//   the size slider   present for yours, absent for theirs
//   the fit readout   "103 columns, fits a phone" against "received"
//
// That is why this file serves the `compose` route and the paste screen
// navigates here rather than to a viewer of its own.
//
// The double-tap hazard. The action bar's primary slot never moves, and
// arriving here from a shutter tap leaves the thumb over it. It was SHOOT a
// moment ago and it is now SHARE, so without a guard a double-tap on the
// shutter opens the system share sheet for a message the user has not seen.
// `armAfter` on the hero is that guard. 250ms is longer than a double-tap
// interval and shorter than anyone's intent.

import { defineScreen } from '../screen.js';
import { register } from '../router.js';
import { currentStyle, currentCols } from '../state.js';
import { sizeRange } from '../../src/sizing.js';
import { actionBar } from '../actionbar.js';
import { paintArt, autoFit, publishArtWidth } from '../art.js';
import { messageName, fileName } from '../words.js';
import * as recents from '../recents.js';
import { encodePhoto, getSubject, clearSubject } from '../pipeline.js';

const SAVE_FORMATS = [
  // TXT and HTML are free: both strings are already in memory. gridToRows()
  // output is the txt, buildMessage() output is the html.
  { ext: 'txt', label: 'TXT', blurb: 'The message itself, one row per line', type: 'text/plain' },
  { ext: 'html', label: 'HTML', blurb: 'The page you would send. Opens anywhere', type: 'text/html' },
  { ext: 'png', label: 'PNG', blurb: 'A picture of the render', type: 'image/png' },
  // PDF was cut 2026-08-09. Built from text it reintroduces the font-advance
  // problem in the one format where the shim cannot correct it, which means
  // embedding a font subset into a bundle that has to precache before boarding.
  // Built by rasterising it is a PNG with a page size argument attached. The
  // use case is printing, and HTML already prints, and prints better, because
  // the printer scales real text rather than a guessed raster.
];

export default register(defineScreen({
  id: 'compose',
  title: 'Compose',

  mount(el, ctx) {
    const state = ctx.state;
    const subject = getSubject();

    // Arriving with nothing to show. This happens on a reload, since neither
    // the subject nor state.capture survives one. Bounce to capture rather than
    // rendering an empty viewer.
    if (!subject) {
      ctx.navigate('capture', null, { replace: true });
      return;
    }

    const mine = subject.kind === 'mine';

    // Build into a child, never onto `el` itself. See capture.js. This screen
    // has a second reason: the save sheet is position:absolute against this
    // root, and anchoring it to the shell's own container would put it outside
    // the element the dimming rule applies to.
    const root = document.createElement('div');
    root.className = 'sc-view';
    el.append(root);

    const name = mine ? messageName(subject.word, new Date(subject.takenAt)) : subject.name;
    ctx.setTitle(name);

    // Name line. Provenance is the only thing distinguishing three otherwise
    // identical screens, so it is stated rather than implied.
    const label = document.createElement('p');
    label.className = 'sc-view-name';
    label.textContent = mine ? `${name} · ${subject.source}` : `${name} · received`;

    const stage = document.createElement('div');
    stage.className = 'sc-view-stage';
    const pre = document.createElement('pre');
    pre.className = 'sc-view-art';
    pre.setAttribute('role', 'img');
    pre.setAttribute('aria-label', `Photo as text: ${name}`);
    stage.append(pre);

    // Readouts. Spec 5.2: the device-fit indicator is the primary metric and
    // the character count is secondary. The old fill bar is gone. At a third of
    // the ceiling it communicated "you have loads of room", which is true and
    // misleading, because the room cannot be spent on a bigger picture.
    const fit = document.createElement('p');
    fit.className = 'sc-view-fit';
    const chars = document.createElement('p');
    chars.className = 'sc-view-chars';

    // Slider, in characters, on a range shared by every codec (2026-08-09,
    // after reversing twice). Columns are a derived readout. Switching style
    // holds the file size and changes the geometry, which is the property a
    // user can be surprised by.
    const range = sizeRange();
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'sc-view-slider';
    slider.min = String(range.minChars);
    slider.max = String(range.maxChars);
    slider.step = '1';
    slider.setAttribute('aria-label', 'Message size in characters');
    slider.hidden = !mine;

    root.append(label, stage, fit, chars, slider);

    let encoded = null;
    let message = mine ? '' : subject.message;
    let lines = mine ? [] : subject.decoded.rows;
    let geom = mine
      ? null
      : {
        // parseMessage returns codec: null when the rows mix two cell charsets
        // and the header could not settle it. The picture is still decodable,
        // so fall back rather than throwing in advanceCssFor(). A message drawn
        // badly beats a screen that cannot be drawn. The warning is already in
        // subject.decoded.warnings.
        codec: subject.decoded.codec ?? currentStyle(state.get()).codec,
        cols: subject.decoded.grid.cols,
        rows: subject.decoded.grid.rows,
      };

    function reencode() {
      if (!mine) return;
      const s = state.get();
      try {
        encoded = encodePhoto(s, subject.photo, { title: name });
        message = encoded.message;
        lines = encoded.lines;
        geom = { codec: currentStyle(s).codec, cols: encoded.stats.cols, rows: encoded.stats.rows };
        // The store's own field. compose owns `encoded`.
        state.set({ encoded });
      } catch (err) {
        console.error('compose: encode failed', err);
      }
    }

    function draw(w, h) {
      if (!lines.length || !geom) return;
      publishArtWidth(paintArt(pre, lines, geom, w, h).width);
    }

    const refit = autoFit(stage, draw, { signal: ctx.signal });

    function render() {
      const s = state.get();
      if (mine) {
        const cols = currentCols(s);
        const warned = encoded && encoded.warnings.length > 0;
        // "fits a phone" is the claim the user is making with the slider, so it
        // is a sentence rather than a number.
        fit.textContent = warned
          ? `${cols} columns · the recipient will need to zoom`
          : `${cols} columns · fits a phone`;
        fit.classList.toggle('is-warn', Boolean(warned));
        chars.textContent = `${(encoded ? encoded.stats.messageChars : s.sizeChars).toLocaleString()} characters`;
        if (String(s.sizeChars) !== slider.value) slider.value = String(s.sizeChars);
      } else {
        fit.textContent = `${geom.cols} columns`;
        chars.textContent = `received · ${message.length.toLocaleString()} characters`;
      }
    }

    // rAF-coalesced, because a range input fires on every pixel of a drag and
    // an encode is not free. The store is written on every input so nothing
    // desynchronises; only the expensive part is throttled.
    let pending = 0;
    slider.addEventListener('input', () => {
      state.set({ sizeChars: Number(slider.value) });
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => { reencode(); render(); refit(); });
    }, { signal: ctx.signal });
    ctx.signal.addEventListener('abort', () => cancelAnimationFrame(pending), { once: true });

    state.subscribe((_s, changed) => {
      if (changed.has('styleId') || changed.has('customCharsets') || changed.has('invert')) {
        reencode(); render(); refit();
      }
    }, { signal: ctx.signal });

    // Save sheet. A flush panel that dims what is behind it rather than
    // floating over it. No elevation anywhere in this app; surfaces separate by
    // hairline.
    function openSaveSheet() {
      root.classList.add('is-dimmed');
      // The action bar is a sibling of the screen container, so the dimming
      // rule in compose.css cannot reach it: it stayed lit and clickable behind
      // an aria-modal dialog, and SHARE was one tap away from firing on a
      // message the user was in the middle of deciding how to save. Set inline
      // rather than adding a rule to shell.css, since .app-bottom belongs to
      // the shell and a screen only owns what it puts inside it.
      ctx.bottomBar.style.filter = 'brightness(0.3)';
      ctx.bottomBar.style.pointerEvents = 'none';
      const scrim = document.createElement('div');
      scrim.className = 'sc-sheet';
      scrim.setAttribute('role', 'dialog');
      scrim.setAttribute('aria-modal', 'true');
      scrim.setAttribute('aria-label', 'Save as');

      const head = document.createElement('p');
      head.className = 'sc-sheet-head';
      head.textContent = 'SAVE AS';
      scrim.append(head);

      for (const fmt of SAVE_FORMATS) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sc-sheet-row';
        const l = document.createElement('span');
        l.className = 'sc-sheet-ext';
        l.textContent = fmt.label;
        const b = document.createElement('span');
        b.className = 'sc-sheet-blurb';
        b.textContent = fmt.blurb;
        const size = document.createElement('span');
        size.className = 'sc-sheet-size';
        size.textContent = fmt.ext === 'png' ? '—' : `${Math.round((fmt.ext === 'txt' ? lines.join('\n').length : message.length) / 1024)} KB`;
        row.append(l, b, size);
        row.addEventListener('click', () => { save(fmt); close(); }, { signal: ctx.signal });
        scrim.append(row);
      }

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'sc-sheet-cancel';
      cancel.textContent = 'CANCEL';
      cancel.addEventListener('click', close, { signal: ctx.signal });
      scrim.append(cancel);

      function close() {
        scrim.remove();
        root.classList.remove('is-dimmed');
        ctx.bottomBar.style.filter = '';
        ctx.bottomBar.style.pointerEvents = '';
      }
      ctx.signal.addEventListener('abort', close, { once: true });

      root.append(scrim);
      cancel.focus();
    }

    function download(blob, ext) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName(name, ext);
      a.click();
      // Revoking immediately can cancel the download in some browsers. A tick
      // later is enough and there is nothing to leak in between.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function save(fmt) {
      if (fmt.ext === 'txt') {
        download(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), 'txt');
        return;
      }
      if (fmt.ext === 'html') {
        // The message is `header\n<html…>`. What gets saved is the page, so the
        // header line is dropped: it is wire metadata, and a browser opening
        // the file would render it as a stray line above the picture.
        const html = message.slice(message.indexOf('\n') + 1);
        download(new Blob([html], { type: 'text/html;charset=utf-8' }), 'html');
        return;
      }
      // PNG: stubbed. Step two.
      //
      // Draw the rows to a canvas with fillText at a font size from art.js's
      // fitFontSize, then toBlob. The trap is that canvas has its own text
      // metrics, so the advance must be measured with measureText rather than
      // assumed from ADVANCE_CSS. That is the mistake documented five times in
      // README.md.
      //
      // This also settles a spec question. PNG export is in spec 9's Out list,
      // cut when the canvas renderer was going to live in the wrapper. The
      // app-side canvas survived that cut (spec 9 keeps it In, for the
      // viewfinder and decode preview), so the exclusion is stale.
      console.warn('PNG export is not implemented yet. See app/screens/compose.js.');
    }

    async function share() {
      const text = message;
      try {
        if (navigator.share) {
          await navigator.share({ text });
          return;
        }
        await navigator.clipboard.writeText(text);
        // Copy is the documented fallback for when the share sheet misbehaves
        // (spec 5.2). Saying so beats silence, which reads as nothing having
        // happened.
        label.textContent = 'Copied to the clipboard';
      } catch {
        // A cancelled share sheet throws. That is a user decision, not an error.
      }
    }

    // Action bar. Leftmost is BACK, and it goes where you came from: capture
    // for one of yours, open for one of theirs.
    actionBar(ctx.bottomBar, [
      {
        label: 'BACK',
        flex: 22,
        onTap: () => { clearSubject(); ctx.navigate(mine ? 'capture' : 'paste'); },
      },
      { label: 'SAVE', flex: 28, onTap: openSaveSheet },
      {
        label: 'SHARE',
        aria: 'Share this message',
        flex: 50,
        hero: true,
        armAfter: 250,
        onTap: share,
      },
    ], { signal: ctx.signal });

    reencode();
    render();
    refit();

    // Yours goes into recents too. The strip is an undo for leaving the app,
    // and leaving right after a capture is when you want it.
    if (mine && message) recents.add({ name, message, source: subject.source });
  },
}));
