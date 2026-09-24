const CACHE_VERSION = 'v4';
const SHELL_CACHE = `anti-vuz-shell-${CACHE_VERSION}`;
const STATIC_CACHE = `anti-vuz-static-${CACHE_VERSION}`;
const DATA_CACHE = `anti-vuz-data-${CACHE_VERSION}`;
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
    '/assets/back.png',
    '/assets/party-confetti.gif',
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
        event.respondWith(networkFirstData(request));
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
        return;
    }

    // Stylesheets keep the same name across releases (unlike the hashed
    // bundles), so a cached copy would pair the new code with the old styles
    // for one launch — on iOS that showed unstyled system-blue buttons.
    if (url.pathname.startsWith('/css/')) {
        event.respondWith(networkFirstStatic(request));
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

async function handleNavigation(request) {
    try {
        const response = await fetch(request);

        if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(APP_SHELL_URL, response.clone());
            return response;
        }
    } catch {
        const cache = await caches.open(SHELL_CACHE);
        const cachedShell = (await cache.match(request)) || (await cache.match(APP_SHELL_URL));

        if (cachedShell) {
            return cachedShell;
        }
    }

    return caches.match(OFFLINE_URL);
}

async function networkFirstData(request) {
    const cache = await caches.open(DATA_CACHE);

    try {
        const response = await fetch(request);

        if (isCacheableResponse(response)) {
            await cache.put(request, response.clone());
            return response;
        }

        // The request went through but the server refused it — rate limit,
        // restart, bad gateway. A saved copy of the schedule is far more
        // useful to a student standing in a corridor than an error screen.
        const savedResponse = await findCachedDataResponse(request, cache);

        return savedResponse || response;
    } catch {
        const cachedResponse = await findCachedDataResponse(request, cache);

        if (cachedResponse) {
            return cachedResponse;
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
        }
    }

    candidates.sort((left, right) => right.cachedStart - left.cachedStart);

    if (candidates.length === 0) {
        return null;
    }

    return cache.match(candidates[0].cachedRequest);
}

/** The network's copy when online; the saved one only when offline. */
async function networkFirstStatic(request) {
    const cache = await caches.open(STATIC_CACHE);

    try {
        const response = await fetch(request);

        if (isCacheableResponse(response)) {
            await cache.put(request, response.clone());
            return response;
        }

        return (await cache.match(request)) || response;
    } catch {
        return (await cache.match(request)) || fetch(request);
    }
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

function addDays(date, amount) {
    const nextDate = new Date(date);
    nextDate.setUTCDate(nextDate.getUTCDate() + amount);
    return nextDate;
}
