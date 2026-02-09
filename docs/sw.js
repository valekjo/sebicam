// Sebicam Service Worker — Cache-first with background version check
// This file uses plain JS (no ES modules) as required by service workers.

var ASSETS = [
  './',
  'index.html',
  'broadcaster.html',
  'viewer.html',
  'css/styles.css',
  'js/broadcaster.js',
  'js/viewer.js',
  'js/webrtc-common.js',
  'js/data-channel.js',
  'js/sdp-codec.js',
  'lib/qrcode.min.js',
  'lib/html5-qrcode.min.js',
  'version.json'
];

var CACHE_PREFIX = 'sebicam-v';

function cacheName(version) {
  return CACHE_PREFIX + version;
}

// --- Install: fetch version, precache all assets into versioned cache ---
self.addEventListener('install', function (event) {
  event.waitUntil(
    fetch('version.json', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var name = cacheName(data.version);
        return caches.open(name).then(function (cache) {
          return cache.addAll(ASSETS);
        });
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

// --- Activate: delete old caches, claim clients ---
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) {
          return k.startsWith(CACHE_PREFIX);
        }).map(function (k) {
          // Keep only the newest cache — find current version first
          return fetch('version.json', { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (k !== cacheName(data.version)) {
                return caches.delete(k);
              }
            });
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// --- Fetch: cache-first for same-origin, network-first for version.json ---
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Cross-origin requests: passthrough
  if (url.origin !== self.location.origin) return;

  // version.json: always go to network first
  if (url.pathname.endsWith('version.json')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(function () {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Everything else: cache-first
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request);
    })
  );
});

// --- Message handler: CHECK_UPDATE ---
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'CHECK_UPDATE') {
    fetch('version.json', { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var newName = cacheName(data.version);
        return caches.has(newName).then(function (exists) {
          if (exists) return; // Already have this version cached
          // New version: precache into new cache, notify clients
          return caches.open(newName)
            .then(function (cache) { return cache.addAll(ASSETS); })
            .then(function () {
              return self.clients.matchAll().then(function (clients) {
                clients.forEach(function (client) {
                  client.postMessage({
                    type: 'UPDATE_AVAILABLE',
                    version: data.version
                  });
                });
              });
            });
        });
      })
      .catch(function () {
        // Network unavailable — ignore silently
      });
  }
});
