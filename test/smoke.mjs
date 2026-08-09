// Plane Text: the screens, mounted for real.
//
//   npm run smoke
//
// NOT part of `npm test`, and deliberately so. This is the only thing in the
// project with a dependency, jsdom, and README.md's "no dependencies, no build
// step, no framework" is worth keeping true for the shipping code. So it is
// opt-in, absent from package.json's dependency list, and `npm test` stays a
// bare `node --test`.
//
// WHY IT EXISTS. Everything in test/planetext.test.js runs in Node because
// nothing in src/ touches the DOM, and the app/ tests there assert contracts by
// reading source text. Neither can answer the question this file answers: does
// the screen actually mount, and is the thing it builds the thing it claims to
// build. Written 2026-08-09 alongside the UX review fixes, where the risk was
// exactly that: three screens rebuilt around a shared layout, with no way to
// see any of them.
//
// It earned its place immediately. It caught openStill() depending on the
// ImageData constructor, which is the newer API and the one an environment is
// likeliest to lack; that is now createImageData, which is portable.
//
// WHAT IT CANNOT TELL YOU. It is jsdom, so there is no layout: every box
// measures 390 x 538 because the stub says so. It proves structure, wiring and
// control flow. It cannot prove the picture holds still; that is what the
// reserved-band assertions in planetext.test.js are for, and ultimately what a
// real device is for.
//
// To run it:  npm install --no-save jsdom && npm run smoke

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // Fail loudly rather than skipping. A check that quietly does not run is one
  // nobody knows they have lost, the same failure mode as the PNG row that was
  // a console.warn.
  console.error('smoke: jsdom is not installed.\n  npm install --no-save jsdom && npm run smoke');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://example.com/plane-text/', pretendToBeVisual: true });
const { window } = dom;

// --- stubs for what jsdom does not implement -------------------------------
window.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
window.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){} });
const nodePerf = performance;
window.requestAnimationFrame = (fn) => setTimeout(() => fn(nodePerf.now()), 0);
window.cancelAnimationFrame = (id) => clearTimeout(id);
const noop = () => {};
window.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind !== '2d') return null;   // no WebGL: exercises the canvas2d fallback
  return new Proxy({
    canvas: this,
    measureText: (t) => ({ width: [...String(t)].length * 60, actualBoundingBoxAscent: 70, actualBoundingBoxDescent: 20 }),
    getImageData: (x,y,w,h) => ({ data: new Uint8ClampedArray(Math.max(1,w*h*4)), width:w, height:h }),
    createImageData: (w,h) => ({ data: new Uint8ClampedArray(Math.max(1,w*h*4)), width:w, height:h }),
  }, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: () => true,
  });
};
window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new window.Blob(['x'])); };
Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
  value() { return { width: 390, height: 538, top: 0, left: 0, right: 390, bottom: 538 }; },
});
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get(){ return 390; } });
Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get(){ return 538; } });
window.navigator.mediaDevices = undefined;   // no camera: exercises the notice path

// AbortController and AbortSignal are in this list as of 2026-08-09 and they
// are not decoration. Node has its own, and jsdom's addEventListener does a
// brand check on the `signal` option, so a component that creates a controller
// of its own -- thumbstrip.js does, one per render, to drop the previous
// render's listeners -- hands jsdom a foreign signal and every listener throws.
// Nothing was wrong with the component; the harness was running two
// implementations of one global.
for (const k of ['window','document','navigator','location','history','localStorage','HTMLElement','Element','Node','CustomEvent','Event','MessageChannel','ImageData','Blob','URL','AbortController','AbortSignal','requestAnimationFrame','cancelAnimationFrame','ResizeObserver','matchMedia','getComputedStyle','devicePixelRatio','queueMicrotask']) {
  if (!(k in window)) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); }
}
globalThis.self = window;

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

// The size slider is one component mounted by two screens (app/sizeslider.js),
// so "the same control" is checkable here in a way the source-text tests
// cannot: build it on both, describe what each screen actually rendered, and
// compare. Filled by the capture block and read by the compose one.
const sliderShape = {};
const describeSlider = (root) => {
  const wrap = root.querySelector('.pt-slider');
  const input = root.querySelector('.pt-slider-input');
  if (!wrap || !input) return null;
  return {
    min: input.min,
    max: input.max,
    step: input.step,
    aria: input.getAttribute('aria-label'),
    ticks: root.querySelectorAll('.pt-tick').length,
    device: root.querySelectorAll('.pt-tick.is-device').length,
    labels: [...root.querySelectorAll('.pt-tick-label')].map((e) => e.textContent).join(','),
  };
};

const { store } = await import(`${ROOT}/app/state.js`);
const router = await import(`${ROOT}/app/router.js`);
await import(`${ROOT}/app/screens/index.js`);

const container = document.getElementById('app-screen');
const bottomBar = document.getElementById('app-bottom');

async function mount(id, params = {}) {
  container.replaceChildren();
  bottomBar.replaceChildren();
  document.body.dataset.route = id;
  const screen = router.resolve(id);
  const ctrl = new window.AbortController();
  const ctx = {
    state: store, route: { path: id, params }, navigate: (p) => { ctx.navigated = p; },
    signal: ctrl.signal, bottomBar, setTitle(){},
  };
  await screen.mount(container, ctx);
  await new Promise((r) => setTimeout(r, 30));
  return { ctx, ctrl, screen };
}

// --- capture ---------------------------------------------------------------
{
  const { screen } = await mount('capture');
  const root = container.querySelector('.sc-capture');
  ok(root, 'capture: root exists');
  ok(root && root.classList.contains('app-frame'), 'capture: builds the shell frame');
  ok(container.classList.contains('app-screen'), 'capture: does NOT wipe .app-screen');
  ok(container.querySelector('.app-chrome-top'), 'capture: top band');
  ok(container.querySelector('.app-stage'), 'capture: stage');
  ok(container.querySelector('.app-chrome-bot'), 'capture: bottom band');
  ok(container.querySelector('.sc-gear'), 'capture: settings glyph exists');
  ok(container.querySelectorAll('.sc-style').length >= 2, 'capture: style row rendered');
  ok(container.querySelector('.app-status'), 'capture: status line');
  ok(bottomBar.querySelectorAll('.pt-slot').length === 2, 'capture: two action slots');
  ok(container.querySelector('.sc-notice') && !container.querySelector('.sc-notice').hidden, 'capture: no-camera notice shown');
  // band order must be chrome / stage / chrome, or the grid rows do not line up
  const kids = [...root.children].map((e) => e.className.split(' ')[0]);
  ok(kids[0].startsWith('app-chrome-top') && kids[1] === 'app-stage' && kids[2].startsWith('app-chrome-bot'),
     `capture: band order is ${kids.join(' / ')}`);

  // --- the size slider, in the live viewfinder ----------------------------
  // The owner asked for the slider PLUS the readout, both in this band. It has
  // to be here, it has to be the shared component's markup, and it has to sit
  // between the readout and the status line: the readout describes the picture
  // and the control that changes it goes under it, not between them.
  sliderShape.capture = describeSlider(container);
  ok(sliderShape.capture, 'capture: the size slider is mounted');
  const capSlider = container.querySelector('.pt-slider-input');
  ok(capSlider && !capSlider.hidden, 'capture: the slider is live, not the hidden received-message state');
  ok(sliderShape.capture && sliderShape.capture.device === 1, 'capture: exactly one device marker in range');
  const capBand = [...container.querySelector('.app-chrome-bot').children].map((e) => e.className.split(' ')[0]);
  ok(capBand.join('/') === 'sc-readout/pt-slider/app-status', `capture: band rows are ${capBand.join(' / ')}`);

  // Dragging it writes the store, and the field is written by the component
  // rather than by this screen (state.js's owner table). Values are the range's
  // own endpoints, so this also proves min/max reached the element.
  const before = store.get().sizeChars;
  capSlider.value = capSlider.max;
  capSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(store.get().sizeChars === Number(capSlider.max), 'capture: dragging the slider writes sizeChars');
  ok(store.get().sizeChars !== before, 'capture: the drag actually moved it');
  // The readout is the other half of what the owner asked for, and it must name
  // the grid the slider just chose rather than the one before it.
  const { currentCols } = await import(`${ROOT}/app/state.js`);
  const readout = container.querySelector('.sc-readout');
  ok(readout && readout.textContent.includes(`${currentCols(store.get())} cols`),
     `capture: the readout follows the slider, got "${readout && readout.textContent}"`);
  // Put it back, so the compose blocks below start where they used to.
  capSlider.value = String(before);
  capSlider.dispatchEvent(new window.Event('input', { bubbles: true }));

  if (screen.unmount) screen.unmount();
}

// --- paste, with nothing saved ---------------------------------------------
//
// The gallery's empty state. This is the only screen in the app whose layout
// changes on the contents of a cache, so both halves are mounted for real: the
// big paste target must be here with nothing saved, and gone with something
// saved.
const recents = await import(`${ROOT}/app/recents.js`);
{
  recents.clear();
  await mount('paste');
  const root = container.querySelector('.sc-open');
  ok(root, 'paste: root exists');
  ok(root && root.classList.contains('app-frame'), 'paste: builds the shell frame');
  const kids = [...root.children].map((e) => e.className.split(' ')[0]);
  ok(kids[0].startsWith('app-chrome-top') && kids[1] === 'app-stage' && kids[2].startsWith('app-chrome-bot'),
     `paste: band order is ${kids.join(' / ')}`);

  const empty = container.querySelector('.sc-open-empty');
  ok(empty && !empty.hidden, 'paste: the big paste target IS the empty state');
  ok(container.querySelector('.sc-target'), 'paste: the target is the one that already existed');
  ok(container.querySelector('.sc-target-note'), 'paste: with its explainer');
  ok(container.querySelector('.app-art').hidden, 'paste: no picture, because there is nothing to show');

  ok(container.querySelector('.pt-strip'), 'paste: the shared strip always renders');
  ok(container.querySelector('.pt-strip-empty'), 'paste: empty state renders when there is nothing');
  // Not a tablist with nothing saved: nothing is the current entry, and a
  // tablist with no selected tab is a lie to a screen reader.
  ok(container.querySelector('.pt-strip').getAttribute('role') === 'group', 'paste: the strip is a group when nothing is current');
  const del = container.querySelector('.pt-del');
  ok(del && del.hidden, 'paste: nothing selected, so nothing to delete');

  const slots = [...bottomBar.querySelectorAll('.pt-slot')];
  ok(slots.length === 3, `paste: three action slots, got ${slots.length}`);
  ok(slots[0].textContent.trim() === 'SHOOT', `paste: leftmost leaves the screen, got "${slots[0].textContent.trim()}"`);
  ok(slots[2].classList.contains('pt-slot-hero') && slots[2].textContent.includes('PASTE'),
     `paste: the hero is PASTE, got "${slots[2].textContent.trim()}"`);
}

// --- paste, as the gallery -------------------------------------------------
{
  const { encode } = await import(`${ROOT}/src/encode.js`);
  const message = (seed) => {
    const w = 60, h = 80;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const v = ((i * seed) % 97) * 2;
      rgba[i*4] = v; rgba[i*4+1] = v; rgba[i*4+2] = v; rgba[i*4+3] = 255;
    }
    return encode(rgba, w, h, { cols: 40 }).message;
  };
  recents.clear();
  recents.add({ name: 'older 20260809 1200', message: message(3), source: 'received' });
  recents.add({ name: 'newer 20260809 1300', message: message(7), source: 'received' });

  await mount('paste');
  // The owner's "by default always opening the latest image".
  ok(container.querySelector('.app-name').textContent.startsWith('newer'),
     `gallery: opens on the most recent entry, got "${container.querySelector('.app-name').textContent}"`);
  ok(container.querySelector('.app-art').textContent.length > 100, 'gallery: the latest entry is actually painted');
  ok(!container.querySelector('.app-art').hidden, 'gallery: the picture is on the stage');
  ok(container.querySelector('.sc-open-empty').hidden, 'gallery: the big paste target is gone once something is saved');
  ok(container.querySelector('.pt-strip').getAttribute('role') === 'tablist', 'gallery: the strip is a tablist, because one entry is current');
  ok(container.querySelectorAll('.pt-thumb').length === 2, 'gallery: both entries in the strip');
  ok(container.querySelector('.pt-thumb.is-on'), 'gallery: the shown entry is marked');
  // The strip sits where it sits on the viewer: second-to-last row of the band,
  // above the status line.
  const band = [...container.querySelector('.app-chrome-bot').children].map((e) => e.className.split(' ')[0]);
  ok(band[band.length - 2] === 'pt-strip' && band[band.length - 1] === 'app-status',
     `gallery: band tail is ${band.join(' / ')}`);

  // Picking a thumbnail swaps the stage rather than navigating.
  const thumbs = [...container.querySelectorAll('.pt-thumb')];
  thumbs[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(container.querySelector('.app-name').textContent.startsWith('older'), 'gallery: a tap shows that entry in the stage');
  thumbs[0].dispatchEvent(new window.Event('click', { bubbles: true }));

  // Delete: one labelled control, in the top band, acting on what is on screen.
  // It arms first. That is the whole reason a mis-tap is harmless and it is the
  // contract the old corner button paid for with a sub-44px target.
  const del = container.querySelector('.pt-del');
  ok(del && !del.hidden && del.textContent === 'DELETE', 'gallery: a labelled delete, not a corner glyph');
  ok(container.querySelector('.app-chrome-top').contains(del), 'gallery: delete is in the top band, not over the picture');
  del.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(del.dataset.armed === '1' && del.textContent === 'TAP AGAIN', 'gallery: the first tap arms rather than deletes');
  ok(container.querySelectorAll('.pt-thumb').length === 2, 'gallery: the first tap removes nothing');
  del.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(container.querySelectorAll('.pt-thumb').length === 1, 'gallery: the second tap deletes');
  ok(container.querySelector('.app-name').textContent.startsWith('older'), 'gallery: and lands on the neighbour');

  // Emptying the list bounces to the empty state rather than navigating: this
  // screen is where the viewer goes when ITS list empties, so there is nowhere
  // further to send anyone.
  del.dispatchEvent(new window.Event('click', { bubbles: true }));
  del.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(container.querySelector('.pt-strip-empty'), 'gallery: the strip returns to its empty state');
  ok(!container.querySelector('.sc-open-empty').hidden, 'gallery: and the big paste target comes back');
  ok(del.hidden, 'gallery: with nothing selected, the delete control goes');

  recents.clear();
}

// --- compose, with a real photo -------------------------------------------
{
  const { setSubject } = await import(`${ROOT}/app/pipeline.js`);
  const w = 120, h = 160;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = (i % w) * 2;
    rgba[i*4] = v; rgba[i*4+1] = v; rgba[i*4+2] = v; rgba[i*4+3] = 255;
  }
  setSubject({ kind: 'mine', photo: { rgba, width: w, height: h }, word: 'ZAP', takenAt: Date.now(), source: 'shot' });

  const { screen, ctx } = await mount('compose');
  const root = container.querySelector('.sc-view');
  ok(root && root.classList.contains('app-frame'), 'compose: builds the shell frame');
  const kids = [...root.children].map((e) => e.className.split(' ')[0]);
  ok(kids[0].startsWith('app-chrome-top') && kids[1] === 'app-stage' && kids[2].startsWith('app-chrome-bot'),
     `compose: band order is ${kids.join(' / ')}`);
  // .app-art, not .sc-view-art. The <pre> rule moved to shell.css on 2026-08-09
  // when the gallery started painting into one too.
  ok(container.querySelector('.app-art').textContent.length > 100, 'compose: art actually painted');
  const slider = container.querySelector('.pt-slider-input');
  ok(slider && !slider.hidden, 'compose: slider shown for one of yours');
  ok(container.querySelectorAll('.pt-tick').length >= 3, 'compose: slider ticks rendered');
  ok([...container.querySelectorAll('.pt-tick.is-device')].length === 1, 'compose: exactly one device marker in range');
  // ONE CONTROL, TWO SCREENS. Not "a slider on each": the same range, the same
  // step, the same accessible name, the same ticks with the same labels in the
  // same order. Two implementations were free to disagree about every one of
  // those, which is the report that produced app/thumbstrip.js.
  sliderShape.compose = describeSlider(container);
  ok(sliderShape.capture && sliderShape.compose
     && JSON.stringify(sliderShape.capture) === JSON.stringify(sliderShape.compose),
     `compose: the slider must be the same control capture mounts\n    capture ${JSON.stringify(sliderShape.capture)}\n    compose ${JSON.stringify(sliderShape.compose)}`);
  ok(container.querySelector('.pt-strip'), 'compose: carousel strip');
  ok(container.querySelector('.pt-thumb'), 'compose: at least one carousel entry (the live one)');
  ok(container.querySelector('.pt-thumb-name'), 'compose: the thumbnail carries its name here too');
  ok(container.querySelector('.pt-del'), 'compose: one labelled delete, from the same component');
  ok(!container.querySelector('.pt-thumb-del'), 'compose: and no corner dismiss on the thumbnails');
  ok(container.querySelector('.pt-strip').getAttribute('role') === 'tablist', 'compose: the strip is a tablist, because one entry is current');
  ok(container.querySelector('.pt-thumb.is-on'), 'compose: the live entry is marked');
  // The strip is the second-to-last row of the band, above the status line. If
  // it lands anywhere else it is not where paste puts it either.
  const band = [...container.querySelector('.app-chrome-bot').children].map((e) => e.className.split(' ')[0]);
  ok(band[band.length - 2] === 'pt-strip' && band[band.length - 1] === 'app-status',
     `compose: band tail is ${band.join(' / ')}`);
  // And the whole row order, not just the tail. This band is 172 of the 176px
  // in --pt-chrome-bot (thumbstrip.css counts it out), so its contents are the
  // reason the picture is the size it is on every screen in the app. The slider
  // became a component mount rather than an inline build on 2026-08-09, and the
  // one thing that had to survive that is which row it is.
  ok(band.join('/') === 'sc-view-fit/sc-view-chars/pt-slider/pt-strip/app-status',
     `compose: band rows are ${band.join(' / ')}`);
  ok(bottomBar.querySelectorAll('.pt-slot').length === 3, 'compose: three action slots');

  // the save sheet, including the row that used to be a console.warn
  const save = [...bottomBar.querySelectorAll('.pt-slot')][1];
  save.dispatchEvent(new window.Event('click', { bubbles: true }));
  const rows = [...container.querySelectorAll('.sc-sheet-row .sc-sheet-ext')].map((e) => e.textContent);
  ok(rows.join(',') === 'TXT,HTML,PNG', `compose: save sheet rows are ${rows.join(',')}`);
  container.querySelector('.sc-sheet-cancel').dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(!container.querySelector('.sc-sheet'), 'compose: sheet closes');
  ok(bottomBar.style.pointerEvents === '', 'compose: action bar re-enabled after the sheet closes');

  // Arm then confirm. There is no undo, so the whole trade rests on the first
  // tap doing nothing. Last, because the second tap empties the strip and the
  // viewer leaves for `open`, which is the other behaviour worth pinning.
  //
  // It is in the TOP band here, as it is on the gallery, and the assertion is
  // written that way rather than as "somewhere on the screen": the constraint
  // that decided the position is that --pt-chrome-bot has four spare pixels of
  // 176 and cannot hold a --pt-tap row without shrinking every picture in the
  // app.
  const del = container.querySelector('.pt-del');
  ok(container.querySelector('.app-chrome-top').contains(del), 'compose: delete is in the top band, not in the full bottom one');
  const before = container.querySelectorAll('.pt-thumb').length;
  del.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(del.dataset.armed === '1' && del.textContent === 'TAP AGAIN', 'compose: the first tap arms rather than deletes');
  ok(container.querySelectorAll('.pt-thumb').length === before, 'compose: the first tap removes nothing');
  del.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(container.querySelector('.pt-strip-empty'), 'compose: the second tap deletes, and the strip shows its empty state');
  ok(ctx.navigated === 'paste', 'compose: emptying the strip leaves for open');
  if (screen.unmount) screen.unmount();
}

// --- compose, a received message ------------------------------------------
{
  const { setSubject, decodeMessage } = await import(`${ROOT}/app/pipeline.js`);
  const { encode } = await import(`${ROOT}/src/encode.js`);
  const w = 60, h = 80;
  const rgba = new Uint8ClampedArray(w*h*4).fill(200);
  const out = encode(rgba, w, h, { cols: 40, title: 'theirs' });
  const decoded = decodeMessage(out.message);
  setSubject({ kind: 'theirs', message: out.message, name: 'theirs 20260809 1200', decoded });
  await mount('compose');
  // Both halves of setHidden(): the wrapper collapses and the input goes with
  // it. They are two rules in sizeslider.css, and a wrapper that collapses
  // around a visible input is a control that half exists.
  const slider = container.querySelector('.pt-slider-input');
  ok(slider.hidden, 'compose: no slider for a received message');
  ok(container.querySelector('.pt-slider').hidden, 'compose: and the wrapper goes with it');
  ok(container.querySelector('.app-status'), 'compose: status line present for warnings');
}

// --- capture, import sub-mode ---------------------------------------------
{
  const { setSubject, getSubject } = await import(`${ROOT}/app/pipeline.js`);
  const w = 90, h = 120;
  const rgba = new Uint8ClampedArray(w*h*4);
  for (let i = 0; i < w*h; i++) { const v=(i%w)*3; rgba[i*4]=v; rgba[i*4+1]=v; rgba[i*4+2]=v; rgba[i*4+3]=255; }
  setSubject({ kind:'mine', photo:{rgba,width:w,height:h}, word:'SNAP', takenAt:Date.now(), source:'library' });

  const { ctx, screen } = await mount('capture', { import: '1' });
  ok(container.querySelector('.sc-capture'), 'import: capture root exists');
  // The frozen path must NOT show the no-camera notice: the still is the source.
  const notice = container.querySelector('.sc-notice');
  ok(notice && notice.hidden, 'import: no camera notice, because the still IS the source');
  ok(container.querySelectorAll('.sc-style').length >= 2, 'import: style row is live');
  const slots = [...bottomBar.querySelectorAll('.pt-slot')];
  ok(slots[0].textContent.trim() === 'BACK', `import: leftmost is BACK, got "${slots[0].textContent.trim()}"`);
  ok(slots[1].textContent.includes('USE'), `import: hero reads USE, got "${slots[1].textContent.trim()}"`);
  // And it commits to compose rather than back to paste.
  slots[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));  // the shutter clamp is 230ms
  ok(ctx.navigated === 'compose', `import: USE goes to compose, got ${ctx.navigated}`);
  ok(getSubject() && getSubject().source === 'library', 'import: the subject keeps its library provenance');
  if (screen.unmount) screen.unmount();
}

// --- settings --------------------------------------------------------------
{
  await mount('settings');
  ok(container.querySelector('.sc-set'), 'settings: root exists');
  ok([...container.querySelectorAll('.sc-set-head')].map(e=>e.textContent).includes('OFFLINE'), 'settings: offline section');
  ok(container.querySelector('.sc-set-link'), 'settings: links onward to charsets / size test');
  ok(bottomBar.children.length === 0, 'settings: no action bar, the header back is enough');
}

console.log(fail.length ? `smoke: ${fail.length} FAILED\n  ` + fail.join('\n  ') : 'smoke: every screen mounts and builds what it claims to');
process.exit(fail.length ? 1 : 0);
