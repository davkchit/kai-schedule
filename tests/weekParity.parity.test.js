const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Week parity decides which template (чётная / нечётная) a week shows. It is
// computed on the server (hour counting) AND in the browser (the student
// schedule and the admin constructor resolve lessons client-side). If the two
// ever disagree, hours are counted against one timetable while students are
// shown the other.
//
// That is not hypothetical: the server was switched to calendar-week parity
// while both pages kept an inline `weekNumber % 2` — the students' schedule
// showed the opposite parity from week 3 on, masked in weeks 1–2 only because
// those weeks were stored as explicit per-week rows.
const { getWeekTypeNumber: serverParity } = require('../server/utils/date');

async function loadClientDateLib() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'date.js'), 'utf8');
    return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
}

function isoFromUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

test('week parity: the browser and the server agree on every day across three years, including 53-week year boundaries', async () => {
    const { getWeekTypeNumber: clientParity } = await loadClientDateLib();

    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2028, 11, 31);
    const mismatches = [];

    for (let ms = from; ms <= to; ms += 86400000) {
        const iso = isoFromUtc(ms);
        const [y, m, d] = iso.split('-').map(Number);
        const client = clientParity(new Date(y, m - 1, d));
        const server = serverParity(iso);

        if (client !== server) {
            mismatches.push(`${iso}: client=${client} server=${server}`);
        }
    }

    assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} day(s) disagree`);
});

test('week parity: anchored to the department\'s own published sheets', () => {
    // Both autumn 2026 files: 1–5 Sept is labelled ЧЁТНАЯ, 7–12 Sept НЕЧЁТНАЯ.
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-05']) {
        assert.equal(serverParity(day), 2, `${day} must be чётная`);
    }
    for (const day of ['2026-09-07', '2026-09-10', '2026-09-12']) {
        assert.equal(serverParity(day), 1, `${day} must be нечётная`);
    }
});

test('week parity: no page computes parity inline instead of calling the shared function', () => {
    // The drift above came from exactly this: logic re-implemented in a page
    // rather than imported, so fixing the shared function never reached it.
    const pagesDir = path.join(__dirname, '..', 'src', 'pages');
    const offenders = [];

    for (const file of fs.readdirSync(pagesDir).filter((name) => name.endsWith('.jsx'))) {
        const source = fs.readFileSync(path.join(pagesDir, file), 'utf8');
        source.split('\n').forEach((line, index) => {
            if (/%\s*2\s*===\s*0\s*\?\s*2\s*:\s*1/.test(line)) {
                offenders.push(`${file}:${index + 1}: ${line.trim()}`);
            }
        });
    }

    assert.deepEqual(offenders, [], 'parity must come from getWeekTypeNumber in src/lib/date.js');
});
