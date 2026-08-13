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

import { advanceCssFor, CAPTURE_ASPECT } from '../src/constants.js';
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
// `advance` may be overridden by a caller that has MEASURED it rather than
// inheriting the CSS baseline. The <pre> path cannot: it sets a font size and
// finds out afterwards. The canvas viewfinder can, because it has to measure
// the advance anyway to size the atlas cell, and feeding a stale guess in here
// would size the canvas for a glyph width the atlas does not use, so the art
// overflows its stage on any font whose real advance runs wide. Block Elements
// does by 18% on a Pixel.
//
// This stays the ONLY implementation of the fit arithmetic. The alternative was
// the viewfinder computing its own min-of-two-constraints, and every geometry
// figure written out twice in this project has drifted from its original.
export function fitFontSize({ codec, cols, rows }, boxW, boxH, advance = advanceCssFor(codec)) {
  const lh = baseLineHeight(codec, advance);
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

// The width the chrome clamps to, from the RESERVED stage box.
//
// Added 2026-08-09. Every screen used to publish the measured width of what it
// had just painted, which made the chrome's width a function of the aspect of
// the last thing rendered: the action bar and the save sheet changed width on
// navigation, and again when a received message had an unusual grid.
//
// This is stable instead, and it is stable for a structural reason rather than
// by rounding. The stage box is identical on every picture screen (see
// --pt-chrome-top / --pt-chrome-bot in tokens.css), and CAPTURE_ASPECT is a
// fixed constant that every source is cropped to, which a test pins.
// So min(boxW, boxH * aspect) is the width the art will occupy whichever
// constraint binds, without needing to know the codec, the column count or the
// font's advance.
//
// It is deliberately NOT the art's measured width. A received message whose
// grid is not 3:4 will draw narrower or wider than this; the chrome does not
// follow it, because the chrome's job is to hold still.
export function stageArtWidth(boxW, boxH, aspect = CAPTURE_ASPECT) {
  return Math.min(boxW, boxH * aspect);
}

// THE STILL'S INSET. Added 2026-08-13.
//
// A live view bleeds to the edge of its box; a still steps back and acquires a
// hairline. That is the mode indicator the pinned art box made necessary: once
// the picture is the same size in the same place on the viewfinder and the
// viewer, nothing about the chrome distinguishes them. The other half is the
// corner brackets on capture; see the `frame` note in capture.js.
//
// 16px each side, costing 32px of width in the mode where you are no longer
// framing anything.
//
// BOTH AXES. The horizontal inset is subtracted here and applied by shrinking
// the fit; the vertical inset is subtracted here AND applied as a margin in
// .app-art.is-framed, because .app-stage is top-aligned and a height the art
// does not use would pool at the bottom. The two have to agree, so the 16px in
// shell.css and STILL_INSET_PX here are pinned to each other by a test.
//
// A CONSTANT HERE RATHER THAN A PADDING IN CSS. autoFit() measures the stage
// with getBoundingClientRect(), which includes padding, so a stage that inset
// itself in CSS would hand paintArt() the outer width and the art would fit to a
// box 32px wider than the one it is drawn in. Every screen that insets subtracts
// this from the numbers it fits with, and this is where the number lives.
//
// --pt-art-w is NOT reduced by it. That token is what the chrome clamps to, and
// the chrome belongs to the reserved box rather than to the picture inside it.
// Narrowing the action bar by 32px whenever you look at a still is the
// resizing-chrome bug the whole mechanism exists to stop.
export const STILL_INSET_PX = 16;

// The border the hairline box draws with, subtracted so the art fits INSIDE it.
// One pixel each side, and `* { box-sizing: border-box }` does not help here:
// the <pre> is width:max-content, so its intrinsic width is its content and the
// border is added outside it.
export const STILL_BORDER_PX = 1;

// The box a still gets, from the box the stage has.
export function stillBox(boxW, boxH) {
  const chrome = (STILL_INSET_PX + STILL_BORDER_PX) * 2;
  return {
    width: Math.max(1, boxW - chrome),
    height: Math.max(1, boxH - chrome),
  };
}

// Publish the art width so the chrome can clamp to it.
//
// Set on the document element rather than passed down, because the action bar
// lives in .app-bottom, outside the screen container, and a screen may only
// reach it through ctx.bottomBar. A custom property is the one channel that
// crosses that boundary without a screen reaching for another element.
//
// Rounded, and only written when the rounded value actually changes. Writing a
// custom property invalidates style for everything that reads it, and this used
// to be called on every frame of a viewfinder loop.
let lastPublished = null;
export function publishArtWidth(width) {
  const px = Math.round(width);
  if (px === lastPublished || !Number.isFinite(px) || px <= 0) return;
  lastPublished = px;
  document.documentElement.style.setProperty('--pt-art-w', `${px}px`);
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
