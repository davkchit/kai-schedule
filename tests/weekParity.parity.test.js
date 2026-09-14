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

test('semester week parity: the browser and the server resolve week N identically for both first-week parities', async () => {
    // Since parity is stored per semester, THIS is the rule that picks the
    // template a week shows; the calendar parity above is only its default.
    const { getWeekTypeForSemesterWeek: client } = await loadClientDateLib();
    const { getWeekTypeForSemesterWeek: server } = require('../server/utils/date');

    for (const first of [1, 2]) {
        for (let week = 1; week <= 53; week += 1) {
            assert.equal(client(first, week), server(first, week), `first=${first} week=${week}`);
        }
    }
});

test('semester week parity: strictly alternates across a 53-week year, unlike the calendar', () => {
    // 2026 has 53 ISO weeks: 28.12.2026 (week 53) and 04.01.2027 (week 1) are
    // both нечётная by the calendar. A semester running through New Year must
    // still alternate — the department's timetable never repeats a parity.
    const { getSemesterWeekMeta } = require('../server/utils/date');
    const semester = { start_date: '2026-09-07', first_week_parity: 1 };
    const types = [];

    for (let week = 0; week < 20; week += 1) {
        const monday = new Date(Date.UTC(2026, 8, 7 + week * 7));
        types.push(getSemesterWeekMeta(semester, isoFromUtc(monday.getTime())).weekTypeNumber);
    }

    types.forEach((type, index) => {
        if (index > 0) assert.notEqual(type, types[index - 1], `weeks ${index} and ${index + 1} have the same parity`);
    });
    assert.equal(serverParity('2026-12-28'), serverParity('2027-01-04'), 'calendar parity really does repeat here');
});

test('semester weeks run Monday–Sunday even when the start date is not a Monday', async () => {
    // A start date entered as the first teaching day (Tuesday 9 Feb 2027) must
    // not make weeks run Tuesday–Monday: Monday 15 Feb is week 2, not week 1.
    const { getSemesterWeekNumber: client } = await loadClientDateLib();
    const { getSemesterWeekNumber: server } = require('../server/utils/date');

    for (const [day, expected] of [['2027-02-08', 1], ['2027-02-14', 1], ['2027-02-15', 2], ['2027-02-22', 3]]) {
        const [y, m, d] = day.split('-').map(Number);
        assert.equal(server('2027-02-09', day), expected, `server ${day}`);
        assert.equal(client('2027-02-09', new Date(y, m - 1, d)), expected, `client ${day}`);
    }
});
