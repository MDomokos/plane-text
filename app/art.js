// Plane Text: drawing a grid of cells into a <pre>, in the app.
//
// This is the app-side twin of what src/wrap.js does for the portable message.
// They differ in one way, which is why this is not duplication:
//
//   The wrapper fits the art to an unknown viewport in an unknown font, with no
//   JS guaranteed. It ships a CSS baseline sized in vw plus a ~200-byte shim
//   that measures the rendered advance and corrects line-height and scale.
//
//   This file fits the art to a box it can measure, in a font it can measure,
//   with JS guaranteed. It does the same arithmetic once, up front, and sets a
//   font-size in px.
//
// Both take their advance and line-height from src/sizing.js and
// src/constants.js. Neither computes its own. Every geometry figure written out
// twice in this project has drifted from its original, five times so far per
// README.md, and one of those was the Test D harness disagreeing with the
// wrapper about this line-height.

import { advanceCssFor } from '../src/constants.js';
import { baseLineHeight } from '../src/sizing.js';

// Fit a cols x rows grid into a box and return the font size that does it.
//
// Two constraints, and which binds depends on the shape of the box:
//   width:  cols * fontSize * advance    <= boxW
//   height: rows * fontSize * lineHeight <= boxH
//
// On a phone the capture area is roughly 390 x 500 and a 3:4 grid wants
// 4/3 x 390 = 520 tall, so height binds and the art is narrower than the
// screen. On a desktop window width usually binds. The minimum handles both
// without a breakpoint.
export function fitFontSize({ codec, cols, rows }, boxW, boxH) {
  const advance = advanceCssFor(codec);
  const lh = baseLineHeight(codec);
  return Math.min(boxW / (cols * advance), boxH / (rows * lh));
}

// Paint lines into a <pre> and size it to the box.
//
// The <pre> is width:max-content for the same reason the wrapper's is: without
// it the element clamps to its container, and a grid that under-fills then
// measures as a perfect fit. That cost the wrapper a round of Test D.
// Returns the rendered size. The width is what the chrome clamps itself to:
// the art is 3:4 and usually height-bound, so on anything wider than a phone it
// occupies a column in the middle of the window, and controls running the full
// width would have no relationship to the picture they belong to. Measured
// rather than computed from cols x advance, because the measurement is the one
// number that survives a font whose advance is not what we assumed.
export function paintArt(pre, lines, geom, boxW, boxH) {
  const fontSize = fitFontSize(geom, boxW, boxH);
  pre.style.fontSize = `${fontSize}px`;
  pre.style.lineHeight = String(baseLineHeight(geom.codec));
  pre.textContent = lines.join('\n');
  const rect = pre.getBoundingClientRect();
  return { fontSize, width: rect.width, height: rect.height };
}

// Publish the art width so the chrome can clamp to it.
//
// Set on the document element rather than passed down, because the action bar
// lives in .app-bottom, outside the screen container, and a screen may only
// reach it through ctx.bottomBar. A custom property is the one channel that
// crosses that boundary without a screen reaching for another element.
export function publishArtWidth(width) {
  document.documentElement.style.setProperty('--pt-art-w', `${Math.round(width)}px`);
}

// Observe a container and repaint when it changes size.
//
// Orientation changes, the mobile URL bar collapsing and a desktop window drag
// all change the box, and all of them must re-fit rather than clip. The wrapper
// cannot do this, since it fits once on load. The app can, and a viewfinder
// that stays wrong after a rotate reads as a rendering bug rather than a layout
// one.
export function autoFit(box, draw, { signal = null } = {}) {
  let raf = 0;

  const paint = () => {
    const r = box.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) draw(r.width, r.height);
  };

  // rAF coalesces a resize storm into one paint per frame. It is also the one
  // scheduler a browser will simply not run: a hidden document is throttled to
  // about 1 fps and a backgrounded one can be paused outright.
  //
  // That is not a hypothetical. A screen mounts hidden when a tab is restored
  // on startup, when an installed PWA is resumed from the app switcher, and
  // when a share target launches the app into the background. In every one of
  // those the art never painted, and it never recovered either: nothing
  // resizes on the way to becoming visible, so the ResizeObserver stayed
  // silent and the <pre> stayed empty. A blank picture, on the path a message
  // most often arrives by.
  //
  // So paint straight away when hidden, coalesce when visible, and re-run on
  // the transition to cover a mount that happened in between.
  const run = () => {
    cancelAnimationFrame(raf);
    if (document.hidden) { paint(); return; }
    raf = requestAnimationFrame(paint);
  };

  const ro = new ResizeObserver(run);
  ro.observe(box);
  document.addEventListener('visibilitychange', run, { signal });
  signal?.addEventListener('abort', () => { ro.disconnect(); cancelAnimationFrame(raf); }, { once: true });
  run();
  return run;
}
