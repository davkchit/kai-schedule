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

    const pair = {
        group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', week_type: 0, subject: 'Физика', room: '101',
        teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Лекция'
    };
    let monday = await ok('POST', '/api/admin/lessons', pair);
    const wednesday = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 3, lesson_type: 'Практика' });
    assert.equal(monday.teacher_id, teacherId);
    assert.equal(wednesday.discipline_id, disciplineId);

    // Week 3: room change in the template view.
    at('2026-09-16T12:00:00');
    const blind = await call('POST', '/api/admin/lessons', { ...pair, room: '202' });
    assert.equal(blind.status, 409, 'a second pair into an occupied cell is still refused');
    monday = await ok('POST', '/api/admin/lessons', { ...pair, room: '202', replaces_lesson_id: monday.id });
    assert.equal(monday.teacher_id, teacherId, 'the new version keeps the same identity');
    assert.equal(monday.discipline_id, disciplineId);

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

    // A pair added this week and corrected this week is fixed in place, not
    // stacked. A different teacher/discipline than Monday's, on purpose —
    // otherwise it would count toward mondayPlan too, since matching cares
    // about identity, not which cell it happened to be created in.
    const fridayTeacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Пятницын П.П.' })).id;
    const fridayDisciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Другой предмет' })).id;
    const freshPair = { ...pair, teacher_id: fridayTeacherId, discipline_id: fridayDisciplineId, subject: 'Другой предмет' };
    const fresh = await ok('POST', '/api/admin/lessons', { ...freshPair, day_of_week: 5, room: '305' });
    const rowsBefore = db.prepare('SELECT COUNT(*) AS c FROM lessons').get().c;
    const corrected = await ok('POST', '/api/admin/lessons', { ...freshPair, day_of_week: 5, room: '306', replaces_lesson_id: fresh.id });
    assert.equal(corrected.id, fresh.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM lessons').get().c, rowsBefore);

    // After the semester: both pairs ran in weeks 1–7. They were removed on
    // week 7's Wednesday at noon, when that week's Monday and Wednesday pairs
    // had already been held — so the removal starts with week 8 and those
    // two stay counted (templateWeekForSlot).
    at('2026-11-20T12:00:00');
    assert.equal(await hours(mondayPlan.id), 14);
    assert.equal(await hours(wednesdayPlan.id), 14);
});

test('a substitute teacher or a one-off replacement simply stops matching the original plan row, no explicit step needed', async (t) => {
    // Same slot, but the content genuinely changes for a week (a substitute,
    // a consultation standing in for the lecture) or for the rest of the
    // semester (a swap in the template). Hours are matched live by identity,
    // so a swapped-in pair just carries a different teacher_id/discipline_id
    // and stops matching the original plan row on its own — there is nothing
    // to "drop" and nothing that could forget to.
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

    at('2026-08-25T10:00:00');
    const semester = await ok('POST', '/api/admin/semesters', { label: 'Осень', start_date: '2026-08-31', weeks_count: 12, first_week_parity: 1 });
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { is_active: true });
    const teacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Иванов И.И.' })).id;
    const disciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;
    const substituteTeacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Петров П.П.' })).id;
    const plan = await ok('POST', '/api/admin/load-plan', {
        semester_id: semester.id, teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Лекция', group_id: groupId, planned_hours: 20
    });
    const pair = {
        group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', week_type: 0, subject: 'Физика', room: '101',
        teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Лекция'
    };
    let lesson = await ok('POST', '/api/admin/lessons', pair);
    assert.equal(lesson.teacher_id, teacherId);

    // ── materialize-week: one week only, a substitute covers the class ──
    at('2026-09-16T12:00:00'); // week 3
    await ok('POST', '/api/admin/schedule/materialize-week', {
        group_id: groupId, week_number: 5, action: 'upsert', day_of_week: 1, time_start: '08:00', time_end: '09:30',
        subject: 'Физика (замена)', teacher: 'Петров П.П.', teacher_id: substituteTeacherId, lesson_type: 'Лекция'
        // discipline_id deliberately omitted — nobody set up a plan row for
        // Петров teaching this, so this week counts toward nobody.
    });
    assert.equal(
        db.prepare('SELECT teacher_id FROM lessons WHERE group_id = ? AND specific_week = 5').get(groupId).teacher_id,
        substituteTeacherId,
        'the week shows the substitute'
    );

    // A room-only fix on another week is a correction — same identity, same room change.
    await ok('POST', '/api/admin/schedule/materialize-week', {
        group_id: groupId, week_number: 6, action: 'upsert', day_of_week: 1, time_start: '08:00', time_end: '09:30',
        subject: 'Физика', teacher: 'Иванов И.И.', teacher_id: teacherId, discipline_id: disciplineId, room: '202', lesson_type: 'Лекция'
    });
    assert.equal(
        db.prepare('SELECT teacher_id FROM lessons WHERE group_id = ? AND specific_week = 6').get(groupId).teacher_id,
        teacherId
    );

    // The set of lessons the plan row would match confirms it directly: week
    // 5 (the substitute) is absent, week 6 (Иванов's own) is present.
    const matchingWeeks = db.prepare(`
        SELECT specific_week FROM lessons
        WHERE teacher_id = ? AND discipline_id = ? AND lesson_type = 'Лекция' AND group_id = ? AND specific_week IN (5, 6)
    `).all(teacherId, disciplineId, groupId).map((row) => row.specific_week);
    assert.deepEqual(matchingWeeks, [6], 'only the corrected week matches the plan; the substitute\'s does not');

    // ── template edit: the swap is meant for the rest of the semester ──
    // Case A: the row has not been live yet (corrected in place, no version stack).
    at('2026-08-26T12:00:00'); // before the semester even starts — week 1, nothing live
    const wednesdayPair = {
        group_id: groupId, day_of_week: 3, time_start: '08:00', time_end: '09:30', week_type: 0, subject: 'Физика',
        teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Практика'
    };
    let wednesday = await ok('POST', '/api/admin/lessons', wednesdayPair);
    const secondPlan = await ok('POST', '/api/admin/load-plan', {
        semester_id: semester.id, teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Практика', group_id: groupId, planned_hours: 10
    });
    assert.equal(wednesday.discipline_id, disciplineId);

    const otherDisciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Другая дисциплина' })).id;
    const otherTeacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Сидорова А.А.' })).id;
    const swappedInPlace = await ok('POST', '/api/admin/lessons', {
        ...wednesdayPair, subject: 'Другая дисциплина', teacher: 'Сидорова А.А.',
        teacher_id: otherTeacherId, discipline_id: otherDisciplineId, replaces_lesson_id: wednesday.id
    });
    assert.equal(swappedInPlace.discipline_id, otherDisciplineId, 'the swapped identity is written');
    assert.equal(swappedInPlace.id, wednesday.id, 'still corrected in place, not stacked as a new row');
    assert.equal(
        (await ok('GET', `/api/admin/load-plan?semester_id=${semester.id}`)).find((row) => row.id === secondPlan.id).progress.occurred_hours,
        0,
        'the original plan row no longer matches anything'
    );

    // Case B: the row IS already live (a real version is inserted).
    at('2026-09-16T12:00:00'); // week 3 — Monday's row has been live since week 1
    lesson = db.prepare('SELECT * FROM lessons WHERE group_id = ? AND day_of_week = 1 AND specific_week IS NULL').get(groupId);
    assert.equal(lesson.teacher_id, teacherId);

    // A distinct discipline of its own — reusing Case A's would resolve to
    // ITS text ('Другая дисциплина'), since an id always wins over whatever
    // text is sent alongside it.
    const thirdDisciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Совсем другой предмет' })).id;
    const newVersion = await ok('POST', '/api/admin/lessons', {
        ...pair, teacher_id: otherTeacherId, discipline_id: thirdDisciplineId, replaces_lesson_id: lesson.id
    });
    assert.equal(newVersion.teacher_id, otherTeacherId);
    assert.equal(newVersion.subject, 'Совсем другой предмет', 'the dictionary\'s own text wins over whatever was typed');
    assert.notEqual(newVersion.id, lesson.id, 'a live row gets a new version, not an in-place update');

    // Students see the swap; the old teacher's hours stop where the swap started.
    const schedule = await ok('GET', `/api/schedule/${groupId}?date=2026-09-21&days=7`);
    assert.deepEqual(
        resolveLessonsForDay(schedule, localDate('2026-09-21')).map((l) => l.subject),
        ['Совсем другой предмет']
    );
});
