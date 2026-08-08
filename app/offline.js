// Plane Text: the offline shell. Registration, verification, and the readout.
//
// The service worker itself is /sw.js at the repo root -- see the header of
// that file for why it is not in here and why it is a classic script. This
// module is the page's side of the conversation.
//
// It exists as its own file rather than inside main.js because main.js is "the
// only file that touches the shell's own elements", and keeping that true is
// worth more than keeping the registration next to the bootstrap. So the slot
// element is PASSED IN. This module never looks anything up.
//
// ---------------------------------------------------------------------------
// WHAT THE READOUT IS ALLOWED TO CLAIM
//
// The 2026-08-09 decision: verify every precache entry by name, plus one
// no-network fetch of index.html, and report a VERSION STRING rather than a
// tick. The reasoning was that silent update-on-load makes "fully cached" and
// "current" two different states, and a single tick collapses them.
//
// So there are four states and the readout names each one:
//
//   unsupported  no serviceWorker in navigator. file://, or a browser that
//                cannot do this. Say so; do not show a spinner forever.
//   caching      registered, not yet verified. The honest word during install.
//   ready        every entry present AND the shell resolves with no network.
//                Only this state may show the version.
//   incomplete   registered, and something is missing. Names the count, because
//                "not ready" with no number is not actionable and this is the
//                state that means the app will die at 30,000 feet.
//
// A fifth flag rides alongside: `update`, true when a new worker is installed
// and waiting. Deliberately not an error state. The app works; a newer one is
// sitting there, and activating it is the user's call from settings.
// ---------------------------------------------------------------------------

const VERIFY_TIMEOUT_MS = 5000;

// Ask the controlling worker to verify itself. Resolves to the result object
// or to null if there is nobody to ask.
//
// MessageChannel rather than a 'message' listener on navigator.serviceWorker,
// because the reply belongs to this request. A shared listener has to match
// replies to callers by hand, and gets it wrong the first time two screens ask
// at once.
function askWorker(worker, message) {
  return new Promise((resolve) => {
    if (!worker) { resolve(null); return; }
    const channel = new MessageChannel();
    // A worker that never replies must not leave the readout saying "caching"
    // forever. Five seconds is far longer than the check takes and short
    // enough that a wedged worker is visible rather than indistinguishable
    // from a slow one.
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

// Activate a waiting worker. The user's decision, made in settings, never
// automatic. See sw.js for the mixed-build failure this avoids.
export function applyUpdate() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (reg && reg.waiting) reg.waiting.postMessage({ type: 'PT_ACTIVATE_UPDATE' });
  });
}

// The one line the header slot and the settings screen both render from.
//
// Shared so the two cannot drift into describing the same state differently,
// which is the failure this codebase has recorded eight times in other shapes.
export function offlineLabel(offline) {
  if (!offline) return '';
  if (offline.state === 'unsupported') return 'no offline';
  if (offline.state === 'caching') return 'caching…';
  if (offline.state === 'incomplete') {
    const n = offline.missing ? offline.missing.length : 0;
    return n ? `offline: ${n} missing` : 'offline: not ready';
  }
  // Ready. The version is the payload -- it is the whole reason this is a
  // string and not a tick.
  return offline.update ? `${offline.version} · update ready` : String(offline.version || 'ready');
}

// ---------------------------------------------------------------------------
// start({ store, slot })
//
// Registers, wires the lifecycle, and keeps state.offline current. The slot is
// updated on every store change rather than written directly, so the settings
// screen reading the same field cannot disagree with the header.
// ---------------------------------------------------------------------------
export function startOffline({ store, slot }) {
  const paint = () => {
    if (slot) slot.textContent = offlineLabel(store.get().offline);
  };

  const patch = (next) => {
    // The store compares by reference, so a fresh object always notifies. That
    // is wanted here: `checkedAt` moves on every check even when nothing else
    // does, and settings shows it.
    store.set({ offline: { ...store.get().offline, ...next } });
    paint();
  };

  store.subscribe((_s, changed) => { if (changed.has('offline')) paint(); });

  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    // file://, or a browser without service workers. This is not an error and
    // it is not hidden: the app runs, and it will not survive a flight, and the
    // person who needs to know that is the person about to board.
    patch({ state: 'unsupported', ready: false, version: null, checkedAt: Date.now() });
    return;
  }

  patch({ state: 'caching', ready: false, checkedAt: Date.now() });

  const run = async () => {
    const result = await verify();
    if (!result) {
      // Registered but not controlling. This is the normal state on the very
      // first load: the worker installs, and nothing is intercepting until the
      // page is reloaded. Naming it 'caching' rather than 'incomplete' is
      // correct -- nothing is missing, the takeover simply has not happened.
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

  // Relative, and it resolves against the document, not against this module.
  // See sw.js: on GitHub Pages this is /plane-text/sw.js.
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
    // A failed registration is worth naming rather than swallowing: it is the
    // difference between "this app will work on a plane" and "it will not".
    console.error('offline: service worker registration failed', err);
    patch({ state: 'unsupported', ready: false, checkedAt: Date.now() });
  });

  // The worker taking control is the moment the app actually becomes offline
  // capable, and it happens after registration resolves. Re-verify then.
  navigator.serviceWorker.addEventListener('controllerchange', run);
  navigator.serviceWorker.ready.then(run);

  // And once more when the app is brought back to the foreground, which on a
  // phone is how most sessions start. Cheap, and it catches a worker that
  // finished installing while the app was backgrounded.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });

  run();
}
