// Plane Text: what you can DO with a picture. Save it, or send it on.
//
// Added 2026-08-09, when the gallery got a SHARE and a SAVE of its own.
//
// WHY THIS IS A MODULE AND NOT A SECOND COPY. Every line below was inside
// compose.js's mount(), closed over that screen's `lines`, `message`, `geom`,
// `viewName`, `stage` and `say`. The gallery needs the same six things and the
// same four behaviours, and this codebase has recorded five instances of what
// happens when a second screen writes its own version: two recents strips at
// 30x40 and 46x60, two arming timers, two cap notes in two colours, a slider
// styled by another screen's sheet. The rule that came out of those is in
// README.md and it is not "be careful", it is "there is one definition".
//
// So the six things are an accessor and the four behaviours are this file.
//
//   artefact(host, {
//     root      the screen's .app-frame. The sheet is appended here and dims it,
//               so it must be the element the dimming rule applies to, not the
//               shell's container -- see the note on `.is-dimmed` in
//               artefact.css.
//     bottomBar ctx.bottomBar. Dimmed and made inert while the sheet is open;
//               it is a SIBLING of #app-screen, so no rule inside the screen can
//               reach it. This was a real bug: SHARE stayed lit and clickable
//               behind an aria-modal dialog.
//     stage     the .app-stage element. renderPng() needs its box to know what
//               "2x the on-screen fit" means.
//     say       the screen's status sink. Both screens have one.
//     current   () => ({ name, message, lines, geom }) for whatever is on the
//               stage RIGHT NOW. An accessor rather than a value, for the same
//               reason thumbStrip takes one for `state`: the viewer re-encodes
//               on every settled slider drag and the gallery swaps the whole
//               picture on every thumbnail tap, so anything captured at mount is
//               stale by the first interaction. Passing a snapshot here would
//               save the picture you were looking at a minute ago, which is the
//               worst possible failure for an export.
//     signal    AbortSignal, as everywhere in this codebase.
//   })
//   -> { save, share }
//
// WHAT IS NOT HERE. The action bar slots that call these, and the labels on
// them. The viewer puts SHARE in the hero with a 250ms arm against the shutter
// double-tap; the gallery puts both in a secondary row inside the chrome band
// because its three bar slots are entrances rather than actions. That is a
// per-screen decision about weight, and it is the screen's to make.

import { fileName } from './words.js';
import { fitFontSize } from './art.js';
import { baseLineHeight } from '../src/sizing.js';
import { advanceCssFor } from '../src/constants.js';

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

// Capped so a 130-column grid cannot ask for a canvas the browser will refuse
// to allocate.
const PNG_MAX_PX = 4096;

export function artefact({ root, bottomBar, stage, say, current, signal } = {}) {
  if (typeof current !== 'function') {
    // Thrown rather than defaulted, in the spirit of thumbStrip's check on
    // `state`. An export that silently writes the mount-time picture is a bug
    // whose symptom appears in the user's downloads folder, not on screen.
    throw new Error('artefact: `current` must be a function returning { name, message, lines, geom }, not a snapshot. What is on the stage changes.');
  }

  function download(blob, ext) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(current().name, ext);
    a.click();
    // Revoking immediately can cancel the download in some browsers. A tick
    // later is enough and there is nothing to leak in between.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------------------------------------------------------------------------
  // PNG export.
  //
  // THE TRAP, and it is the mistake this codebase has recorded five times:
  // canvas has its own text metrics, so the advance must be MEASURED with
  // measureText rather than assumed from ADVANCE_CSS. A guessed advance here
  // would shear every row against the one below it, and a PNG is the one output
  // with no fit shim to correct it afterwards.
  //
  // The line-height comes from baseLineHeight() at the MEASURED advance, for the
  // same reason art.js and wrap.js both do: there is one implementation of that
  // arithmetic and this is not allowed to be a second.
  //
  // Rendered at 2x the on-screen fit so it holds up on a retina screen and in
  // print.
  // -------------------------------------------------------------------------
  function renderPng() {
    const { lines, geom } = current();
    if (!lines.length || !geom) return null;
    const probe = document.createElement('canvas').getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const font = css.getPropertyValue('--pt-mono').trim() || 'monospace';
    const ink = css.getPropertyValue('--pt-art-ink').trim() || '#fff';
    const bg = css.getPropertyValue('--pt-art-bg').trim() || '#000';

    // Measure at a large size and divide, so the ratio is not quantised by
    // sub-pixel rounding at 12px.
    const PROBE_PX = 100;
    probe.font = `${PROBE_PX}px ${font}`;
    // A glyph from the payload itself. Measuring 'M' gives the latin advance
    // even when the payload is braille, and those only agree in a monospace
    // font if the font is honest about it.
    const sample = lines[0][0] || 'M';
    const measured = probe.measureText(sample).width / PROBE_PX;
    const advance = measured > 0.1 && measured < 2 ? measured : advanceCssFor(geom.codec);
    const lh = baseLineHeight(geom.codec, advance);

    let fontSize = fitFontSize(geom, stage.clientWidth, stage.clientHeight, advance) * 2;
    const w = () => Math.ceil(geom.cols * fontSize * advance);
    const h = () => Math.ceil(geom.rows * fontSize * lh);
    while ((w() > PNG_MAX_PX || h() > PNG_MAX_PX) && fontSize > 1) fontSize *= 0.9;

    const canvas = document.createElement('canvas');
    canvas.width = w();
    canvas.height = h();
    const g = canvas.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = ink;
    g.font = `${fontSize}px ${font}`;
    g.textBaseline = 'alphabetic';
    const lineH = fontSize * lh;
    // Centre each row's baseline in its line box, the way a <pre> does, so the
    // raster matches what is on screen rather than sitting a few pixels high.
    const baseline = (lineH + fontSize * 0.72) / 2;
    for (let i = 0; i < lines.length; i += 1) {
      g.fillText(lines[i], 0, i * lineH + baseline);
    }
    return canvas;
  }

  function write(fmt) {
    const { message, lines } = current();
    if (fmt.ext === 'txt') {
      download(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }), 'txt');
      say?.('Saved as TXT');
      return;
    }
    if (fmt.ext === 'html') {
      // The message is `header\n<html…>`. What gets saved is the page, so the
      // header line is dropped: it is wire metadata, and a browser opening the
      // file would render it as a stray line above the picture.
      const html = message.slice(message.indexOf('\n') + 1);
      download(new Blob([html], { type: 'text/html;charset=utf-8' }), 'html');
      say?.('Saved as HTML');
      return;
    }
    // PNG. This also settles a spec question: PNG export is in spec 9's Out
    // list, cut when the canvas renderer was going to live in the wrapper. The
    // app-side canvas survived that cut (spec 9 keeps it In, for the viewfinder
    // and the decode preview), so the exclusion is stale.
    let canvas = null;
    try {
      canvas = renderPng();
    } catch (err) {
      console.error('artefact: PNG render failed', err);
    }
    if (!canvas) { say?.('That picture could not be rendered as a PNG.', 'error'); return; }
    say?.('Rendering PNG…');
    canvas.toBlob((blob) => {
      if (!blob) { say?.('That picture could not be rendered as a PNG.', 'error'); return; }
      download(blob, 'png');
      say?.('Saved as PNG');
    }, 'image/png');
  }

  // The save sheet. A flush panel that dims what is behind it rather than
  // floating over it. No elevation anywhere in this app; surfaces separate by
  // hairline.
  function save() {
    const { message, lines } = current();
    root.classList.add('is-dimmed');
    // The action bar is a sibling of the screen container, so the dimming rule
    // in artefact.css cannot reach it: it stayed lit and clickable behind an
    // aria-modal dialog, and SHARE was one tap away from firing on a message
    // the user was in the middle of deciding how to save. Set inline rather
    // than adding a rule to shell.css, since .app-bottom belongs to the shell
    // and a screen only owns what it puts inside it.
    bottomBar.style.filter = 'brightness(0.3)';
    bottomBar.style.pointerEvents = 'none';

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
      // PNG's size is not known until it is rendered, and rendering three
      // formats to fill in a column would cost a canvas pass every time this
      // sheet opens. An em dash says "not known yet" rather than "nothing".
      size.textContent = fmt.ext === 'png'
        ? '—'
        : `${Math.round((fmt.ext === 'txt' ? lines.join('\n').length : message.length) / 1024)} KB`;
      row.append(l, b, size);
      row.addEventListener('click', () => { close(); write(fmt); }, { signal });
      scrim.append(row);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sc-sheet-cancel';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', close, { signal });
    scrim.append(cancel);

    // Closing, and the order matters.
    //
    // The dim lifts NOW and the panel leaves over the same --pt-dur-base the
    // `.is-dimmed` filter transition takes, so the picture coming back up and
    // the sheet going down are one move rather than two. The entrance is a
    // keyframe in artefact.css; the exit has to be here, because CSS cannot
    // hold a node alive long enough to animate it out.
    //
    // Made inert on the first frame rather than when the animation ends. A
    // 200ms window in which a sliding button still takes taps is a window in
    // which SAVE fires from a sheet the user has already cancelled, and it is
    // the same class of bug as the action bar staying live behind the dim.
    //
    // A CLASS AND animationend, NOT el.animate. The duration and the curve stay
    // in artefact.css next to the entrance they mirror, and this file does not
    // learn a number that tokens.css owns -- which is the drift the whole
    // stylesheet-per-component argument at the top of that file is about.
    //
    // It also gets reduced motion for free and correctly: shell.css's guard
    // clamps the animation to 1ms, so animationend fires on the next frame and
    // the sheet is simply gone. That is why the guard is 1ms and not `none`;
    // `none` would mean no animationend, and this handler would never run.
    //
    // The timeout is for exactly that case arriving from somewhere else -- an
    // engine that does not fire the event, an extension that kills animations.
    // A sheet that fails to close is a screen the user cannot get out of, so it
    // gets a floor rather than a promise.
    let closing = false;
    function close() {
      if (closing) return;   // cancel then abort would remove() twice
      closing = true;
      root.classList.remove('is-dimmed');
      bottomBar.style.filter = '';
      bottomBar.style.pointerEvents = '';
      scrim.style.pointerEvents = 'none';
      scrim.classList.add('is-closing');
      const gone = () => scrim.remove();

      // IS ANYTHING ACTUALLY ANIMATING? Ask, rather than assume.
      //
      // getAnimations() forces the style recalc the class just invalidated and
      // reports what is running, so this is the real answer for this element in
      // this engine on this frame -- not a guess from a media query. Nothing
      // running means the removal is synchronous, which is what the sheet did
      // before this change and what every caller has always been able to rely
      // on.
      //
      // Three things land in that branch and all three want it: an engine with
      // no CSS animation support, the headless DOM the smoke test mounts every
      // screen in, and a user agent that has stripped animations outright.
      // Reduced motion does NOT land here -- shell.css clamps to 1ms rather
      // than `none` precisely so there is still an animation to end.
      const running = typeof scrim.getAnimations === 'function'
        && scrim.getAnimations().length > 0;
      if (!running) { gone(); return; }

      scrim.addEventListener('animationend', gone, { once: true });
      // The floor. A sheet that fails to close is a screen with no way out, so
      // it does not depend on an event arriving. Comfortably past
      // --pt-dur-base; it is a deadline, not a duration, which is why it is not
      // a token. Same reasoning as the router's bail.
      setTimeout(gone, 400);
    }
    signal?.addEventListener('abort', close, { once: true });

    root.append(scrim);
    cancel.focus();
  }

  async function share() {
    const { message } = current();
    try {
      if (navigator.share) {
        await navigator.share({ text: message });
        return;
      }
      await navigator.clipboard.writeText(message);
      // Copy is the documented fallback for when the share sheet misbehaves
      // (spec 5.2). This used to overwrite the message name element to report
      // itself, which destroyed the name with nothing to restore it from. It
      // goes in the status line, which exists for exactly this.
      say?.('Copied to the clipboard');
    } catch {
      // A cancelled share sheet throws. That is a user decision, not an error.
    }
  }

  return { save, share };
}
