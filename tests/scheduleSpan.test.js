const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// span=semester: the student page loads the whole semester a day falls in —
// first Monday to the day before the next semester, or to the end of the
// session when there is no next one yet (never before the group's last exam);
// outside any semester, two weeks either side of the date.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-span-')), 'schedule.db');

const { createApp } = require('../server/app');
const { closeDb, getDb } = require('../server/db');

test('the whole semester around a date, its edges, and the fallback outside any semester', async (t) => {
    const db = getDb();
    db.exec('DELETE FROM lessons; DELETE FROM attestations; DELETE FROM semesters; DELETE FROM groups_; DELETE FROM universities;');
    const uni = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const group = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23101')").run(uni).lastInsertRowid);
    const autumn = Number(db.prepare("INSERT INTO semesters (label, start_date, weeks_count, first_week_parity, is_active) VALUES ('Осень', '2026-08-31', 18, 2, 1)").run().lastInsertRowid);

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));
    const base = `http://127.0.0.1:${server.address().port}`;
    const span = async (date) => {
        const response = await fetch(`${base}/api/schedule/${group}?date=${date}&span=semester`);
        const data = await response.json();
        assert.equal(response.headers.get('x-kai-range'), `${data.range_start}/${data.range_end}`, 'the header names the same days');
        return [data.range_start, data.range_end];
    };

    // No next semester: 18 teaching weeks + 8 for the session and holidays.
    assert.deepEqual(await span('2026-10-21'), ['2026-08-31', '2027-02-28']);

    // A late exam stretches it.
    db.prepare("INSERT INTO attestations (semester_id, group_id, subgroup, kind, date, time_start, discipline_text) VALUES (?, ?, 0, 'exam', '2027-03-05', '09:00', 'Пересдача')").run(autumn, group);
    assert.deepEqual(await span('2026-10-21'), ['2026-08-31', '2027-03-05']);

    // Spring created: autumn now ends the day before it, and spring runs on its own.
    db.prepare("INSERT INTO semesters (label, start_date, weeks_count, first_week_parity, is_active) VALUES ('Весна', '2027-02-08', 18, 1, 0)").run();
    assert.deepEqual(await span('2026-12-31'), ['2026-08-31', '2027-02-07']);
    assert.deepEqual(await span('2027-03-01'), ['2027-02-08', '2027-08-08']);

    // Outside any semester: before the first one, or long after the last one ends.
    assert.deepEqual(await span('2026-08-01'), ['2026-07-18', '2026-08-15']);
    assert.deepEqual(await span('2027-09-15'), ['2027-09-01', '2027-09-29']);

    // The silent refresh re-asks the same days with an explicit length.
    assert.equal((await fetch(`${base}/api/schedule/${group}?date=2026-08-31&days=400`)).status, 200);
    assert.equal((await fetch(`${base}/api/schedule/${group}?date=2026-08-31&days=401`)).status, 400);
    assert.equal((await fetch(`${base}/api/schedule/${group}?date=31.08.2026&span=semester`)).status, 400);
});
