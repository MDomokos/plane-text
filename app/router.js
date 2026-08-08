// Plane Text: hash routing.
//
// Hash, not History. Two structural reasons:
//   - The origin is GitHub Pages at a sub-path (/plane-text/). A path route
//     needs a server rewrite, and there is no server.
//   - The app has to open from file:// during development and from a saved
//     copy. location.pathname is meaningless there. location.hash is not.
// Nothing in this file reads location.pathname or location.origin, and nothing
// should start.
//
// The router does not import screens. Screens import `register` and register
// themselves, and app/screens/index.js is the one list of imports. That keeps
// the four screen agents out of each other's diffs.

const routes = new Map();

export const DEFAULT_ROUTE = 'capture';

// The v1 route table (spec 5). Registering a path that is not on this list is
// allowed, since a screen may add sub-routes. But every path here must have a
// screen, and a test asserts it.
export const V1_ROUTES = [
  'capture',
  'compose',
  'paste',
  'settings',
  'settings/size-test',
  'settings/charsets',
];

export function register(screen) {
  if (!screen || typeof screen.mount !== 'function' || typeof screen.id !== 'string') {
    throw new Error('register: expected a screen from defineScreen()');
  }
  if (routes.has(screen.id)) throw new Error(`register: route "${screen.id}" is already taken`);
  routes.set(screen.id, screen);
  return screen;
}

export function resolve(path) {
  return routes.get(path) || null;
}

export function registered() {
  return [...routes.keys()].sort();
}

// '#/settings/size-test?n=2' -> { path: 'settings/size-test', params: { n: '2' } }
// Pure, and exported so it can be tested in Node without a DOM.
export function parseHash(hash = '') {
  const raw = String(hash).replace(/^#/, '');
  const cut = raw.indexOf('?');
  const pathPart = cut === -1 ? raw : raw.slice(0, cut);
  const queryPart = cut === -1 ? '' : raw.slice(cut + 1);
  const path = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  const params = {};
  for (const [k, v] of new URLSearchParams(queryPart)) params[k] = v;
  return { path: path || DEFAULT_ROUTE, params };
}

export function href(path, params = null) {
  const q = params ? new URLSearchParams(params).toString() : '';
  return `#/${path}${q ? `?${q}` : ''}`;
}

export function navigate(path, params = null, { replace = false } = {}) {
  const target = href(path, params);
  if (replace) window.location.replace(target);
  else window.location.hash = target;
}

// ---------------------------------------------------------------------------
// The live router. Everything above this line is pure.
// ---------------------------------------------------------------------------

let host = null;
let activeScreen = null;
let activeCtrl = null;
let activeRoute = null;
let token = 0;

export function current() {
  return activeRoute;
}

// host: { container, createContext({ route, signal, screen }) -> ctx,
//         afterMount?({ route, screen }) }
//
// afterMount runs once the screen has mounted successfully. It exists for the
// things that can only happen after the new DOM is in place, and there is
// exactly one class of those: telling the user the screen changed. Added
// 2026-08-09. Until then the router replaced the container's children and
// nothing moved focus, so a keyboard or screen-reader user was returned to the
// top of the document with no announcement on every single navigation. The
// container carries tabindex="-1" for precisely this purpose and nothing was
// using it.
//
// It is a host hook rather than router code because the announcement is a
// shell concern: main.js owns the shell's elements, and the router does not
// know that a live region exists.
export function start(options) {
  if (!options || !options.container || typeof options.createContext !== 'function') {
    throw new Error('start: needs { container, createContext }');
  }
  if (!routes.has(DEFAULT_ROUTE)) {
    throw new Error(`start: the default route "${DEFAULT_ROUTE}" has no screen. Is app/screens/index.js imported?`);
  }
  host = options;
  window.addEventListener('hashchange', () => { render(); });
  return render();
}

async function teardown() {
  if (activeCtrl) activeCtrl.abort();
  const screen = activeScreen;
  activeScreen = null;
  activeCtrl = null;
  if (screen && screen.unmount) {
    // A throwing unmount must not strand the app on a blank screen.
    try { await screen.unmount(); } catch (err) { console.error(`unmount(${screen.id})`, err); }
  }
}

async function render() {
  const mine = ++token;
  const route = parseHash(window.location.hash);
  const screen = resolve(route.path);
  if (!screen) {
    navigate(DEFAULT_ROUTE, null, { replace: true });
    return;
  }

  await teardown();
  if (mine !== token) return; // navigated again while unmounting

  const ctrl = new AbortController();
  activeCtrl = ctrl;
  activeScreen = screen;
  activeRoute = route;

  host.container.replaceChildren();
  const ctx = host.createContext({ route, signal: ctrl.signal, screen });

  try {
    await screen.mount(host.container, ctx);
  } catch (err) {
    console.error(`mount(${screen.id})`, err);
    if (mine === token) host.container.textContent = 'This screen failed to load.';
  }

  // Still the current navigation? A screen that awaited something slow may
  // have been superseded, and announcing a screen the user has already left is
  // worse than not announcing at all.
  if (mine !== token) return;
  if (host.afterMount) {
    try { host.afterMount({ route, screen }); } catch (err) { console.error('afterMount', err); }
  }
}
