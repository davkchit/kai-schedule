const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { resolveTemplateLessons: resolveOnServer } = require('../server/utils/templateResolve');

// The rule "which version of a template pair is in effect in week N" exists
// twice: src/lib/templateResolve.js (the student page, ESM) and
// server/utils/templateResolve.js (hours and the admin, CommonJS), kept in
// sync by hand. If one copy is ever changed alone, students would see one
// schedule while hours are counted from another — silently. This runs both on
// the same generated schedules and requires identical answers.

/** Small deterministic PRNG, so a failure reproduces with the printed seed. */
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

function pick(random, values) {
    return values[Math.floor(random() * values.length)];
}

function generateCandidates(random) {
    const count = 1 + Math.floor(random() * 25);
    const lessons = [];

    for (let index = 0; index < count; index += 1) {
        lessons.push({
            // Duplicate ids are impossible in the database, but ties on
            // template_from_week are common and must be broken the same way.
            id: 1 + Math.floor(random() * 1000) * 100 + index,
            day_of_week: pick(random, [1, 2]),
            time_start: pick(random, ['08:00', '09:40']),
            time_end: pick(random, ['09:30', '11:10']),
            subgroup: pick(random, [0, 1, 2]),
            week_type: pick(random, [0, 1, 2]),
            template_from_week: pick(random, [undefined, null, 1, 1, 2, 3, 5, 8]),
            is_removed: pick(random, [0, 0, 0, 1])
        });
    }

    return lessons;
}

const ids = (lessons) => lessons.map((lesson) => lesson.id).sort((a, b) => a - b);

test('the student page and the server pick the same template version for every week', async () => {
    const { resolveTemplateLessons: resolveOnClient } = await import(
        pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'templateResolve.js')).href
    );

    for (let seed = 1; seed <= 3000; seed += 1) {
        const random = createRandom(seed);
        const candidates = generateCandidates(random);
        const targetWeek = 1 + Math.floor(random() * 9);

        assert.deepEqual(
            ids(resolveOnClient(candidates, targetWeek)),
            ids(resolveOnServer(candidates, targetWeek)),
            `the two copies disagree (seed ${seed}, week ${targetWeek})`
        );
    }
});
