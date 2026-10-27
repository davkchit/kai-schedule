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
const { getSemesterWeekMeta } = require('../server/utils/date');
const { resolveTemplateLessons } = require('../server/utils/templateResolve');

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
    // The constructor's draft for a day — what entering that week would copy in.
    const draft = (day) => {
        const current = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semester.id);
        const { weekNumber, weekTypeNumber } = getSemesterWeekMeta(current, day);
        const rows = db.prepare('SELECT * FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND day_of_week = ? AND (week_type = 0 OR week_type = ?)')
            .all(semester.id, groupId, localDate(day).getDay() || 7, weekTypeNumber);
        return resolveTemplateLessons(rows, weekNumber).map((item) => `${item.time_start} ${item.subject} ${item.room ?? ''}`.trim()).sort();
    };
    // Weeks entered as the template has them (as the specialist does each Thursday); an empty draft enters nothing.
    const enter = async (from, to) => {
        for (let week = from; week <= to; week += 1) {
            await ctx.call('POST', '/api/admin/schedule/materialize-week', { group_id: groupId, week_number: week, action: 'copy' });
        }
    };
    return { groupId, semester, teacherA, teacherB, discipline, planA, planB, pair, hours, sees, draft, enter };
}

test('1. a teacher replaced in the template stops earning hours from the week of the change', async () => {
    const { ok } = ctx;
    const w = await freshWorld();
    const original = await ok('POST', '/api/admin/lessons', w.pair);

    at('2026-09-21T10:00:00'); // Monday of week 4: Tuesday's pair is still ahead
    const replaced = await ok('POST', '/api/admin/lessons', { ...w.pair, teacher_id: w.teacherB, replaces_lesson_id: original.id });
    assert.equal(replaced.template_from_week, 4);

    // Each week entered from the draft as it stood for that week.
    await w.enter(1, 17);
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

        // Every week entered from the draft; then week 5: Tuesday 29.09, Thursday 01.10. Week 3 unchanged.
        await w.enter(1, 17);
        at('2026-12-27T12:00:00');
        assert.deepEqual(await w.sees('2026-09-29'), [], `${how}: the old Tuesday version does not come back`);
        assert.deepEqual(await w.sees('2026-10-01'), how === 'delete' ? [] : ['08:00 Физика 202'], `${how}: Thursday`);
        assert.deepEqual(await w.sees('2026-09-15'), ['08:00 Физика 101'], `${how}: week 3 as it was`);

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
    assert.deepEqual(w.draft('2026-09-22'), ['08:00 Физика 101', '11:30 Физика 101'], 'the draft of a past Tuesday keeps its pairs');

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

    at('2026-11-02T07:00:00'); // Monday of week 10; week 11 entered, so open too
    // Week 10 (03.11) entered as the template has it; week 11 (10.11) with a pair added.
    await w.enter(10, 10);
    await ok('POST', '/api/admin/schedule/materialize-week', { group_id: w.groupId, week_number: 11, action: 'upsert', day_of_week: 2, time_start: '11:30', time_end: '13:00', subgroup: 0, subject: 'Физика', room: '101', lesson_type: 'Лекция', teacher_id: w.teacherA, discipline_id: w.discipline });
    const first = await ok('POST', '/api/admin/attestations', exam);
    assert.equal(first.removed_pairs, 1);
    assert.deepEqual(await w.sees('2026-11-03'), ['08:00 Физика'], 'only the exam (no room) that day');

    const moved = await ok('PUT', `/api/admin/attestations/${first.id}`, { ...exam, date: '2026-11-10', time_start: '11:30' });
    assert.equal(moved.restored_pairs, 1);
    assert.equal(moved.removed_pairs, 1);
    assert.deepEqual(await w.sees('2026-11-03'), ['08:00 Физика 101'], 'the old day has its pair back');
    assert.deepEqual(await w.sees('2026-11-10'), ['08:00 Физика 101', '11:30 Физика']);

    // An edit that keeps date and time (a room) leaves the pair out.
    assert.equal((await ok('PUT', `/api/admin/attestations/${first.id}`, { ...exam, date: '2026-11-10', time_start: '11:30', room: '305' })).restored_pairs, 0);
    assert.deepEqual(await w.sees('2026-11-10'), ['08:00 Физика 101', '11:30 Физика 305']);

    // Its time taken meanwhile by another pair: the hidden one stays out.
    await ok('POST', '/api/admin/lessons', { ...w.pair, time_start: '11:30', time_end: '13:00', room: '777', specific_week: 11 });
    const deleted = await ok('DELETE', `/api/admin/attestations/${first.id}`);
    assert.equal(deleted.restored_pairs, 0);
    assert.deepEqual(await w.sees('2026-11-10'), ['08:00 Физика 101', '11:30 Физика 777']);
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

test('a session record with an end time and a pair of the group never overlap — either way', async () => {
    const { ok, call } = ctx;
    const w = await freshWorld();
    at('2026-10-21T12:00:00');
    // Week 10: Tuesday 03.11. One pair of the week's own at 08:00–09:30.
    await ok('POST', '/api/admin/lessons', { ...w.pair, specific_week: 10 });
    const exam = { semester_id: w.semester.id, group_id: w.groupId, kind: 'exam', date: '2026-11-03', time_start: '08:00', time_end: '10:00', discipline_id: w.discipline, teacher_id: w.teacherA };

    // Over the pair: refused, and «save anyway» does not get past it.
    const clash = await call('POST', '/api/admin/attestations', exam);
    assert.equal(clash.status, 409);
    assert.equal(clash.data.pair_clash, true);
    assert.equal(clash.data.can_remove, true);
    assert.equal((await call('POST', '/api/admin/attestations', { ...exam, confirm: true })).status, 409);
    // Only in the pair's place.
    const placed = await ok('POST', '/api/admin/attestations', { ...exam, remove_pairs: true });
    assert.equal(placed.removed_pairs, 1);

    // A credit of п/г 1 can't take a whole-group pair from п/г 2.
    await ok('POST', '/api/admin/lessons', { ...w.pair, specific_week: 10, day_of_week: 3 });
    const partial = await call('POST', '/api/admin/attestations', { ...exam, kind: 'credit', subgroup: 1, date: '2026-11-04', remove_pairs: true, confirm: true });
    assert.equal(partial.status, 409);
    assert.equal(partial.data.can_remove, false);

    // Without an end time it stays a warning the specialist may confirm.
    const open = await call('POST', '/api/admin/attestations', { ...exam, kind: 'credit', date: '2026-11-04', time_end: null });
    assert.equal(open.data.needs_confirm, true);

    // The other way: no pair over the timed exam (03.11 08:00–10:00).
    const onto = await call('POST', '/api/admin/lessons', { ...w.pair, specific_week: 10, time_start: '09:40', time_end: '11:10' });
    assert.equal(onto.status, 409);
    assert.match(onto.data.error, /экзамен «Физика» 03\.11 08:00–10:00 — пару сюда поставить нельзя/);
    // Right after it is fine.
    const after = await ok('POST', '/api/admin/lessons', { ...w.pair, specific_week: 10, time_start: '10:10', time_end: '11:40' });
    // …but not moved, edited or dragged onto it.
    assert.equal((await call('PUT', `/api/admin/lessons/${after.id}`, { time_start: '09:00', time_end: '10:30' })).status, 409);
    assert.equal((await call('POST', '/api/admin/schedule/move-lesson', { lesson_id: after.id, mode: 'week', week_number: 10, day_of_week: 2, time_start: '08:00', time_end: '09:30' })).status, 409);
    // A template pair is only the draft: allowed, and when week 10 is entered
    // from it, the pair under the exam comes in already taken out by it.
    ctx.db.exec('DELETE FROM lessons WHERE specific_week = 10');
    await ok('POST', '/api/admin/lessons', { ...w.pair, time_start: '09:00', time_end: '10:30' });
    await w.enter(10, 10);
    const copied = ctx.db.prepare("SELECT is_removed, hidden_by_attestation FROM lessons WHERE specific_week = 10 AND time_start = '09:00'").get();
    assert.equal(copied.is_removed, 1);
    assert.equal(copied.hidden_by_attestation, placed.id);
});

test('a semester change does not move pairs under a session record with an end time', async () => {
    const { ok, call } = ctx;
    const w = await freshWorld();
    at('2026-08-25T10:00:00');
    // Week 10 entered: Tuesday 03.11 08:00. A credit the Tuesday after, 10.11 08:00–09:30.
    await ok('POST', '/api/admin/lessons', { ...w.pair, specific_week: 10 });
    await ok('POST', '/api/admin/attestations', { semester_id: w.semester.id, group_id: w.groupId, kind: 'credit', date: '2026-11-10', time_start: '08:00', time_end: '09:30', discipline_id: w.discipline, teacher_id: w.teacherA });

    // Starting a week later moves week 10 onto 10.11 — under the credit.
    const preview = await ok('GET', `/api/admin/semesters/${w.semester.id}/impact?start_date=2026-09-07`);
    assert.match(preview.blocked.error, /под записи сессии/);
    const refused = await call('PUT', `/api/admin/semesters/${w.semester.id}`, { start_date: '2026-09-07' });
    assert.equal(refused.status, 409);
    assert.equal(ctx.db.prepare('SELECT start_date FROM semesters WHERE id = ?').get(w.semester.id).start_date, '2026-08-31', 'nothing changed');

    // A change that leaves the dates alone is not held up by it.
    await ok('PUT', `/api/admin/semesters/${w.semester.id}`, { label: 'Осень 2026' });
});

test('a pair added to a week run by a non-empty template is refused; a removal marker is not deleted', async () => {
    const { ok, call } = ctx;
    const w = await freshWorld();
    await ok('POST', '/api/admin/lessons', w.pair);
    at('2026-10-21T12:00:00');
    const stale = await call('POST', '/api/admin/lessons', { ...w.pair, day_of_week: 4, specific_week: 10 });
    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /обновите страницу/);
    assert.deepEqual(w.draft('2026-11-03'), ['08:00 Физика 101'], 'the week is still not entered: the draft holds');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE specific_week = 10').get().n, 0);

    const original = ctx.db.prepare('SELECT id FROM lessons WHERE specific_week IS NULL').get();
    await ok('DELETE', `/api/admin/lessons/${original.id}`); // tombstone from now on
    const tombstone = ctx.db.prepare('SELECT id FROM lessons WHERE is_removed = 1').get();
    assert.equal((await call('DELETE', `/api/admin/lessons/${tombstone.id}`)).status, 409);
    assert.deepEqual(w.draft('2026-10-27'), [], 'the removal stays');
    assert.deepEqual(w.draft('2026-09-15'), ['08:00 Физика 101'], 'the past keeps its pair');
});

test('minor 7–10: restore under another record, unjoin keeps the link, join and closed records, preview Monday', async () => {
    const { ok, call, db } = ctx;
    const w = await freshWorld();
    at('2026-10-21T12:00:00');
    await ok('POST', '/api/admin/schedule/materialize-week', { group_id: w.groupId, week_number: 11, action: 'upsert', day_of_week: 2, time_start: '08:00', time_end: '09:30', subgroup: 0, subject: 'Физика', room: '101', lesson_type: 'Лекция', teacher_id: w.teacherA, discipline_id: w.discipline });
    const base = { semester_id: w.semester.id, group_id: w.groupId, date: '2026-11-10', discipline_id: w.discipline, teacher_id: w.teacherA };

    // 7. Exam A takes the pair out; credit B lands at that time too; A goes — the pair stays out under B.
    const a = await ok('POST', '/api/admin/attestations', { ...base, kind: 'exam', time_start: '08:00', time_end: '09:30', remove_pairs: true });
    await ok('POST', '/api/admin/attestations', { ...base, kind: 'credit', time_start: '08:00', time_end: '09:00', confirm: true });
    assert.equal((await ok('DELETE', `/api/admin/attestations/${a.id}`)).restored_pairs, 0);
    assert.deepEqual(await w.sees('2026-11-10'), ['08:00 Физика'], 'only the credit');

    // 8. Joined, an exam of the leader takes a pair out; split; the member's copy of the exam brings the member's pair back.
    db.exec('DELETE FROM attestations');
    db.prepare("UPDATE lessons SET is_removed = 0, hidden_by_attestation = NULL WHERE specific_week = 11").run();
    const uni = db.prepare('SELECT university_id FROM groups_ WHERE id = ?').get(w.groupId).university_id;
    const member = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23111')").run(uni).lastInsertRowid);
    await ok('PUT', `/api/admin/groups/${member}`, { joined_to: w.groupId });
    await ok('POST', '/api/admin/attestations', { ...base, kind: 'exam', time_start: '08:00', time_end: '09:30', remove_pairs: true });
    await ok('PUT', `/api/admin/groups/${member}`, { joined_to: null });
    const copy = db.prepare('SELECT id FROM attestations WHERE group_id = ?').get(member);
    assert.equal((await ok('DELETE', `/api/admin/attestations/${copy.id}`)).restored_pairs, 1);

    // 9. A member with a record (and no pairs) in a closed semester is not joined.
    db.prepare('DELETE FROM lessons WHERE group_id = ?').run(member);
    await ok('POST', '/api/admin/attestations', { ...base, group_id: member, kind: 'credit', date: '2026-12-29', time_start: '10:00', time_end: '11:00' });
    await ok('POST', `/api/admin/semesters/${w.semester.id}/close`);
    const refused = await call('PUT', `/api/admin/groups/${member}`, { joined_to: w.groupId });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /записи сессии в закрытом семестре/);
    await ok('POST', `/api/admin/semesters/${w.semester.id}/reopen`);

    // 10. The preview speaks of the Monday that saving would store.
    const preview = await ok('GET', `/api/admin/semesters/${w.semester.id}/impact?start_date=2026-09-02`);
    assert.equal(preview.proposed.start_date, '2026-08-31');
});

test('an edit made «from next week» can be edited again the same week', async () => {
    const { ok } = ctx;
    const w = await freshWorld();
    const original = await ok('POST', '/api/admin/lessons', w.pair); // Tuesday
    at('2026-10-21T12:00:00'); // Wednesday of week 8: Tuesday is over, edits start in week 9

    const first = await ok('POST', '/api/admin/lessons', { ...w.pair, teacher_id: w.teacherB, replaces_lesson_id: original.id });
    assert.equal(first.template_from_week, 9);
    // The template view of week 8 still shows the original — edited again from there.
    const second = await ok('POST', '/api/admin/lessons', { ...w.pair, room: '303', replaces_lesson_id: original.id });
    assert.equal(second.template_from_week, 9);

    assert.deepEqual(w.draft('2026-10-20'), ['08:00 Физика 101'], 'this week as it was');
    assert.deepEqual(w.draft('2026-10-27'), ['08:00 Физика 303'], 'next week: the latest edit only');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE template_from_week = 9').get().n, 1, 'one version from week 9');
});

test('a semester closed mid-term: the breakdown stops where the total stopped', async () => {
    const { ok } = ctx;
    const w = await freshWorld();
    await ok('POST', '/api/admin/lessons', w.pair);
    at('2026-09-23T12:00:00'); // week 4: four Tuesdays held
    await w.enter(1, 6);
    await ok('POST', `/api/admin/semesters/${w.semester.id}/close`);
    at('2026-12-01T12:00:00'); // weeks later
    const row = (await ok('GET', `/api/admin/load-plan?semester_id=${w.semester.id}`)).find((plan) => plan.id === w.planA);
    assert.equal(row.progress.occurred_hours, 8);
    assert.equal(row.progress.occurred_count, 4);
    // The teacher page lists the pairs one by one.
    const teacherRow = (await ok('GET', `/api/teachers/${w.teacherA}/load?semester_id=${w.semester.id}`)).plan.find((plan) => plan.id === w.planA);
    assert.equal(teacherRow.occurred_hours, 8);
    assert.equal(teacherRow.occurrences.filter((occurrence) => occurrence.has_occurred).length, 4, 'not the 14 Tuesdays gone by since');
});

test('a pair put in this week next to one moved there from next week is refused', async () => {
    const { ok, call } = ctx;
    const w = await freshWorld();
    const monday = await ok('POST', '/api/admin/lessons', { ...w.pair, day_of_week: 1 });
    const other = await ok('POST', '/api/admin/lessons', { ...w.pair, day_of_week: 5, time_start: '13:10', time_end: '14:40' });
    at('2026-11-16T14:00:00'); // Monday of week 12, its 08:00 pair is over
    // Monday's pair moves to Wednesday 08:30 — from week 13, since Monday's half already ran.
    await ok('POST', '/api/admin/schedule/move-lesson', { lesson_id: monday.id, mode: 'template', day_of_week: 3, time_start: '08:30', time_end: '10:00' });
    // Another pair into Wednesday 08:00 from this week (12): from week 13 the two would overlap.
    const clash = await call('POST', '/api/admin/lessons', { ...w.pair, day_of_week: 3, replaces_lesson_id: other.id });
    assert.equal(clash.status, 409);
});
