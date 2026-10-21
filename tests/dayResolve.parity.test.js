const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// The server's day resolution (server/utils/dayResolve.js — Alice, session
// clash checks) and the student page's (src/lib/scheduleResolve.js) must
// agree on every day: template versions and tombstones, both parities, a
// week with its own rows (and one with only a removed marker), the cutoff
// after the last teaching week, and the rollover into the next semester.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-dayparity-')), 'schedule.db');

const { createApp } = require('../server/app');
const { closeDb, getDb } = require('../server/db');
const { resolveGroupLessons } = require('../server/utils/dayResolve');
const { addDaysToIsoDate } = require('../server/utils/date');

test('server and student page resolve every day identically', async (t) => {
    const { resolveLessonsForDay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'scheduleResolve.js')).href);
    const db = getDb();
    db.exec('DELETE FROM lessons; DELETE FROM semesters; DELETE FROM groups_; DELETE FROM universities;');
    const uni = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const group = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23101')").run(uni).lastInsertRowid);
    const autumn = Number(db.prepare("INSERT INTO semesters (label, start_date, weeks_count, first_week_parity, is_active) VALUES ('Осень', '2026-08-31', 6, 2, 1)").run().lastInsertRowid);
    const spring = Number(db.prepare("INSERT INTO semesters (label, start_date, weeks_count, first_week_parity, is_active) VALUES ('Весна', '2026-10-26', 4, 1, 0)").run().lastInsertRowid);

    const insert = db.prepare(`
        INSERT INTO lessons (semester_id, group_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
                             time_start, time_end, subject, kind)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'lesson')
    `);
    const row = (semester, day, weekType, week, fromWeek, removed, start, subject) =>
        insert.run(semester, group, day, weekType, week, fromWeek, removed, start, `${start.slice(0, 2)}:${Number(start.slice(3)) + 30 < 60 ? '30' : '59'}`, subject);

    row(autumn, 1, 0, null, 1, 0, '08:00', 'Каждую неделю');
    row(autumn, 1, 0, null, 3, 0, '08:00', 'Новая версия с 3-й');
    row(autumn, 2, 1, null, 1, 0, '09:40', 'Нечётная');
    row(autumn, 2, 2, null, 1, 0, '09:40', 'Чётная');
    row(autumn, 3, 0, null, 1, 0, '11:30', 'Убрана с 4-й');
    row(autumn, 3, 0, null, 4, 1, '11:30', 'Убрана с 4-й');
    row(autumn, 4, 0, 2, 1, 0, '13:10', 'Своя неделя 2');
    row(autumn, 5, 0, 5, 1, 1, '15:00', 'Только отметка — неделя 5 пустая');
    row(autumn, 6, 0, 8, 1, 0, '08:00', 'Отработка после последней недели');
    row(spring, 1, 0, null, 1, 0, '08:00', 'Весна');
    row(spring, 3, 2, null, 1, 0, '09:40', 'Весна чётная');

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    let compared = 0;
    let withPairs = 0;
    for (let from = '2026-08-24'; from < '2027-01-10'; from = addDaysToIsoDate(from, 28)) {
        const data = await (await fetch(`${baseUrl}/api/schedule/${group}?date=${from}&days=28`)).json();

        for (let i = 0; i < 28; i += 1) {
            const iso = addDaysToIsoDate(from, i);
            const [y, m, d] = iso.split('-').map(Number);
            const page = resolveLessonsForDay(data, new Date(y, m - 1, d)).map((l) => l.id);
            const server = resolveGroupLessons(db, group, iso).lessons.map((l) => l.id);
            assert.deepEqual(server, page, iso);
            compared += 1;
            if (page.length) withPairs += 1;
        }
    }

    assert.ok(compared > 120 && withPairs >= 18, `${compared} days, ${withPairs} with pairs`);
});
