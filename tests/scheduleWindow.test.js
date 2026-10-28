const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// The schedule page shows a long run of days from one request to
// /api/schedule. A day in that run must look exactly as it would if the page
// had asked for that day alone, including across the start of a
// semester, an own-week override, a retired template version, the weeks after
// the last teaching week, and the rollover into the next semester.

// After every day below, so none is held back as «not open yet».
process.env.KAI_FAKE_NOW = '2027-08-01T12:00:00+03:00';
process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-window-'));
process.env.DB_PATH = path.join(tempDir, 'schedule.db');

const { createApp } = require('../server/app');
const { closeDb, getDb } = require('../server/db');

const importLib = (name) => import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', name)).href);
const LIMITS = { earliest: '2026-01-01', latest: '2027-12-31' };

test('windows: a first window is two weeks back and two weeks on, and never leaves the limits', async () => {
    const { planInitialWindow, requestDays } = await importLib('scheduleWindow.js');

    assert.deepEqual(planInitialWindow('2026-10-08', LIMITS), { from: '2026-09-24', to: '2026-10-22' });
    assert.equal(requestDays('2026-09-24', '2026-10-22'), 29);

    // Near a limit the window is cut, not shifted: the chosen day keeps its place.
    assert.deepEqual(planInitialWindow('2026-01-03', LIMITS), { from: '2026-01-01', to: '2026-01-17' });
    assert.deepEqual(planInitialWindow('2027-12-29', LIMITS), { from: '2027-12-15', to: '2027-12-31' });
    // A day outside the limits (the calendar can reach one) still gets its own window.
    assert.deepEqual(planInitialWindow('2025-06-10', LIMITS), { from: '2025-06-10', to: '2025-06-24' });
});

test('windows: a long run of days resolves every day as a request for that day alone', async (t) => {
    const { requestDays } = await importLib('scheduleWindow.js');
    const { resolveLessonsForDay } = await importLib('scheduleResolve.js');
    const { formatLocalDateForApi } = await importLib('date.js');

    const db = getDb();
    db.exec(`
        DELETE FROM audit_logs; DELETE FROM login_attempts; DELETE FROM lessons; DELETE FROM load_plan;
        DELETE FROM semesters; DELETE FROM teachers; DELETE FROM disciplines; DELETE FROM admins;
        DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    const universityId = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23303')").run(universityId).lastInsertRowid);

    // Autumn: 18 teaching weeks from Mon 7 Sep (week 1 even), then the session.
    // Spring starts Mon 8 Feb with week 1 odd, so the parities flip at the rollover.
    const addSemester = db.prepare(`
        INSERT INTO semesters (label, start_date, weeks_count, is_active, first_week_parity) VALUES (?, ?, ?, ?, ?)
    `);
    const autumn = Number(addSemester.run('Осень', '2026-09-07', 18, 1, 2).lastInsertRowid);
    const spring = Number(addSemester.run('Весна', '2027-02-08', 18, 0, 1).lastInsertRowid);

    const addLesson = db.prepare(`
        INSERT INTO lessons (
            group_id, semester_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order, kind
        ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, '101', 'Лекция', 'Иванов И.И.', 0, 'lesson')
    `);
    const lesson = (semesterId, day, weekType, from, subject, { week = null, removed = 0, time = '08:00' } = {}) =>
        addLesson.run(groupId, semesterId, day, weekType, week, from, removed, time, '09:30', subject);

    // Autumn template: an every-week pair, an odd and an even pair sharing one
    // cell, a pair replaced by a newer version from week 5, and a pair retired
    // by a tombstone from week 8.
    lesson(autumn, 1, 0, 1, 'Каждую неделю А');
    lesson(autumn, 2, 1, 1, 'Нечёт А');
    lesson(autumn, 2, 2, 1, 'Чёт А');
    lesson(autumn, 3, 0, 1, 'Старая версия', { time: '10:00' });
    lesson(autumn, 3, 0, 5, 'Новая версия', { time: '10:00' });
    lesson(autumn, 4, 0, 1, 'Уйдёт', { time: '12:00' });
    lesson(autumn, 4, 0, 8, 'Уйдёт', { time: '12:00', removed: 1 });
    // Week 3 is entered by hand: it ignores the template altogether.
    lesson(autumn, 1, 0, 1, 'Своя неделя 3', { week: 3, time: '09:40' });
    // Week 19 is past the last teaching week: only what is entered shows.
    lesson(autumn, 1, 0, 1, 'Сессия', { week: 19 });

    lesson(spring, 1, 0, 1, 'Каждую неделю В');
    lesson(spring, 5, 1, 1, 'Нечёт В');
    lesson(spring, 5, 2, 1, 'Чёт В');
    lesson(spring, 2, 0, 1, 'Своя неделя В2', { week: 2, time: '09:40' });
    lesson(spring, 3, 0, 1, 'Снято в неделе В2', { week: 2, time: '11:30', removed: 1 });

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const fetchWindow = async ({ from, to }) => {
        const response = await fetch(`${baseUrl}/api/schedule/${groupId}?subgroup=0&date=${from}&days=${requestDays(from, to)}`);
        assert.equal(response.status, 200);
        return response.json();
    };

    // One request from before autumn, through the session, into spring.
    const run = { from: '2026-08-31', to: '2027-03-07' };
    const data = await fetchWindow(run);

    assert.ok(run.from < '2026-09-07', 'the run reaches back before the semester');
    assert.ok(run.to > '2027-02-15', 'the run reaches forward into spring');

    const [fromYear, fromMonth, fromDay] = run.from.split('-').map(Number);
    const days = [];
    for (let date = new Date(fromYear, fromMonth - 1, fromDay); formatLocalDateForApi(date) <= run.to; date.setDate(date.getDate() + 1)) {
        days.push(new Date(date));
    }
    assert.ok(days.length > 150);

    const names = (result) => result.map((row) => `${row.id}:${row.subject}`);
    const seen = new Map();

    for (const day of days) {
        const iso = formatLocalDateForApi(day);
        const alone = await fetchWindow({ from: iso, to: iso });
        const expected = names(resolveLessonsForDay(alone, day));
        const actual = names(resolveLessonsForDay(data, day));

        assert.deepEqual(actual, expected, `${iso} must not depend on which windows it was loaded through`);
        seen.set(iso, resolveLessonsForDay(data, day).map((row) => row.subject));
    }

    // The days worth checking really do differ, so the comparison above is not
    // a comparison of empty lists.
    assert.deepEqual(seen.get('2026-09-21'), ['Своя неделя 3'], 'an entered week shows its own pairs');
    assert.deepEqual(seen.get('2026-09-14'), [], 'the template is never shown (week 2 not entered)');
    assert.deepEqual(seen.get('2026-10-07'), [], 'nor its newer versions');
    assert.deepEqual(seen.get('2027-01-11'), ['Сессия'], 'an entered week past the last teaching week');
    assert.deepEqual(seen.get('2027-02-08'), [], 'nor is spring\'s template');
    assert.deepEqual(seen.get('2027-02-16'), ['Своя неделя В2'], 'a removed marker in an own week hides nothing else');
    assert.deepEqual(seen.get('2026-08-31'), [], 'before any semester there is nothing to show');
});
