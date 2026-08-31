/**
 * Deliberately small. Its jobs are to make the app installable, to make it open
 * instantly on a repeat visit, and to catch files shared to it from the system share
 * sheet — not to run the app offline, which is meaningless for a tool whose whole
 * purpose is talking to another device.
 *
 * The caching rules are picked so a stale page can never be served to someone online:
 * documents always go to the network first, and only content-hashed build assets are
 * served from the cache, which is safe because a new build changes their names.
 */

const CACHE = "gsend-v1";

/**
 * Holds files handed over by the share sheet. A share arrives as a POST that the page
 * cannot see, so the bytes are parked here and the page collects them after the
 * redirect. Never evicted with the asset cache: it holds someone's file.
 */
const SHARE_CACHE = "gsend-share";
const SHARE_MANIFEST = "/__share/manifest";

const KEEP = new Set([CACHE, SHARE_CACHE]);

self.addEventListener("install", () => {
  // Take over as soon as possible rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !KEEP.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (request.method === "POST" && url.pathname === "/share") {
    event.respondWith(receiveShare(request));
    return;
  }

  if (request.method !== "GET") return;

  // Signalling and counters must always be live.
  if (url.pathname.startsWith("/api/")) return;

  // The page reads the parked share through this, so it must not touch the network.
  if (url.pathname.startsWith("/__share/")) {
    event.respondWith(readShare(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Build output is content-hashed, so a cached copy can never be the wrong version.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * The share sheet POSTs here. Park the payload, then redirect to the app, which is the
 * only way the page gets to see files it was never navigated with.
 */
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((entry) => entry instanceof File);
    const text = ["title", "text", "url"]
      .map((field) => form.get(field))
      .filter((value) => typeof value === "string" && value.trim() !== "")
      .join("\n");

    const cache = await caches.open(SHARE_CACHE);
    // Only one share can be pending; a new one replaces whatever was waiting.
    for (const key of await cache.keys()) await cache.delete(key);

    const entries = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const key = `/__share/file/${index}`;
      await cache.put(
        key,
        new Response(file, {
          headers: { "Content-Type": file.type || "application/octet-stream" },
        }),
      );
      entries.push({ key, name: file.name || `shared-${index}`, type: file.type });
    }

    await cache.put(
      SHARE_MANIFEST,
      new Response(JSON.stringify({ files: entries, text }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch {
    /* fall through: the app opens empty rather than showing an error page */
  }

  return Response.redirect("/?shared=1", 303);
}

async function readShare(request) {
  const cached = await caches.match(request, { cacheName: SHARE_CACHE });
  return cached ?? new Response("null", { headers: { "Content-Type": "application/json" } });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response("GSend is offline. Reconnect and try again.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
