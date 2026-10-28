const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The service worker decides what a student sees with no signal: which saved
// copy of the semester covers the day asked for, and how many copies stay.
// It runs here, the real file, against a small in-memory Cache Storage and a
// network that answers, fails or refuses on demand.

const ORIGIN = 'https://kai.test';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client-public', 'service-worker.js'), 'utf8');

const keyOf = (request) => (typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);

class FakeCache {
    constructor() { this.entries = new Map(); }
    async match(request) { const saved = this.entries.get(keyOf(request)); return saved ? saved.clone() : undefined; }
    async put(request, response) { this.entries.set(keyOf(request), response.clone()); }
    async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
    async delete(request) { return this.entries.delete(keyOf(request)); }
}

function loadWorker() {
    const caches = new Map();
    const listeners = {};
    const network = { answer: null };
    const context = {
        self: { location: { origin: ORIGIN }, addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
        caches: {
            open: async (name) => { if (!caches.has(name)) caches.set(name, new FakeCache()); return caches.get(name); },
            keys: async () => [...caches.keys()],
            delete: async (name) => caches.delete(name),
            match: async (request) => { for (const cache of caches.values()) { const hit = await cache.match(request); if (hit) return hit; } return undefined; }
        },
        fetch: async (request) => network.answer(request),
        Request, Response, Headers, URL, setTimeout, clearTimeout, console
    };
    vm.runInNewContext(SOURCE, context);

    /** One fetch event through the worker; null when it lets the browser handle it. */
    async function request(url, headers = {}) {
        const pending = [];
        let responded = null;
        listeners.fetch({
            request: new Request(ORIGIN + url, { headers }),
            respondWith: (promise) => { responded = promise; },
            waitUntil: (promise) => { pending.push(promise); }
        });
        const response = responded ? await responded : null;
        await Promise.all(pending);
        return response;
    }

    const dataCache = () => caches.get([...caches.keys()].find((name) => name.startsWith('anti-vuz-data')));
    return { request, network, dataCache };
}

/** A schedule answer as the server sends it: its days in X-Kai-Range. */
const scheduleAnswer = (from, to, label) => new Response(JSON.stringify({ label, range_start: from, range_end: to }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'X-Kai-Range': `${from}/${to}` }
});
const semesterUrl = (group, date, subgroup = 0) => `/api/schedule/${group}?subgroup=${subgroup}&date=${date}&span=semester`;
const fresh = { 'X-Kai-Wait': '1' };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
const offline = () => { throw new TypeError('Failed to fetch'); };

test('offline, a semester is answered from the newest saved copy covering the day', async () => {
    const sw = loadWorker();

    // Online: autumn saved twice (a newer copy after an edit), spring once.
    for (const [date, from, to, label] of [
        ['2026-10-20', '2026-08-31', '2027-02-07', 'autumn-old'],
        ['2026-10-27', '2026-08-31', '2027-02-07', 'autumn-new'],
        ['2027-02-15', '2027-02-08', '2027-08-29', 'spring']
    ]) {
        sw.network.answer = () => scheduleAnswer(from, to, label);
        assert.equal((await sw.request(semesterUrl(5, date), fresh)).status, 200);
        await pause();
    }

    sw.network.answer = offline;

    // A day the URL never named, inside autumn: the newer autumn copy, at once.
    const instant = await sw.request(semesterUrl(5, '2026-11-03'));
    assert.equal(instant.headers.get('X-Kai-Saved-Copy'), 'instant');
    assert.equal((await instant.json()).label, 'autumn-new');

    // The page's second ask waits for the network; with none, the saved copy says so.
    const unreachable = await sw.request(semesterUrl(5, '2026-11-03'), fresh);
    assert.equal(unreachable.headers.get('X-Kai-Saved-Copy'), 'unreachable');
    assert.equal((await unreachable.json()).label, 'autumn-new');

    assert.equal((await (await sw.request(semesterUrl(5, '2027-03-01'))).json()).label, 'spring');

    // A server that refuses (rate limit, restart) still gets the saved copy shown.
    sw.network.answer = () => new Response('{}', { status: 429 });
    const refused = await sw.request(semesterUrl(5, '2026-11-03'), fresh);
    assert.equal(refused.headers.get('X-Kai-Saved-Copy'), 'refused');

    // Nothing saved covers the day, or another group: an honest «offline».
    sw.network.answer = offline;
    for (const url of [semesterUrl(5, '2027-09-10'), semesterUrl(6, '2026-11-03'), semesterUrl(5, '2026-11-03', 1)]) {
        const none = await sw.request(url);
        assert.equal(none.status, 503, url);
        assert.equal((await none.json()).error, 'offline');
    }
});

test('a group keeps only its 3 newest saved schedules; other groups and subgroups keep theirs', async () => {
    const sw = loadWorker();
    const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];

    for (const date of dates) {
        sw.network.answer = () => scheduleAnswer('2026-08-31', '2027-02-07', date);
        await sw.request(semesterUrl(5, date), fresh);
        await pause();
    }

    sw.network.answer = () => scheduleAnswer('2026-08-31', '2027-02-07', 'other');
    await sw.request(semesterUrl(6, '2026-10-01'), fresh);
    await sw.request(semesterUrl(5, '2026-10-01', 1), fresh);

    const saved = [...sw.dataCache().entries.keys()].map((url) => new URL(url)).filter((url) => url.pathname.startsWith('/api/schedule/'));
    const ofGroup5 = saved.filter((url) => url.pathname === '/api/schedule/5' && url.searchParams.get('subgroup') === '0');

    assert.deepEqual(ofGroup5.map((url) => url.searchParams.get('date')).sort(), dates.slice(-3), 'the 3 newest of group 5');
    assert.equal(saved.filter((url) => url.pathname === '/api/schedule/6').length, 1);
    assert.equal(saved.filter((url) => url.searchParams.get('subgroup') === '1').length, 1);

    // And offline the newest of them is the one shown.
    sw.network.answer = offline;
    assert.equal((await (await sw.request(semesterUrl(5, '2026-12-01'))).json()).label, '2026-10-05');
});

test('the admin area is never answered from a saved copy', async () => {
    const sw = loadWorker();
    sw.network.answer = () => new Response('{}', { status: 200 });

    assert.equal(await sw.request('/api/admin/lessons?group_id=1'), null);
    assert.equal(await sw.request('/admin/dashboard'), null);
});
