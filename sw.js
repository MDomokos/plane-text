/* Plane Text: the service worker. Written 2026-08-09.
 *
 * This is the file the whole product rests on. Everything else in the app is
 * cosmetic next to it: without a service worker Plane Text is an online web
 * page, and the premise of Plane Text is that you are on an aircraft with a
 * network that passes text and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES AT THE ROOT AND NOT IN app/
 *
 * A service worker's default scope is the directory it is served from. At
 * app/sw.js the scope is /plane-text/app/, which does not contain index.html,
 * so the shell itself would never be controlled and the one navigation that
 * matters would always hit the network. The Service-Worker-Allowed header can
 * widen a scope; GitHub Pages will not send it. So the file goes beside
 * index.html and tools/build-precache.js excludes it from its own walk.
 *
 * app/main.js registers it as 'sw.js', relative, which resolves against the
 * DOCUMENT's base URL rather than against app/main.js. On GitHub Pages that is
 * /plane-text/sw.js. A leading slash would be /sw.js and 404.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A CLASSIC SCRIPT
 *
 * importScripts() cannot load an ES module, and a module service worker needs
 * Safari 16.4+. iOS Safari is the platform this app cannot afford to lose --
 * it is the one with no Web Share Target, so it is already the worst receiving
 * experience, and it is a large share of the people who will install this
 * before a flight. tools/build-precache.js emits two manifests from one walk
 * for exactly this reason; this file reads the classic one.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT skipWaiting()
 *
 * The app is a graph of ES modules that import each other by URL. A worker
 * that activates mid-session while the page is running serves the new version
 * of some modules and the cached-in-memory old version of others, and the app
 * runs as a mixture of two builds. That failure is invisible until it is not.
 *
 * So a new worker installs, precaches, and waits. The page is told, and the
 * update lands on the next cold start. This is also what makes "fully cached"
 * and "current" two different states rather than one tick, per the 2026-08-09
 * decision -- and why VERIFY below reports a version string.
 */

/* eslint-env serviceworker */

importScripts('app/precache-manifest.classic.js');

// The cache name IS the version. build-precache.js hashes the contents of
// every listed file, so it changes when any of them changes and only then.
// A new version therefore means a new cache, and activate deletes the old one.
var CACHE = self.PRECACHE_VERSION;

// Absolute URLs, resolved against the worker's own location. Never against
// '/': the origin root is not the app root on GitHub Pages.
function precacheUrls() {
  return self.PRECACHE.map(function (p) { return new URL(p, self.location).href; });
}

// The app shell. Every navigation resolves to this, whatever the path, because
// routing is hash-based and the hash never reaches the server or the worker.
function shellUrl() {
  return new URL('index.html', self.location).href;
}

// ---------------------------------------------------------------------------
// Install: fill the cache, then wait.
//
// cache.addAll() is atomic -- one failed request rejects the whole thing and
// the worker never installs. That is the behaviour we want. A partially
// precached app that installs successfully is the green-tick-that-lies failure
// build-precache.js exists to prevent, one layer down.
//
// The requests are made with cache: 'reload' so a stale HTTP cache entry
// cannot be promoted into the precache. Without it a file the browser happens
// to hold from before the deploy is cached under the new version's name, and
// the version string then describes a build that was never assembled.
// ---------------------------------------------------------------------------
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(precacheUrls().map(function (url) {
        return new Request(url, { cache: 'reload' });
      }));
    }),
  );
});

// ---------------------------------------------------------------------------
// Activate: drop every other cache, then take over.
//
// Only caches whose name starts with 'pt-' are ours. Deleting anything else
// would be this app reaching into another app's storage on a shared origin,
// which github.io very much is.
// ---------------------------------------------------------------------------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE && name.indexOf('pt-') === 0) return caches.delete(name);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

// ---------------------------------------------------------------------------
// Fetch.
//
// Cache-first, and for this app that is not a trade-off -- it is the point.
// Every file the app needs is in the precache by construction, so a cache miss
// on a same-origin GET means either a file nobody ran `npm run precache` for,
// or a request the app does not make. Neither wants a network round trip on a
// cabin network that will hang rather than fail.
//
// Three things are deliberately NOT handled here:
//
//   - Non-GET. There is no server and nothing to POST to. Pass through.
//   - Cross-origin. There are no third-party requests; if one appears it is a
//     bug and it should be visible in the network panel rather than silently
//     served or silently swallowed.
//   - Range requests. No media, so no partial responses to get wrong.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A navigation is always the shell. The route lives in the hash, which the
  // browser never sends, so there is nothing to route on here and nothing that
  // could need a different document.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(shellUrl()).then(function (hit) {
        return hit || fetch(request);
      }).catch(function () {
        return fetch(request);
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      // Not precached. Try the network, and if that fails there is nothing
      // honest left to return: an opaque or synthesised response would let a
      // missing module look like an empty one.
      return fetch(request);
    }),
  );
});

// ---------------------------------------------------------------------------
// VERIFY: the message the offline readout is built on.
//
// The 2026-08-09 decision is that the readout must verify every precache entry
// BY NAME, plus one no-network fetch of index.html, and report a version string
// rather than a tick. Both halves matter and they catch different failures:
//
//   By name    catches a file that was added to the tree but never precached.
//              The cache is "full" and the app is broken. This is the failure
//              a hand-maintained list fails open on.
//   No-network catches a worker that is installed but not CONTROLLING this
//              page, which is the state on the very first load before a
//              reload. The cache is perfect and the app still dies offline,
//              because nothing is intercepting.
//
// The second check is a real fetch of the shell with cache: 'only-if-cached'
// and mode: 'same-origin', which the platform resolves from the HTTP cache or
// rejects. It never touches the network by construction.
// ---------------------------------------------------------------------------
self.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'PT_VERIFY') return;

  var reply = event.ports && event.ports[0];
  if (!reply) return;

  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var wanted = self.PRECACHE;
      var urls = precacheUrls();
      return Promise.all(urls.map(function (url) {
        return cache.match(url).then(function (hit) { return Boolean(hit); });
      })).then(function (present) {
        var missing = [];
        for (var i = 0; i < present.length; i += 1) if (!present[i]) missing.push(wanted[i]);
        return missing;
      });
    }).then(function (missing) {
      // The no-network probe. A rejection here is the answer, not an error.
      return fetch(new Request(shellUrl(), { cache: 'only-if-cached', mode: 'same-origin' }))
        .then(function (res) { return { missing: missing, shell: res.ok }; })
        .catch(function () { return { missing: missing, shell: false }; });
    }).then(function (result) {
      reply.postMessage({
        type: 'PT_VERIFY_RESULT',
        version: CACHE,
        ready: result.missing.length === 0 && result.shell,
        missing: result.missing,
        shell: result.shell,
        checkedAt: Date.now(),
      });
    }).catch(function (err) {
      reply.postMessage({
        type: 'PT_VERIFY_RESULT',
        version: CACHE,
        ready: false,
        missing: [],
        shell: false,
        error: String(err),
        checkedAt: Date.now(),
      });
    }),
  );
});

// The one thing that may activate a waiting worker, and it is the page's call,
// not this file's. app/main.js sends it when the user asks for the update from
// the settings screen -- never automatically, for the mixed-build reason at the
// top of this file.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'PT_ACTIVATE_UPDATE') self.skipWaiting();
});
