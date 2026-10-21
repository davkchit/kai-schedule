const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// The findings of the independent review (2026-10-21), each driven through
// the real API with a moving clock. Every test starts from a clean group.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.ADMIN_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-review-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };
const localDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

let ctx;

test.before(async () => {
    const { resolveLessonsForDay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'scheduleResolve.js')).href);
    const db = getDb();
    db.exec('DELETE FROM admins;');
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));
    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${createToken({ id: 1, username: 'admin' })}`, 'Content-Type': 'application/json' };
    const call = async (method, url, body) => {
        const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, data: await response.json().catch(() => null) };
    };
    const ok = async (method, url, body) => {
        const result = await call(method, url, body);
        assert.ok(result.status < 300, `${method} ${url} → ${result.status} ${JSON.stringify(result.data)}`);
        return result.data;
    };
    ctx = { db, baseUrl, call, ok, resolveLessonsForDay, close: () => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })) };
});

test.after(async () => { delete process.env.KAI_FAKE_NOW; await ctx.close(); });

/** A clean world: one group, an 18-week autumn from 31.08.2026, two teachers, one discipline, plan rows for both. */
async function freshWorld() {
    const { db, ok } = ctx;
    db.exec(`
        DELETE FROM lessons; DELETE FROM load_plan; DELETE FROM attestations; DELETE FROM semesters;
        DELETE FROM teachers; DELETE FROM disciplines; DELETE FROM groups_; DELETE FROM universities; DELETE FROM login_attempts;
    `);
    const uni = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23101')").run(uni).lastInsertRowid);
    at('2026-08-25T10:00:00');
    const semester = await ok('POST', '/api/admin/semesters', { label: 'Осень', start_date: '2026-08-31', weeks_count: 18, first_week_parity: 1 });
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { is_active: true });
    const teacherA = (await ok('POST', '/api/admin/teachers', { full_name: 'Учитель А.А.' })).id;
    const teacherB = (await ok('POST', '/api/admin/teachers', { full_name: 'Учитель Б.Б.' })).id;
    const discipline = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;
    const plan = async (teacherId) => (await ok('POST', '/api/admin/load-plan', {
        semester_id: semester.id, teacher_id: teacherId, discipline_id: discipline, lesson_type: 'Лекция', group_id: groupId, planned_hours: 40
    })).id;
    const planA = await plan(teacherA);
    const planB = await plan(teacherB);
    const pair = { group_id: groupId, day_of_week: 2, time_start: '08:00', time_end: '09:30', week_type: 0, subject: 'Физика', room: '101', teacher_id: teacherA, discipline_id: discipline, lesson_type: 'Лекция' };
    const hours = async (planId) => (await ok('GET', `/api/admin/load-plan?semester_id=${semester.id}`)).find((row) => row.id === planId).progress.occurred_hours;
    const sees = async (day) => {
        const schedule = await ok('GET', `/api/schedule/${groupId}?date=${day}&days=1`);
        return ctx.resolveLessonsForDay(schedule, localDate(day)).map((item) => `${item.time_start} ${item.subject} ${item.room ?? ''}`.trim());
    };
    return { groupId, semester, teacherA, teacherB, discipline, planA, planB, pair, hours, sees };
}

test('1. a teacher replaced in the template stops earning hours from the week of the change', async () => {
    const { ok } = ctx;
    const w = await freshWorld();
    const original = await ok('POST', '/api/admin/lessons', w.pair);

    at('2026-09-21T10:00:00'); // Monday of week 4: Tuesday's pair is still ahead
    const replaced = await ok('POST', '/api/admin/lessons', { ...w.pair, teacher_id: w.teacherB, replaces_lesson_id: original.id });
    assert.equal(replaced.template_from_week, 4);

    at('2026-12-27T12:00:00'); // Sunday of week 17
    assert.equal(await w.hours(w.planA), 6, 'А: weeks 1–3 only');
    assert.equal(await w.hours(w.planB), 28, 'Б: weeks 4–17');
});

test('2–3. a version made this week, then moved or deleted the same week, leaves no older version showing', async () => {
    const { ok } = ctx;

    for (const how of ['modal', 'drag', 'delete']) {
        const w = await freshWorld();
        const original = await ok('POST', '/api/admin/lessons', w.pair);

        at('2026-09-21T10:00:00'); // Monday of week 4
        const roomFix = await ok('POST', '/api/admin/lessons', { ...w.pair, room: '202', replaces_lesson_id: original.id });
        assert.equal(roomFix.template_from_week, 4);

        if (how === 'modal') {
            await ok('POST', '/api/admin/lessons', { ...w.pair, room: '202', day_of_week: 4, replaces_lesson_id: roomFix.id });
        } else if (how === 'drag') {
            await ok('POST', '/api/admin/schedule/move-lesson', { lesson_id: roomFix.id, mode: 'template', day_of_week: 4, time_start: '08:00', time_end: '09:30' });
        } else {
            await ok('DELETE', `/api/admin/lessons/${roomFix.id}`);
        }

        // Week 5: Tuesday 29.09, Thursday 01.10. Week 3 (the past) unchanged.
        assert.deepEqual(await w.sees('2026-09-29'), [], `${how}: the old Tuesday version does not come back`);
        assert.deepEqual(await w.sees('2026-10-01'), how === 'delete' ? [] : ['08:00 Физика 202'], `${how}: Thursday`);
        assert.deepEqual(await w.sees('2026-09-15'), ['08:00 Физика 101'], `${how}: week 3 as it was`);

        at('2026-12-27T12:00:00');
        assert.equal(await w.hours(w.planA), how === 'delete' ? 6 : 6 + 28, `${how}: hours follow what students saw`);
    }
});

test('7. a drag from a stale constructor tab is refused instead of rewriting the template in place', async () => {
    const { ok, call } = ctx;
    const w = await freshWorld();
    const original = await ok('POST', '/api/admin/lessons', w.pair);
    const other = await ok('POST', '/api/admin/lessons', { ...w.pair, time_start: '11:30', time_end: '13:00' });

    at('2026-10-21T12:00:00'); // week 8; the drags are in week 9
    // Tab 1: a move in week 9 makes the week its own.
    await ok('POST', '/api/admin/schedule/move-lesson', { lesson_id: other.id, mode: 'week', week_number: 9, day_of_week: 3, time_start: '11:30', time_end: '13:00' });
    // Tab 2, not refreshed, still drags the template row in week 9.
    const stale = await call('POST', '/api/admin/schedule/move-lesson', { lesson_id: original.id, mode: 'week', week_number: 9, day_of_week: 4, time_start: '08:00', time_end: '09:30' });
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /обновите страницу/);
    assert.deepEqual(await w.sees('2026-09-22'), ['08:00 Физика 101', '11:30 Физика 101'], 'a past Tuesday keeps its pairs');

    // A week row dragged in the template view is refused too.
    const weekRow = ctx.db.prepare('SELECT id FROM lessons WHERE specific_week = 9 AND is_removed = 0 LIMIT 1').get();
    assert.equal((await call('POST', '/api/admin/schedule/move-lesson', { lesson_id: weekRow.id, mode: 'template', day_of_week: 5, time_start: '08:00', time_end: '09:30' })).status, 409);
});

test('5. a semester cannot be shortened past weeks entered on their own', async () => {
    const { ok, call } = ctx;
    const w = await freshWorld();
    at('2026-10-21T12:00:00');
    await ok('POST', '/api/admin/lessons', { ...w.pair, specific_week: 17 });

    const refused = await call('PUT', `/api/admin/semesters/${w.semester.id}`, { weeks_count: 16 });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.data.weeks, [17]);
    assert.equal(ctx.db.prepare('SELECT weeks_count FROM semesters WHERE id = ?').get(w.semester.id).weeks_count, 18);

    await ok('PUT', `/api/admin/semesters/${w.semester.id}`, { weeks_count: 17 }); // week 17 stays inside
});

test('4. pairs an exam took out of its day come back when the exam moves or is deleted', async () => {
    const { ok } = ctx;
    const w = await freshWorld();
    await ok('POST', '/api/admin/lessons', w.pair);
    const exam = { semester_id: w.semester.id, group_id: w.groupId, kind: 'exam', date: '2026-11-03', time_start: '08:00', discipline_id: w.discipline, teacher_id: w.teacherA, confirm: true, remove_pairs: true };

    at('2026-10-21T12:00:00');
    // A week still run by the template (week 10, 03.11) and one with its own rows (week 11, 10.11).
    await ok('POST', '/api/admin/lessons', { ...w.pair, time_start: '11:30', time_end: '13:00', specific_week: 11 });
    const first = await ok('POST', '/api/admin/attestations', exam);
    assert.equal(first.removed_pairs, 1);
    assert.deepEqual(await w.sees('2026-11-03'), ['08:00 Физика'], 'only the exam (no room) that day');

    const moved = await ok('PUT', `/api/admin/attestations/${first.id}`, { ...exam, date: '2026-11-10', time_start: '11:30' });
    assert.equal(moved.restored_pairs, 1);
    assert.equal(moved.removed_pairs, 1);
    assert.deepEqual(await w.sees('2026-11-03'), ['08:00 Физика 101'], 'the old day has its pair back');
    assert.deepEqual(await w.sees('2026-11-10'), ['11:30 Физика']);

    // An edit that keeps date and time (a room) leaves the pair out.
    assert.equal((await ok('PUT', `/api/admin/attestations/${first.id}`, { ...exam, date: '2026-11-10', time_start: '11:30', room: '305' })).restored_pairs, 0);
    assert.deepEqual(await w.sees('2026-11-10'), ['11:30 Физика 305']);

    // Its time taken meanwhile by another pair: the hidden one stays out.
    await ok('POST', '/api/admin/lessons', { ...w.pair, time_start: '11:30', time_end: '13:00', room: '777', specific_week: 11 });
    const deleted = await ok('DELETE', `/api/admin/attestations/${first.id}`);
    assert.equal(deleted.restored_pairs, 0);
    assert.deepEqual(await w.sees('2026-11-10'), ['11:30 Физика 777']);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE hidden_by_attestation IS NOT NULL').get().n, 0);
});

test('8. a week whose own rows are all the other subgroup\'s is still its own on a one-subgroup page', async () => {
    const { ok } = ctx;
    const w = await freshWorld();
    await ok('POST', '/api/admin/lessons', w.pair);
    at('2026-10-21T12:00:00');
    // Week 9 made its own with a single pair for п/г 2 (the whole-group pair not carried in).
    ctx.db.prepare(`INSERT INTO lessons (group_id, subgroup, day_of_week, week_type, specific_week, time_start, time_end, subject, room, lesson_type, semester_id)
        VALUES (?, 2, 4, 0, 9, '10:00', '11:30', 'Физика', '303', 'Лекция', ?)`).run(w.groupId, w.semester.id);

    const day = '2026-10-27'; // Tuesday of week 9
    const forSubgroup = async (subgroup) => {
        const schedule = await ok('GET', `/api/schedule/${w.groupId}?date=${day}&days=1&subgroup=${subgroup}`);
        return ctx.resolveLessonsForDay(schedule, localDate(day)).length;
    };
    assert.equal(await forSubgroup(1), 0, 'п/г 1 sees the week as its own: no template pair');
    assert.equal(await forSubgroup(0), 0);
    assert.equal(await forSubgroup(2), 0);
});

test('minor: joining with twin plan rows, deleting a group with exams, absurd dates, oversized bodies', async () => {
    const { ok, call, db, baseUrl } = ctx;
    const w = await freshWorld();
    const uni = db.prepare('SELECT university_id FROM groups_ WHERE id = ?').get(w.groupId).university_id;
    const member = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23103')").run(uni).lastInsertRowid);

    // The member has its own row for the same teaching as the leader's planA.
    const twin = await ok('POST', '/api/admin/load-plan', { semester_id: w.semester.id, teacher_id: w.teacherA, discipline_id: w.discipline, lesson_type: 'Лекция', group_id: member, planned_hours: 40 });
    const refused = await call('PUT', `/api/admin/groups/${member}`, { joined_to: w.groupId });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /дважды/);
    await ok('POST', '/api/admin/load-plan/merge', { ids: [w.planA, twin.id] });
    await ok('PUT', `/api/admin/groups/${member}`, { joined_to: w.groupId });
    await ok('PUT', `/api/admin/groups/${member}`, { joined_to: null });

    // A group with an exam (and nothing else) is not deleted with it.
    db.exec('DELETE FROM load_plan_extra_groups');
    await ok('POST', '/api/admin/attestations', { semester_id: w.semester.id, group_id: member, kind: 'exam', date: '2027-01-15', time_start: '09:00', discipline_id: w.discipline, teacher_id: w.teacherA, confirm: true });
    const deleteRefused = await call('DELETE', `/api/admin/groups/${member}`);
    assert.equal(deleteRefused.status, 409);
    assert.match(deleteRefused.data.error, /сессии/);

    assert.equal((await call('GET', `/api/schedule/${w.groupId}?date=0002-01-01`)).status, 400);
    assert.equal((await call('GET', `/api/schedule/${w.groupId}?date=9999-12-31`)).status, 400);

    const huge = await fetch(`${baseUrl}/api/client-error`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(40000) }) });
    assert.equal(huge.status, 413);
});
