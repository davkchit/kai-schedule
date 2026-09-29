const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The server keeps a hand-maintained CommonJS port of src/lib/templateResolve.js
// because the client (ESM, bundled by Vite) and the server (CommonJS, run
// directly by Node) don't share a build step. If the two ever drift, template
// resolution (which weeks show which lesson version) would silently differ
// between what the admin builder shows and what the public API serves. This
// test runs both implementations against identical fixtures and fails on any
// output difference.
const { resolveTemplateLessons: resolveServer } = require('../server/utils/templateResolve');

async function loadClientResolver() {
    const filePath = path.join(__dirname, '..', 'src', 'lib', 'templateResolve.js');
    const source = fs.readFileSync(filePath, 'utf8');
    // src/lib/templateResolve.js is ESM but the package itself is CommonJS
    // (no "type": "module"), so `require` can't load it. Importing it as a
    // data: URL forces Node to parse it as a module regardless of package type.
    const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
    const clientModule = await import(dataUrl);
    return clientModule.resolveTemplateLessons;
}

function lesson({ id, day_of_week, time_start, time_end, subgroup = 0, week_type = 0, template_from_week = 1, is_removed = 0, subject }) {
    return { id, day_of_week, time_start, time_end, subgroup, week_type, template_from_week, is_removed, subject: subject || `lesson-${id}` };
}

const FIXTURES = [
    {
        name: 'empty input',
        candidates: [],
        targetWeek: 1
    },
    {
        name: 'single template lesson, no versioning',
        candidates: [lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30' })],
        targetWeek: 5
    },
    {
        name: 'later version wins for weeks at/after its from_week, older version wins before it',
        candidates: [
            lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 1, subject: 'v1' }),
            lesson({ id: 2, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 5, subject: 'v2' })
        ],
        targetWeek: 3
    },
    {
        name: 'later version wins for weeks at/after its from_week (post cutover)',
        candidates: [
            lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 1, subject: 'v1' }),
            lesson({ id: 2, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 5, subject: 'v2' })
        ],
        targetWeek: 5
    },
    {
        name: 'tombstoned slot disappears once its version becomes active',
        candidates: [
            lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 1, subject: 'v1' }),
            lesson({ id: 2, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 5, is_removed: 1 })
        ],
        targetWeek: 5
    },
    {
        name: 'same time, different day are independent slots (regression: cross-day collision bug)',
        candidates: [
            lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30', subject: 'monday' }),
            lesson({ id: 2, day_of_week: 5, time_start: '09:00', time_end: '10:30', subject: 'friday' })
        ],
        targetWeek: 1
    },
    {
        name: 'tie-break on equal from_week goes to the higher id',
        candidates: [
            lesson({ id: 3, day_of_week: 2, time_start: '11:30', time_end: '13:00', template_from_week: 2, subject: 'a' }),
            lesson({ id: 7, day_of_week: 2, time_start: '11:30', time_end: '13:00', template_from_week: 2, subject: 'b' })
        ],
        targetWeek: 4
    },
    {
        name: 'version with from_week ahead of target is excluded entirely',
        candidates: [
            lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30', template_from_week: 10 })
        ],
        targetWeek: 3
    },
    {
        name: 'subgroup and week_type are part of the slot key',
        candidates: [
            lesson({ id: 1, day_of_week: 1, time_start: '09:00', time_end: '10:30', subgroup: 1, week_type: 1, subject: 'sub1-odd' }),
            lesson({ id: 2, day_of_week: 1, time_start: '09:00', time_end: '10:30', subgroup: 2, week_type: 1, subject: 'sub2-odd' }),
            lesson({ id: 3, day_of_week: 1, time_start: '09:00', time_end: '10:30', subgroup: 0, week_type: 2, subject: 'full-even' })
        ],
        targetWeek: 1
    }
];

test('templateResolve: client (ESM) and server (CJS) implementations stay in parity', async () => {
    const resolveClient = await loadClientResolver();

    for (const fixture of FIXTURES) {
        const serverResult = resolveServer(fixture.candidates, fixture.targetWeek);
        const clientResult = resolveClient(fixture.candidates, fixture.targetWeek);

        const serverIds = serverResult.map((l) => l.id).sort();
        const clientIds = clientResult.map((l) => l.id).sort();

        assert.deepEqual(
            clientIds,
            serverIds,
            `fixture "${fixture.name}": client and server disagree (server=${JSON.stringify(serverIds)}, client=${JSON.stringify(clientIds)})`
        );
    }
});

test('templateResolve: known-good expected outputs (guards against both copies drifting together)', () => {
    const later = resolveServer(FIXTURES[2].candidates, FIXTURES[2].targetWeek);
    assert.deepEqual(later.map((l) => l.subject), ['v1']);

    const cutover = resolveServer(FIXTURES[3].candidates, FIXTURES[3].targetWeek);
    assert.deepEqual(cutover.map((l) => l.subject), ['v2']);

    const tombstoned = resolveServer(FIXTURES[4].candidates, FIXTURES[4].targetWeek);
    assert.equal(tombstoned.length, 0);

    const crossDay = resolveServer(FIXTURES[5].candidates, FIXTURES[5].targetWeek);
    assert.deepEqual(crossDay.map((l) => l.subject).sort(), ['friday', 'monday']);

    const tieBreak = resolveServer(FIXTURES[6].candidates, FIXTURES[6].targetWeek);
    assert.deepEqual(tieBreak.map((l) => l.subject), ['b']);

    const excluded = resolveServer(FIXTURES[7].candidates, FIXTURES[7].targetWeek);
    assert.equal(excluded.length, 0);

    const bySlotKey = resolveServer(FIXTURES[8].candidates, FIXTURES[8].targetWeek);
    assert.deepEqual(bySlotKey.map((l) => l.subject).sort(), ['full-even', 'sub1-odd', 'sub2-odd']);
});

// The fixtures above name the known cases; this sweeps many generated ones
// (ties on template_from_week, tombstones, missing from_week, every slot key
// field) so a drift in some corner nobody wrote a fixture for is caught too.
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

test('templateResolve: client and server agree on 3000 generated schedules', async () => {
    const resolveClient = await loadClientResolver();
    const pick = (random, values) => values[Math.floor(random() * values.length)];

    for (let seed = 1; seed <= 3000; seed += 1) {
        const random = createRandom(seed);
        const candidates = Array.from({ length: 1 + Math.floor(random() * 25) }, (_, index) => ({
            id: 1 + Math.floor(random() * 1000) * 100 + index,
            day_of_week: pick(random, [1, 2]),
            time_start: pick(random, ['08:00', '09:40']),
            time_end: pick(random, ['09:30', '11:10']),
            subgroup: pick(random, [0, 1, 2]),
            week_type: pick(random, [0, 1, 2]),
            template_from_week: pick(random, [undefined, null, 1, 1, 2, 3, 5, 8]),
            is_removed: pick(random, [0, 0, 0, 1])
        }));
        const targetWeek = 1 + Math.floor(random() * 9);
        const ids = (lessons) => lessons.map((l) => l.id).sort((a, b) => a - b);

        assert.deepEqual(
            ids(resolveClient(candidates, targetWeek)),
            ids(resolveServer(candidates, targetWeek)),
            `the two copies disagree (seed ${seed}, week ${targetWeek})`
        );
    }
});
