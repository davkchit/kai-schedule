const CACHE_VERSION = 'v7';
const SHELL_CACHE = `anti-vuz-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `anti-vuz-static-${CACHE_VERSION}`;
// Saved schedules are not tied to a release: a new version must not throw
// away the copy a student's phone holds for the moments without signal.
const DATA_CACHE = 'anti-vuz-data-v5';
// The campus network tends to hang rather than fail: a request can sit for
// 10–20 s without an error. Past these limits the saved copy is shown, and the
// network's answer, when it does come, is saved for next time.
const NAVIGATION_TIMEOUT_MS = 2000;
const STYLESHEET_TIMEOUT_MS = 1500;
const DATA_TIMEOUT_MS = 2500;
// Set on a saved schedule handed out instead of the network's: 'unreachable'
// (no answer in time) or 'refused' (the server answered with an error).
const SAVED_COPY_HEADER = 'X-Kai-Saved-Copy';
// When that copy was saved (ISO time), so the page can say how old it is.
const SAVED_AT_HEADER = 'X-Kai-Saved-At';
// Set when the saved copy covers only part of the days asked for: the days
// it does cover, as "from/to". The page shows those and no others.
const SAVED_RANGE_HEADER = 'X-Kai-Saved-Range';
// A refresh of a schedule already on screen waits for the network: the saved
// copy it would get instead is what it is trying to replace.
const WAIT_HEADER = 'X-Kai-Wait';
const APP_SHELL_URL = '/';
const OFFLINE_URL = '/offline.html';
const DEFAULT_SCHEDULE_RANGE_DAYS = 28;
const FIXED_STATIC_URLS = [
    '/manifest.webmanifest',
    '/icons/favicon-64.png',
    '/icons/apple-touch-icon.png',
    '/icons/pwa-192.png',
    '/icons/pwa-512.png',
    '/css/welcome.css',
    '/css/schedule.css',
    '/css/schedule-mobile.css',
    '/assets/logo.png',
    '/assets/back.jpg',
    OFFLINE_URL
];

self.addEventListener('install', (event) => {
    event.waitUntil(precacheAppShell());
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(cleanupOldCaches());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);

    if (url.origin !== self.location.origin) {
        return;
    }

    if (isAdminRequest(url)) {
        return;
    }

    if (isPublicDataRequest(url)) {
        event.respondWith(networkFirstData(event));
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(event));
        return;
    }

    // Stylesheets keep the same name across releases (unlike the hashed
    // bundles), so a cached copy would pair the new code with the old styles
    // for one launch — on iOS that showed unstyled system-blue buttons. Hence
    // the network first; the saved copy only when the network is slow, and
    // then the page itself most likely came from the cache as well.
    if (url.pathname.startsWith('/css/')) {
        event.respondWith(networkFirstStatic(event));
        return;
    }

    if (isStaticAssetRequest(url, request)) {
        event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    }
});

async function precacheAppShell() {
    const shellCache = await caches.open(SHELL_CACHE);
    const staticCache = await caches.open(STATIC_CACHE);
    const shellResponse = await fetch(APP_SHELL_URL, { cache: 'no-store' });

    if (!shellResponse.ok) {
        throw new Error(`Unable to cache app shell: ${shellResponse.status}`);
    }

    await shellCache.put(APP_SHELL_URL, shellResponse.clone());
    await shellCache.put('/index.html', shellResponse.clone());

    const html = await shellResponse.text();
    const discoveredUrls = extractAssetUrlsFromHtml(html);

    await cacheUrls(staticCache, [...FIXED_STATIC_URLS, ...discoveredUrls]);
    await cacheUrls(staticCache, await findLazyChunks(staticCache, discoveredUrls));
}

/**
 * The code of each page is loaded only when the page is opened. A student who
 * always goes straight to the schedule would otherwise have nothing saved for
 * the group search or teacher pages, and on a hanging network those would
 * stay blank. The admin's code is left out: students never need it.
 */
async function findLazyChunks(staticCache, urls) {
    const chunks = [];

    for (const url of urls.filter((value) => value.endsWith('.js'))) {
        const response = await staticCache.match(url);

        if (!response) {
            continue;
        }

        for (const match of (await response.text()).matchAll(/assets\/[\w-]+\.js/g)) {
            if (!/\/Admin/.test(match[0])) {
                chunks.push(`/${match[0]}`);
            }
        }
    }

    return chunks;
}

async function cleanupOldCaches() {
    const cacheNames = await caches.keys();

    await Promise.all(
        cacheNames
            .filter((cacheName) => ![SHELL_CACHE, STATIC_CACHE, DATA_CACHE].includes(cacheName))
            .map((cacheName) => caches.delete(cacheName))
    );

    await self.clients.claim();
}

async function cacheUrls(cache, urls) {
    const uniqueUrls = [...new Set(urls)];

    await Promise.all(
        uniqueUrls.map(async (url) => {
            try {
                const response = await fetch(url, { cache: 'no-store' });

                if (isCacheableResponse(response)) {
                    await cache.put(url, response);
                }
            } catch {
                return undefined;
            }

            return undefined;
        })
    );
}

function extractAssetUrlsFromHtml(html) {
    const matches = html.matchAll(/(?:href|src)=["']([^"']+)["']/g);
    const urls = [];

    for (const match of matches) {
        const value = match[1];

        if (!value.startsWith('/')) {
            continue;
        }

        if (!/\.(?:js|css|png|svg|gif|ico|woff2?|ttf)$/i.test(value)) {
            continue;
        }

        urls.push(value);
    }

    return urls;
}

/**
 * Fetches `request` and saves a good answer into `cache` (as `cacheKey`).
 * Resolves to the response, or null when the network failed. The event is
 * kept alive until it settles, so an answer that arrives after the page was
 * already served the saved copy still gets saved.
 */
function fetchAndSave(event, cache, cacheKey, prepare = (response) => response) {
    const network = fetch(event.request)
        .then(async (response) => {
            if (isCacheableResponse(response)) {
                await cache.put(cacheKey, prepare(response.clone()));
            }

            return response;
        })
        .catch(() => null);

    event.waitUntil(network);

    return network;
}

/** The promise's value, or null if it has not settled within `ms`. */
function withinTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => {
            setTimeout(() => resolve(null), ms);
        })
    ]);
}

async function handleNavigation(event) {
    const cache = await caches.open(SHELL_CACHE);
    const network = fetchAndSave(event, cache, APP_SHELL_URL);
    const cachedShell = (await cache.match(event.request)) || (await cache.match(APP_SHELL_URL));
    const response = cachedShell
        ? await withinTimeout(network, NAVIGATION_TIMEOUT_MS)
        : await network;

    if (response && response.ok) {
        return response;
    }

    return cachedShell || (await caches.match(OFFLINE_URL)) || response || Response.error();
}

async function networkFirstData(event) {
    const { request } = event;
    const cache = await caches.open(DATA_CACHE);
    const network = fetchAndSave(event, cache, request, stampSavedAt);
    const waitForNetwork = request.headers.get(WAIT_HEADER) === '1';
    const saved = waitForNetwork ? null : await findCachedDataResponse(request, cache);
    const response = saved
        ? await withinTimeout(network, DATA_TIMEOUT_MS)
        : await network;

    if (isCacheableResponse(response)) {
        return response;
    }

    // No answer in time, or the server refused — rate limit, restart, bad
    // gateway. A saved copy of the schedule is far more useful to a student
    // standing in a corridor than an error screen.
    const savedResponse = saved || (await findCachedDataResponse(request, cache));

    if (savedResponse) {
        return markSavedCopy(savedResponse, response ? 'refused' : 'unreachable');
    }

    if (response) {
        return response;
    }

    return new Response(
        JSON.stringify({
            error: 'offline',
            message: 'Нет интернета и сохранённой версии данных'
        }),
        {
            status: 503,
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            }
        }
    );
}

/** A copy of `response` carrying the time it was saved. */
function stampSavedAt(response) {
    return withHeader(response, SAVED_AT_HEADER, new Date().toISOString());
}

/** A copy of a saved `response` marked as such, with why it was used. */
function markSavedCopy(response, reason) {
    return withHeader(response, SAVED_COPY_HEADER, reason);
}

function withHeader(response, name, value) {
    const headers = new Headers(response.headers);
    headers.set(name, value);

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

async function findCachedDataResponse(request, cache) {
    const exactMatch = await cache.match(request);

    if (exactMatch) {
        return exactMatch;
    }

    const requestUrl = new URL(request.url);

    if (!requestUrl.pathname.startsWith('/api/schedule/')) {
        return null;
    }

    const requestedSubgroup = requestUrl.searchParams.get('subgroup') || '0';
    const requestedRangeDays = parseIntegerOrDefault(
        requestUrl.searchParams.get('days'),
        DEFAULT_SCHEDULE_RANGE_DAYS
    );
    const requestedDate = requestUrl.searchParams.get('date');

    if (!requestedDate) {
        return null;
    }

    const requestedStart = parseIsoDate(requestedDate);
    const requestedEnd = addDays(requestedStart, requestedRangeDays - 1);
    const keys = await cache.keys();
    const candidates = [];
    // The window is laid around today, so from the next day on it reaches a
    // day past every copy saved before: a copy covering most of it is still
    // what a student offline needs, as long as the page knows where it ends.
    let partial = null;

    for (const cachedRequest of keys) {
        const cachedUrl = new URL(cachedRequest.url);

        if (cachedUrl.pathname !== requestUrl.pathname) {
            continue;
        }

        if ((cachedUrl.searchParams.get('subgroup') || '0') !== requestedSubgroup) {
            continue;
        }

        const cachedDate = cachedUrl.searchParams.get('date');

        if (!cachedDate) {
            continue;
        }

        const cachedStart = parseIsoDate(cachedDate);
        const cachedRangeDays = parseIntegerOrDefault(
            cachedUrl.searchParams.get('days'),
            DEFAULT_SCHEDULE_RANGE_DAYS
        );
        const cachedEnd = addDays(cachedStart, cachedRangeDays - 1);

        if (cachedStart <= requestedStart && cachedEnd >= requestedEnd) {
            candidates.push({ cachedRequest, cachedStart });
            continue;
        }

        const overlapStart = cachedStart > requestedStart ? cachedStart : requestedStart;
        const overlapEnd = cachedEnd < requestedEnd ? cachedEnd : requestedEnd;
        const overlapDays = (overlapEnd - overlapStart) / 86400000 + 1;

        if (overlapDays > 0 && (!partial || overlapDays > partial.overlapDays)) {
            partial = { cachedRequest, overlapStart, overlapEnd, overlapDays };
        }
    }

    candidates.sort((left, right) => right.cachedStart - left.cachedStart);

    if (candidates.length > 0) {
        return cache.match(candidates[0].cachedRequest);
    }

    if (!partial) {
        return null;
    }

    const response = await cache.match(partial.cachedRequest);

    return response && withHeader(
        response,
        SAVED_RANGE_HEADER,
        `${formatIsoDate(partial.overlapStart)}/${formatIsoDate(partial.overlapEnd)}`
    );
}

/** The network's copy; the saved one when offline or slow to answer. */
async function networkFirstStatic(event) {
    const { request } = event;
    const cache = await caches.open(STATIC_CACHE);
    const network = fetchAndSave(event, cache, request);
    const cached = await cache.match(request);
    const response = cached
        ? await withinTimeout(network, STYLESHEET_TIMEOUT_MS)
        : await network;

    if (isCacheableResponse(response)) {
        return response;
    }

    return cached || response || Response.error();
}

async function staleWhileRevalidate(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);
    const networkPromise = fetch(request)
        .then(async (response) => {
            if (isCacheableResponse(response)) {
                await cache.put(request, response.clone());
            }

            return response;
        })
        .catch(() => null);

    if (cachedResponse) {
        return cachedResponse;
    }

    const networkResponse = await networkPromise;

    if (networkResponse) {
        return networkResponse;
    }

    return fetch(request);
}

function isAdminRequest(url) {
    return url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/admin');
}

function isPublicDataRequest(url) {
    return (
        url.pathname === '/api/universities' ||
        /^\/api\/universities\/\d+\/groups$/.test(url.pathname) ||
        url.pathname.startsWith('/api/schedule/')
    );
}

function isStaticAssetRequest(url, request) {
    if (
        url.pathname === '/manifest.webmanifest' ||
        url.pathname === OFFLINE_URL ||
        url.pathname.startsWith('/icons/') ||
        url.pathname.startsWith('/assets/') ||
        url.pathname.startsWith('/css/')
    ) {
        return true;
    }

    return ['script', 'style', 'image', 'font'].includes(request.destination);
}

function isCacheableResponse(response) {
    return response && response.ok;
}

function parseIntegerOrDefault(value, fallback) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIsoDate(value) {
    const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
    return new Date(Date.UTC(year, month - 1, day));
}

function formatIsoDate(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(date, amount) {
    const nextDate = new Date(date);
    nextDate.setUTCDate(nextDate.getUTCDate() + amount);
    return nextDate;
}
