const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Editing and removing pairs in the template view, over a semester with a
// moving clock. An edit is a new version from "this week": earlier weeks keep
// the old version, the teacher's hours follow whichever version students saw,
// and removing a pair stops its hours from that week on.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-tpl-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };
const localDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

test('template view: edit, move and remove keep past weeks and hours right', async (t) => {
    const { resolveLessonsForDay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'scheduleResolve.js')).href);

    const db = getDb();
    db.exec(`
        DELETE FROM lessons; DELETE FROM load_plan; DELETE FROM semesters; DELETE FROM teachers; DELETE FROM disciplines;
        DELETE FROM admins; DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    const universityId = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23303')").run(universityId).lastInsertRowid);
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));

    const headers = { Authorization: `Bearer ${createToken({ id: 1, username: 'admin' })}`, 'Content-Type': 'application/json' };
    const call = async (method, url, body) => {
        const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, data: await response.json() };
    };
    const ok = async (method, url, body) => {
        const result = await call(method, url, body);
        assert.ok(result.status < 300, `${method} ${url} → ${result.status} ${JSON.stringify(result.data)}`);
        return result.data;
    };
    const mondays = async (days) => {
        const schedule = await ok('GET', `/api/schedule/${groupId}?date=${days[0]}&days=60`);
        return Object.fromEntries(days.map((day) => [day, resolveLessonsForDay(schedule, localDate(day)).map((l) => `${l.time_start} ${l.room}`)]));
    };
    const hours = async (planId) => (await ok('GET', `/api/admin/load-plan?semester_id=${semester.id}`)).find((p) => p.id === planId).progress.occurred_hours;

    at('2026-08-25T10:00:00');
    const semester = await ok('POST', '/api/admin/semesters', { label: 'Осень', start_date: '2026-08-31', weeks_count: 10, first_week_parity: 1 });
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { is_active: true });
    const teacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Иванов И.И.' })).id;
    const disciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;
    const plan = async (type) => ok('POST', '/api/admin/load-plan', {
        semester_id: semester.id, teacher_id: teacherId, discipline_id: disciplineId, lesson_type: type, group_id: groupId, planned_hours: 20
    });
    const mondayPlan = await plan('Лекция');
    const wednesdayPlan = await plan('Практика');

    const pair = { group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', week_type: 0, subject: 'Физика', room: '101' };
    let monday = await ok('POST', '/api/admin/lessons', pair);
    await ok('PUT', `/api/admin/lessons/${monday.id}/load-plan`, { load_plan_id: mondayPlan.id });
    const wednesday = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 3 });
    await ok('PUT', `/api/admin/lessons/${wednesday.id}/load-plan`, { load_plan_id: wednesdayPlan.id });

    // Week 3: room change in the template view.
    at('2026-09-16T12:00:00');
    const blind = await call('POST', '/api/admin/lessons', { ...pair, room: '202' });
    assert.equal(blind.status, 409, 'a second pair into an occupied cell is still refused');
    monday = await ok('POST', '/api/admin/lessons', { ...pair, room: '202', replaces_lesson_id: monday.id });
    assert.equal(monday.load_plan_id, mondayPlan.id, 'the new version keeps the load-plan link');

    // Week 5: the pair moves to 09:40.
    at('2026-09-30T12:00:00');
    monday = await ok('POST', '/api/admin/lessons', { ...pair, room: '202', time_start: '09:40', time_end: '11:10', replaces_lesson_id: monday.id });

    // Week 7: removed from the template (via the view, naming the row); the
    // Wednesday pair is removed the way an older page did it, without naming it.
    at('2026-10-14T12:00:00');
    await ok('POST', '/api/admin/lessons', { ...pair, room: '202', time_start: '09:40', time_end: '11:10', is_removed: true, replaces_lesson_id: monday.id });
    await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 3, is_removed: true });

    assert.deepEqual(await mondays(['2026-09-07', '2026-09-21', '2026-10-05', '2026-10-19']), {
        '2026-09-07': ['08:00 101'], // week 2: original
        '2026-09-21': ['08:00 202'], // week 4: new room
        '2026-10-05': ['09:40 202'], // week 6: moved, and only once — the old cell is retired
        '2026-10-19': [] // week 8: removed
    });

    // A pair added this week and corrected this week is fixed in place, not stacked.
    const fresh = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 5, room: '305' });
    const rowsBefore = db.prepare('SELECT COUNT(*) AS c FROM lessons').get().c;
    const corrected = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 5, room: '306', replaces_lesson_id: fresh.id });
    assert.equal(corrected.id, fresh.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM lessons').get().c, rowsBefore);

    // After the semester: both pairs ran in weeks 1–6 only.
    at('2026-11-20T12:00:00');
    assert.equal(await hours(mondayPlan.id), 12);
    assert.equal(await hours(wednesdayPlan.id), 12);
});
