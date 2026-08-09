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

// ---------------------------------------------------------------------------
// LOOKING FOR A NEW BUILD, which is a different question from verify().
// Added 2026-08-09.
//
// verify() asks the CURRENT controller to audit ITS OWN cache. It answers "is
// the build I am running complete", and it is the right question for the
// offline readout, which is about surviving a flight. It cannot answer "is
// there a newer build", because the controller does not know one exists.
//
// Nothing in the app asked the second question. The consequence, reported from
// a phone: a deployed update never arrived, and the button in settings labelled
// CHECK AGAIN could not have found it, because it called verify().
//
// registration.update() is the question. It refetches sw.js, byte-compares, and
// installs a new worker if the bytes differ -- which is also why
// build-precache.js now stamps the version into sw.js itself. Without that
// stamp sw.js is identical between builds and only the imported manifest moves.
//
// Throttled, because this is called on every return to the foreground and an
// app-switch is not a rare event. The window is deliberately short: the cost of
// a check is one conditional request, and the cost of missing one is the bug
// this exists to fix.
const UPDATE_THROTTLE_MS = 30_000;
let lastUpdateCheck = 0;

export function checkForUpdate({ force = false } = {}) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return Promise.resolve(false);
  const now = Date.now();
  if (!force && now - lastUpdateCheck < UPDATE_THROTTLE_MS) return Promise.resolve(false);
  lastUpdateCheck = now;
  return navigator.serviceWorker.getRegistration()
    .then((reg) => (reg ? reg.update().then(() => true) : false))
    // An update check fails on any network the app is designed to be used
    // without. That is not an error state: the installed build still works, and
    // the readout already says so.
    .catch(() => false);
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
//
// AND THEN THE PAGE HAS TO RELOAD. Added 2026-08-09.
//
// This used to be the postMessage alone, and that half of the job is the half
// that is invisible. skipWaiting() plus the clients.claim() in sw.js's activate
// handler makes the NEW worker control this page immediately -- so the version
// in the readout changes, the offline state goes green, and every module the
// app is actually executing is still the old build, because it was imported
// into memory before any of this happened and nothing re-imports it.
//
// The user taps a button called APPLY UPDATE, watches the version number
// change, and gets the same app. That is a worse failure than the update not
// arriving at all, because it looks like it worked.
//
// The reload is armed BEFORE the message goes out, once, on controllerchange.
// `reloading` guards the classic loop: controllerchange also fires on the very
// first load when a worker takes control of a page that had none, and reloading
// there would put the app in a refresh cycle on first run.
let reloading = false;
export function applyUpdate() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }, { once: true });
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
  //
  // updateViaCache: 'none' is the one that was missing, and it is why a
  // deployed update did not reach a phone. Added 2026-08-09.
  //
  // The default is 'imports': the browser bypasses the HTTP cache when it
  // refetches sw.js for an update check, but serves anything sw.js pulls in
  // with importScripts() from the HTTP cache like an ordinary subresource. What
  // sw.js pulls in is app/precache-manifest.classic.js, and that file is where
  // the version lives -- sw.js's own bytes are the same in every build. So the
  // update check refetched the one file that never changes and read the version
  // out of the HTTP cache, concluded nothing had moved, and threw away the new
  // build. Pages serves assets with a short max-age, so this closed the window
  // by minutes rather than forever, but combined with nothing ever CALLING an
  // update check it was indistinguishable from forever.
  //
  // 'none' takes both files off the HTTP cache for update purposes. It costs
  // one conditional request per check, on a check that happens at most twice a
  // minute, and only ever for the two smallest files in the app.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    const noteWaiting = () => { if (reg.waiting) patch({ update: true }); };
    noteWaiting();
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') { noteWaiting(); run(); }
      });
    });
    // One check on load, past the throttle. A cold start is the moment the user
    // is most likely to be on a network and least likely to mind the request.
    checkForUpdate({ force: true });
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
  //
  // checkForUpdate() as well as run(), added 2026-08-09. run() only audits the
  // build already installed; on its own this handler could never notice a new
  // one. That mattered more here than anywhere else in the app: the browser
  // looks for a new worker on NAVIGATION, this app is hash-routed so it never
  // issues one after the first load, and resuming an installed PWA from the app
  // switcher is not a navigation either. An installed Plane Text could run for
  // weeks without the browser ever asking whether a newer build existed.
  //
  // checkForUpdate throttles itself, so flicking between apps costs nothing.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    run();
    checkForUpdate();
  });

  run();
}
