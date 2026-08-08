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

for (const k of ['window','document','navigator','location','history','localStorage','HTMLElement','Element','Node','CustomEvent','Event','MessageChannel','ImageData','Blob','URL','requestAnimationFrame','cancelAnimationFrame','ResizeObserver','matchMedia','getComputedStyle','devicePixelRatio','queueMicrotask']) {
  if (!(k in window)) continue;
  try { globalThis[k] = window[k]; }
  catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); }
}
globalThis.self = window;

const fail = [];
const ok = (cond, msg) => { if (!cond) fail.push(msg); };

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
  if (screen.unmount) screen.unmount();
}

// --- paste -----------------------------------------------------------------
{
  await mount('paste');
  ok(container.querySelector('.sc-open'), 'paste: root exists');
  ok(container.querySelector('.sc-recent-label'), 'paste: RECENT label always renders');
  ok(container.querySelector('.sc-recent-empty'), 'paste: empty state renders when there is nothing');
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

  const { screen } = await mount('compose');
  const root = container.querySelector('.sc-view');
  ok(root && root.classList.contains('app-frame'), 'compose: builds the shell frame');
  const kids = [...root.children].map((e) => e.className.split(' ')[0]);
  ok(kids[0].startsWith('app-chrome-top') && kids[1] === 'app-stage' && kids[2].startsWith('app-chrome-bot'),
     `compose: band order is ${kids.join(' / ')}`);
  ok(container.querySelector('.sc-view-art').textContent.length > 100, 'compose: art actually painted');
  const slider = container.querySelector('.sc-view-slider');
  ok(slider && !slider.hidden, 'compose: slider shown for one of yours');
  ok(container.querySelectorAll('.sc-tick').length >= 3, 'compose: slider ticks rendered');
  ok([...container.querySelectorAll('.sc-tick.is-device')].length === 1, 'compose: exactly one device marker in range');
  ok(container.querySelector('.sc-strip'), 'compose: carousel strip');
  ok(container.querySelector('.sc-strip-thumb'), 'compose: at least one carousel entry (the live one)');
  ok(container.querySelector('.sc-strip-del'), 'compose: per-entry delete');
  ok(bottomBar.querySelectorAll('.pt-slot').length === 3, 'compose: three action slots');

  // the save sheet, including the row that used to be a console.warn
  const save = [...bottomBar.querySelectorAll('.pt-slot')][1];
  save.dispatchEvent(new window.Event('click', { bubbles: true }));
  const rows = [...container.querySelectorAll('.sc-sheet-row .sc-sheet-ext')].map((e) => e.textContent);
  ok(rows.join(',') === 'TXT,HTML,PNG', `compose: save sheet rows are ${rows.join(',')}`);
  container.querySelector('.sc-sheet-cancel').dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(!container.querySelector('.sc-sheet'), 'compose: sheet closes');
  ok(bottomBar.style.pointerEvents === '', 'compose: action bar re-enabled after the sheet closes');
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
  const slider = container.querySelector('.sc-view-slider');
  ok(slider.hidden, 'compose: no slider for a received message');
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
