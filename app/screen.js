// Plane Text: the screen contract.
//
// This is the file the other screen agents code against. Everything else in
// app/ is frame. This is the interface.
//
// A screen is a plain object:
//
//   defineScreen({
//     id:    'capture',            // its route path, exactly
//     title: 'Capture',            // what the header shows
//     mount(el, ctx) {},           // required. may be async.
//     unmount() {},                // optional. cleanup a signal can't do.
//   })
//
// Lifecycle, stated once so four agents implement the same one:
//
//   1. The router clears the screen container and the bottom bar.
//   2. mount(el, ctx) is called with an empty el. If it returns a promise the
//      router awaits it. A navigation during that await is honoured and the
//      late mount is discarded.
//   3. On navigation, ctx.signal aborts first, then unmount() is called.
//
// A screen object is a singleton, created once at module load and reused for
// every visit. Do not keep per-visit state on it. Keep it in closures created
// inside mount(), or in the store.
//
// Cleanup has one mechanism: ctx.signal.
//
//   el.addEventListener('click', f, { signal: ctx.signal })
//   ctx.state.subscribe(f, { signal: ctx.signal })
//   ctx.signal.addEventListener('abort', () => track.stop())
//
// Anything with a `signal` option takes ctx.signal. unmount() exists only for
// things that have no signal option: a camera MediaStream, a worker, a
// requestAnimationFrame handle. A cleanup function returned from mount() is
// ignored. There is no second convention.
//
// The context (ctx). Six keys, and the list is closed:
//
//   ctx.state        the store from ./state.js. get() / set() / subscribe().
//   ctx.route        { path, params }. params are strings from the hash query.
//   ctx.navigate     navigate(path, params?, { replace? })
//   ctx.signal       AbortSignal, aborted just before this screen goes away.
//   ctx.bottomBar    HTMLElement. Empty on mount. Fill it or ignore it.
//   ctx.setTitle     setTitle(text). The header already shows screen.title.
//
// DOM rules, since there is no framework to enforce them:
//   - Build into `el`. Reach outside it only through ctx.bottomBar.
//   - Never touch #app-header-slot. The offline-shell agent owns it.
//   - Style with the tokens in tokens.css. A screen that needs component CSS
//     ships its own app/screens/<id>.css and links it from index.html. See
//     SHELL.md, and add it to the precache like any other file.

const KNOWN_KEYS = new Set(['id', 'title', 'mount', 'unmount']);

export function defineScreen(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('defineScreen: needs an object');
  for (const key of Object.keys(spec)) {
    // Typos are the failure mode this catches. `unMount` silently never runs,
    // and a camera left streaming behind a hidden screen is expensive.
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`defineScreen: unknown key "${key}" (allowed: ${[...KNOWN_KEYS].join(', ')})`);
    }
  }
  const { id, title, mount, unmount = null } = spec;
  if (typeof id !== 'string' || !id) throw new Error('defineScreen: id must be a non-empty string');
  if (typeof title !== 'string' || !title) throw new Error(`defineScreen(${id}): title must be a non-empty string`);
  if (typeof mount !== 'function') throw new Error(`defineScreen(${id}): mount must be a function`);
  if (unmount !== null && typeof unmount !== 'function') {
    throw new Error(`defineScreen(${id}): unmount must be a function or absent`);
  }
  return { id, title, mount, unmount };
}

// A screen that renders its own name and nothing else.
//
// Every route ships as one of these until its agent replaces it. Keeping the
// stub to one line means the diff of a real implementation is the screen and
// nothing else.
export function stubScreen(id, title) {
  return defineScreen({
    id,
    title,
    mount(el) {
      const h = document.createElement('h2');
      h.className = 'screen-stub';
      h.textContent = title;
      el.append(h);
    },
  });
}
