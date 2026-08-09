/* Plane Text: the service worker.
 *
 * At the repo root, not in app/. A worker's scope is the directory it is served
 * from, and app/ excludes index.html, so the one navigation that matters would
 * never be controlled. Service-Worker-Allowed can widen a scope; GitHub Pages
 * will not send it.
 *
 * A classic script, because importScripts() cannot load an ES module and a
 * module worker needs Safari 16.4+. build-precache.js emits a classic twin of
 * the manifest for this.
 *
 * It does not skipWaiting on install. The app is a graph of ES modules; a
 * worker activating mid-session would serve some modules new and some cached
 * old, running the app as a mixture of two builds.
 */

/* eslint-env serviceworker */

// @build pt-53915b62074e

importScripts('app/precache-manifest.classic.js');

// The cache name is the version. build-precache.js hashes file contents, so a
// new version means a new cache and activate deletes the old one.
var CACHE = self.PRECACHE_VERSION;

// Where a shared message waits between the POST and the app reading it. Fixed
// name so the page can open it without knowing the build version, and exempt
// from the activate sweep because a share can arrive mid-install.
var INBOX = 'pt-inbox-v1';
var INBOX_KEY = 'message';

// Resolved against the worker, never against '/': the origin root is not the
// app root on GitHub Pages.
function precacheUrls() {
  return self.PRECACHE.map(function (p) { return new URL(p, self.location).href; });
}

function shellUrl() {
  return new URL('index.html', self.location).href;
}

// addAll is atomic: one failed request and the worker never installs. A
// partially precached app that installs cleanly is the green-tick-that-lies
// failure the generated manifest exists to prevent.
//
// cache: 'reload' stops a stale HTTP entry being promoted into the precache
// under a version string describing a build that was never assembled.
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(precacheUrls().map(function (url) {
        return new Request(url, { cache: 'reload' });
      }));
    }),
  );
});

// Only caches named pt-* are ours. github.io is a shared origin.
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name !== CACHE && name !== INBOX && name.indexOf('pt-') === 0) return caches.delete(name);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    }),
  );
});

// Cache first. Every file the app needs is precached by construction, so a miss
// on a same-origin GET means either a file nobody ran `npm run precache` for or
// a request the app does not make. Neither wants a round trip on a cabin
// network that will hang rather than fail.
//
// Cross-origin and non-GET pass through. There are no third-party requests; if
// one appears it should be visible rather than silently served.
self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);

  // The share target is a POST (spec 5.5), so this handler is mandatory. A GET
  // target would put a 15,000 character message in the query string and in
  // browser history, and a worker ignoring the POST makes sharing do nothing.
  if (request.method === 'POST' && url.pathname === new URL('share', self.location).pathname) {
    event.respondWith(receiveShare(request));
    return;
  }

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // A navigation is always the shell. The route lives in the hash, which the
  // browser never sends.
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
      // Not precached. Try the network; a synthesised response would let a
      // missing module look like an empty one.
      return hit || fetch(request);
    }),
  );
});

// Stash the shared text and redirect in.
//
// 303 is what turns the POST into a GET; without it the browser re-issues the
// POST against the landing URL. A cache rather than postMessage because the
// share is what launched the app, so there is no client to message yet.
function receiveShare(request) {
  var landing = new URL('index.html#/paste', self.location).href;
  return request.formData().then(function (form) {
    // `url` is the fallback: some Android share sheets classify a long string
    // containing a link as a URL, and the wrapper's markup contains one.
    var text = form.get('text') || form.get('url') || '';
    if (!text) return null;
    return caches.open(INBOX).then(function (cache) {
      return cache.put(INBOX_KEY, new Response(String(text), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }));
    });
  }).catch(function (err) {
    // Dropping the payload and opening the Open screen beats a browser error
    // page.
    console.error('sw: share target failed', err);
  }).then(function () {
    return Response.redirect(landing, 303);
  });
}

// VERIFY, which the offline readout is built on.
//
// Two checks, catching different failures. By name catches a file added to the
// tree but never precached: the cache is full and the app is broken. The
// no-network probe catches a worker installed but not controlling, which is the
// state on the very first load, where the cache is perfect and nothing is
// intercepting.
//
// only-if-cached with mode same-origin resolves from the HTTP cache or rejects,
// so it never touches the network.
self.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'PT_VERIFY') return;

  var reply = event.ports && event.ports[0];
  if (!reply) return;

  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var wanted = self.PRECACHE;
      return Promise.all(precacheUrls().map(function (url) {
        return cache.match(url).then(function (hit) { return Boolean(hit); });
      })).then(function (present) {
        var missing = [];
        for (var i = 0; i < present.length; i += 1) if (!present[i]) missing.push(wanted[i]);
        return missing;
      });
    }).then(function (missing) {
      // A rejection here is the answer, not an error.
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

// The page's call, from settings, never automatic. See the header.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'PT_ACTIVATE_UPDATE') self.skipWaiting();
});
