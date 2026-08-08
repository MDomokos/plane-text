// Plane Text: bootstrap. The only file that touches the shell's own elements.
//
// It imports the screens, builds the per-screen context, starts the router, and
// starts the offline shell. Keep it to that.

import { start, navigate, DEFAULT_ROUTE } from './router.js';
import { store } from './state.js';
import { startOffline, takeInbox } from './offline.js';
import { setSharedText } from './pipeline.js';
import './screens/index.js';

const container = document.getElementById('app-screen');
const bottomBar = document.getElementById('app-bottom');
const titleEl = document.getElementById('app-title');
const backEl = document.getElementById('app-back');
const headerSlot = document.getElementById('app-header-slot');
const liveEl = document.getElementById('app-live');

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
    // The save sheet (compose.js) dims the bar with an inline style, and
    // replaceChildren does not clear a style on the host. Without this,
    // leaving a screen with an open sheet leaves the next screen's bar dimmed
    // and inert, which reads as a frozen app.
    bottomBar.style.filter = '';
    bottomBar.style.pointerEvents = '';
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

  // Navigation, announced and focused. See router.js for why it is a host hook.
  //
  // Focus lands on the container rather than the first control, which would put
  // a keyboard user somewhere arbitrary and raise the on-screen keyboard if it
  // happened to be a field. This is what tabindex="-1" in index.html is for.
  //
  // preventScroll matters on the picture screens: focusing the sized grid item
  // can otherwise nudge a stage that is meant to be pinned.
  afterMount({ screen }) {
    container.focus({ preventScroll: true });
    // aria-live announces on change, so a replace-navigate to the same route
    // would say nothing. The trailing space toggle is the way round it.
    const said = `${screen.title} screen`;
    liveEl.textContent = liveEl.textContent === said ? `${said} ` : said;
  },
});

// The offline shell. Registration, verification and the readout live in
// app/offline.js; the slot is passed in so this stays the only file touching a
// shell element.
startOffline({ store, slot: headerSlot });

// A share target arrival. The worker took the POST body, stashed it and 303'd
// to #/paste. The redirect usually lands us there; the navigate covers a cold
// start whose hash was rewritten by something else.
//
// After the router starts, because blocking first paint on a cache read would
// cost every launch for a case that only happens on Android.
takeInbox().then((text) => {
  if (!text) return;
  setSharedText(text);
  // Not straight to `compose`: the decode can fail, and paste is the screen
  // that knows how to say so (spec 8).
  if (!window.location.hash.includes('paste')) navigate('paste', null, { replace: true });
  else window.dispatchEvent(new HashChangeEvent('hashchange'));
});
