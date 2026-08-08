// Plane Text: the page's side of the service worker.
//
// sw.js is at the repo root; see its header for why. The slot element is passed
// in rather than looked up, so main.js stays the only file touching a shell
// element.
//
// Four states, because silent update-on-load makes "fully cached" and "current"
// different things and one tick cannot say both:
//
//   unsupported  no serviceWorker. file://, or a browser that cannot.
//   caching      registered, not yet verified, or not yet controlling.
//   ready        every entry present and the shell resolves with no network.
//                Only this state shows a version.
//   incomplete   something is missing. Names the count, because this is the
//                state that means the app dies at 30,000 feet.
//
// `update` rides alongside: a newer worker is installed and waiting. Not an
// error. The app works, and activating is the user's call from settings.

const VERIFY_TIMEOUT_MS = 5000;

// MessageChannel rather than a listener on navigator.serviceWorker, so the
// reply belongs to this request. A shared listener has to match replies to
// callers by hand and gets it wrong the first time two screens ask at once.
function askWorker(worker, message) {
  return new Promise((resolve) => {
    if (!worker) { resolve(null); return; }
    const channel = new MessageChannel();
    // A wedged worker must not leave the readout saying "caching" forever.
    const timer = setTimeout(() => resolve(null), VERIFY_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data || null);
    };
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export function verify() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return Promise.resolve(null);
  return askWorker(navigator.serviceWorker.controller, { type: 'PT_VERIFY' });
}

// Collect a message the share target left. The worker took the POST body,
// stashed it and 303'd here. Read once and delete, or a share would re-open
// somebody's picture on the next launch.
const INBOX = 'pt-inbox-v1';
const INBOX_KEY = 'message';

export async function takeInbox() {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(INBOX);
    const hit = await cache.match(INBOX_KEY);
    if (!hit) return null;
    const text = await hit.text();
    await cache.delete(INBOX_KEY);
    return text || null;
  } catch {
    return null;
  }
}

// The user's call, from settings. See sw.js for the mixed-build failure.
export function applyUpdate() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (reg && reg.waiting) reg.waiting.postMessage({ type: 'PT_ACTIVATE_UPDATE' });
  });
}

// One line, shared by the header slot and settings, so the two cannot describe
// the same state differently.
export function offlineLabel(offline) {
  if (!offline) return '';
  if (offline.state === 'unsupported') return 'no offline';
  if (offline.state === 'caching') return 'caching…';
  if (offline.state === 'incomplete') {
    const n = offline.missing ? offline.missing.length : 0;
    return n ? `offline: ${n} missing` : 'offline: not ready';
  }
  return offline.update ? `${offline.version} · update ready` : String(offline.version || 'ready');
}

// Registers, wires the lifecycle, keeps state.offline current. The slot is
// repainted from the store rather than written directly, so settings and the
// header cannot disagree.
export function startOffline({ store, slot }) {
  const paint = () => {
    if (slot) slot.textContent = offlineLabel(store.get().offline);
  };

  const patch = (next) => {
    // A fresh object always notifies, which is wanted: checkedAt moves on every
    // check even when nothing else does, and settings shows it.
    store.set({ offline: { ...store.get().offline, ...next } });
    paint();
  };

  store.subscribe((_s, changed) => { if (changed.has('offline')) paint(); });

  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    // Not an error and not hidden. The app runs, it will not survive a flight,
    // and the person who needs to know is about to board.
    patch({ state: 'unsupported', ready: false, version: null, checkedAt: Date.now() });
    return;
  }

  patch({ state: 'caching', ready: false, checkedAt: Date.now() });

  const run = async () => {
    const result = await verify();
    if (!result) {
      // Registered but not controlling, which is normal on the first load.
      // Nothing is missing, the takeover has not happened, so this is caching
      // rather than incomplete.
      patch({ state: 'caching', ready: false, checkedAt: Date.now() });
      return;
    }
    patch({
      state: result.ready ? 'ready' : 'incomplete',
      ready: Boolean(result.ready),
      version: result.version || null,
      missing: result.missing || [],
      shell: Boolean(result.shell),
      checkedAt: result.checkedAt || Date.now(),
    });
  };

  // Relative, resolving against the document rather than this module. On GitHub
  // Pages that is /plane-text/sw.js.
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const noteWaiting = () => { if (reg.waiting) patch({ update: true }); };
    noteWaiting();
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') { noteWaiting(); run(); }
      });
    });
  }).catch((err) => {
    // Named rather than swallowed: this is the difference between the app
    // working on a plane and not.
    console.error('offline: service worker registration failed', err);
    patch({ state: 'unsupported', ready: false, checkedAt: Date.now() });
  });

  // Taking control is the moment the app becomes offline capable, and it
  // happens after registration resolves.
  navigator.serviceWorker.addEventListener('controllerchange', run);
  navigator.serviceWorker.ready.then(run);

  // And on return to the foreground, which on a phone is how most sessions
  // start. Catches a worker that finished installing while backgrounded.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });

  run();
}
