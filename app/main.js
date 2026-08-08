// Plane Text: bootstrap. The only file that touches the shell's own elements.
//
// It imports the screens, builds the per-screen context, and starts the
// router. Keep it to that.

import { start, navigate, DEFAULT_ROUTE } from './router.js';
import { store } from './state.js';
import './screens/index.js';

const container = document.getElementById('app-screen');
const bottomBar = document.getElementById('app-bottom');
const titleEl = document.getElementById('app-title');
const backEl = document.getElementById('app-back');

backEl.addEventListener('click', () => {
  if (history.length > 1) history.back();
  else navigate(DEFAULT_ROUTE, null, { replace: true });
});

start({
  container,
  createContext({ route, signal, screen }) {
    // The frame is reset here, before mount(), so a screen always starts from
    // the same state whatever the previous one did.
    bottomBar.replaceChildren();
    titleEl.textContent = screen.title;
    backEl.hidden = route.path === DEFAULT_ROUTE;
    document.body.dataset.route = route.path;

    return {
      state: store,
      route,
      navigate,
      signal,
      bottomBar,
      setTitle(text) { titleEl.textContent = text; },
    };
  },
});

// ---------------------------------------------------------------------------
// Service worker. Owned by the offline-shell agent, and this is where it goes.
//
// Register sw.js from here, with a relative URL ('sw.js', never '/sw.js'), so
// the scope lands on the GitHub Pages sub-path. Report status into
// state.offline: { ready, version, checkedAt }. The header slot
// (#app-header-slot) and the settings readout are yours.
//
// Per the 2026-08-09 decision: verify every precache entry by name, plus one
// no-network fetch of index.html, and report a version string rather than a
// tick. Silent update-on-load means "fully cached" and "current" are different
// states. PRECACHE and PRECACHE_VERSION come from ./precache-manifest.js,
// which is generated. Do not hand-maintain a list.
// ---------------------------------------------------------------------------
