const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Holes found by the pre-launch review, each driven through the real API with
// a moving clock and the student page's own day resolution. The live site runs
// with an EMPTY template — every week is entered as its own — so most cases
// here are set up the same way.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-prelaunch-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

const db = () => getDb();
const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };
const localDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

let context;

async function getContext() {
    if (context) return context;

    const { resolveLessonsForDay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'scheduleResolve.js')).href);
    const db = getDb();
    db.exec(`
        DELETE FROM lessons; DELETE FROM load_plan; DELETE FROM attestations; DELETE FROM semesters; DELETE FROM teachers;
        DELETE FROM disciplines; DELETE FROM admins; DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    const universityId = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23101')").run(universityId).lastInsertRowid);
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
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
    const semester = await ok('POST', '/api/admin/semesters', { label: 'Осень', start_date: '2026-08-31', weeks_count: 18, first_week_parity: 1 });
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { is_active: true });
    const teacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Иванов И.И.' })).id;
    const disciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;
    const plan = await ok('POST', '/api/admin/load-plan', {
        semester_id: semester.id, teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Лекция', group_id: groupId, planned_hours: 40
    });

    const download = async (url) => {
        const response = await fetch(`${baseUrl}${url}`, { headers });
        assert.equal(response.status, 200, `GET ${url}`);
        return Buffer.from(await response.arrayBuffer());
    };

    context = {
        db, groupId, semester, teacherId, disciplineId, plan, call, ok, download,
        pair: {
            group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', subject: 'Физика', room: '101',
            teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Лекция'
        },
        hours: async () => (await ok('GET', `/api/admin/load-plan?semester_id=${semester.id}`)).find((row) => row.id === plan.id).progress.occurred_hours,
        studentSees: async (day) => {
            const schedule = await ok('GET', `/api/schedule/${groupId}?date=${day}&days=1`);
            return resolveLessonsForDay(schedule, localDate(day)).map((item) => `${item.time_start} ${item.subject}`);
        },
        // What the constructor's draft (the template) holds for that day — what
        // entering the week would copy in. Students never see it as such.
        draftSees: (day) => {
            const { getSemesterWeekMeta } = require('../server/utils/date');
            const { resolveTemplateLessons } = require('../server/utils/templateResolve');
            const current = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semester.id);
            const { weekNumber, weekTypeNumber } = getSemesterWeekMeta(current, day);
            const weekday = localDate(day).getDay() || 7;
            const rows = db.prepare('SELECT * FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND day_of_week = ? AND (week_type = 0 OR week_type = ?)')
                .all(semester.id, groupId, weekday, weekTypeNumber);
            return resolveTemplateLessons(rows, weekNumber).map((item) => `${item.time_start} ${item.subject}`).sort();
        },
        close: () => new Promise((resolve) => server.close(() => { closeDb(); resolve(); }))
    };

    return context;
}

test.after(async () => { if (context) await context.close(); });

test('clearing a past week says what it removes and does not wipe counted hours on one click', async () => {
    const { ok, call, pair, groupId, hours, studentSees } = await getContext();

    // Week 2 entered as its own week (empty template, as on the live site).
    at('2026-09-07T07:00:00');
    await ok('POST', '/api/admin/lessons', { ...pair, specific_week: 2 });
    await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 3, specific_week: 2 });

    at('2026-09-20T12:00:00'); // week 3: both pairs of week 2 took place
    assert.equal(await hours(), 4);

    const summary = await ok('GET', `/api/admin/schedule/week-summary?group_id=${groupId}&week_number=2`);
    assert.deepEqual(summary, { week_number: 2, pairs: 2, template_pairs: 0, hours_lost: 4 });
    assert.equal(await hours(), 4, 'the preview changes nothing');

    const refused = await call('DELETE', `/api/admin/schedule/week?group_id=${groupId}&week_number=2`);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.needs_confirm, true);
    assert.deepEqual(await studentSees('2026-09-07'), ['08:00 Физика'], 'nothing removed without confirm');

    const cleared = await ok('DELETE', `/api/admin/schedule/week?group_id=${groupId}&week_number=2&confirm=1`);
    assert.equal(cleared.deleted, 2);
    assert.equal(await hours(), 0);
    assert.deepEqual(await studentSees('2026-09-07'), []);

    // A week still ahead has nothing counted: no second question.
    await ok('POST', '/api/admin/lessons', { ...pair, specific_week: 5 });
    assert.equal((await ok('GET', `/api/admin/schedule/week-summary?group_id=${groupId}&week_number=5`)).hours_lost, 0);
    await ok('DELETE', `/api/admin/schedule/week?group_id=${groupId}&week_number=5`);
});

test('a pair after the last week is refused until the semester is extended, then it counts', async () => {
    const { ok, call, pair, semester, hours, studentSees } = await getContext();

    at('2027-01-10T12:00:00'); // week 19: the 18-week semester is over
    const before = await hours();
    const refused = await call('POST', '/api/admin/lessons', { ...pair, day_of_week: 2, specific_week: 20 });
    assert.equal(refused.status, 409);
    assert.equal(refused.data.needs_extension, true);
    assert.equal(refused.data.weeks_needed, 20);
    assert.equal(refused.data.weeks_count, 18);

    // What the constructor does after «Продлить?» → «Да».
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { weeks_count: 20 });
    await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 2, specific_week: 20 });

    at('2027-01-20T12:00:00');
    assert.deepEqual(await studentSees('2027-01-12'), ['08:00 Физика'], 'students see it');
    assert.equal(await hours(), before + 2, 'and it counts — schedule and hours agree');
});

test('one cell holds either a whole-group pair or the subgroups\' pairs, and times may not overlap', async () => {
    const { ok, call, groupId, studentSees } = await getContext();
    at('2026-10-01T12:00:00'); // week 5
    const base = { group_id: groupId, day_of_week: 1, subject: 'Английский', lesson_type: 'Практика', specific_week: 6 };

    const whole = await ok('POST', '/api/admin/lessons', { ...base, time_start: '09:40', time_end: '11:10', subgroup: 0, subject: 'Математика' });
    assert.equal((await call('POST', '/api/admin/lessons', { ...base, time_start: '09:40', time_end: '11:10', subgroup: 1 })).status, 409, 'п/г 1 over the whole group');
    assert.equal((await call('POST', '/api/admin/lessons', { ...base, time_start: '10:00', time_end: '11:30', subgroup: 0 })).status, 409, 'overlapping time');
    await ok('POST', '/api/admin/lessons', { ...base, time_start: '11:10', time_end: '12:40', subgroup: 0, subject: 'Вплотную' }); // back to back is fine

    const first = await ok('POST', '/api/admin/lessons', { ...base, time_start: '13:10', time_end: '14:40', subgroup: 1 });
    const second = await ok('POST', '/api/admin/lessons', { ...base, time_start: '13:10', time_end: '14:40', subgroup: 2, subject: 'Немецкий' });
    assert.equal((await call('POST', '/api/admin/lessons', { ...base, time_start: '13:10', time_end: '14:40', subgroup: 0 })).status, 409, 'whole group over the subgroups');
    assert.equal((await call('PUT', `/api/admin/lessons/${second.id}`, { subgroup: 0 })).status, 409, 'turning a subgroup pair into a whole-group one');
    assert.equal((await call('POST', '/api/admin/schedule/move-lesson', {
        lesson_id: first.id, mode: 'week', week_number: 6, day_of_week: 1, time_start: '09:40', time_end: '11:10'
    })).status, 409, 'dragging onto the whole-group pair');
    assert.ok(whole.id);

    const sees = await studentSees('2026-10-05');
    assert.deepEqual(sees, ['09:40 Математика', '11:10 Вплотную', '13:10 Английский', '13:10 Немецкий']);
});

test('a week still run by the template: no second pair dropped or added into a filled cell', async () => {
    const { ok, call, groupId } = await getContext();
    at('2026-10-14T12:00:00'); // week 7
    // Template pairs (no plan identity: they must not move anyone's hours).
    const tuesday = { group_id: groupId, day_of_week: 2, subject: 'Шаблон', lesson_type: 'Практика', week_type: 0 };
    const early = await ok('POST', '/api/admin/lessons', { ...tuesday, time_start: '08:00', time_end: '09:30' });
    await ok('POST', '/api/admin/lessons', { ...tuesday, time_start: '09:40', time_end: '11:10', subject: 'Шаблон 2' });

    const moved = await call('POST', '/api/admin/schedule/move-lesson', {
        lesson_id: early.id, mode: 'week', week_number: 8, day_of_week: 2, time_start: '09:40', time_end: '11:10'
    });
    assert.equal(moved.status, 409, 'the template already fills that cell in week 8');

    const added = await call('POST', '/api/admin/schedule/materialize-week', {
        group_id: groupId, week_number: 8, action: 'upsert', day_of_week: 2, time_start: '08:00', time_end: '09:30', subgroup: 1, subject: 'Подгруппа'
    });
    assert.equal(added.status, 409, 'a subgroup pair into the template\'s whole-group cell');

    // Clean up: the template is empty again for the next tests.
    db().prepare("DELETE FROM lessons WHERE specific_week IS NULL").run();
});

test('a template change on a Wednesday leaves this week\'s already-held Monday as it was', async () => {
    const { ok, groupId, draftSees: studentSees } = await getContext();
    const monday = { group_id: groupId, day_of_week: 1, time_start: '15:00', time_end: '16:30', subject: 'Шаблонная', lesson_type: 'Практика', week_type: 0 };

    at('2026-11-01T12:00:00'); // Sunday of week 9
    const row = await ok('POST', '/api/admin/lessons', monday);

    at('2026-11-04T12:00:00'); // Wednesday of week 10: Monday 02.11 was held
    const retired = await ok('DELETE', `/api/admin/lessons/${row.id}`);
    assert.equal(retired.retired_from_week, 11);
    assert.deepEqual(await studentSees('2026-11-02'), ['15:00 Шаблонная'], 'the held Monday stays');
    assert.deepEqual(await studentSees('2026-11-09'), [], 'gone from next week');

    // A new template pair added on Wednesday for Monday does not appear on the past Monday.
    const added = await ok('POST', '/api/admin/lessons', { ...monday, time_start: '16:40', time_end: '18:10', subject: 'Новая' });
    assert.equal(added.template_from_week, 11);
    assert.deepEqual(await studentSees('2026-11-02'), ['15:00 Шаблонная']);
    assert.deepEqual(await studentSees('2026-11-09'), ['16:40 Новая']);

    // A Friday pair still ahead this week changes from this week.
    const friday = await ok('POST', '/api/admin/lessons', { ...monday, day_of_week: 5, subject: 'Пятница' });
    assert.equal(friday.template_from_week, 10);

    // Moved on Wednesday from Monday (held) to Friday: this week keeps the
    // Monday only — not Monday AND Friday.
    const moved = await ok('POST', '/api/admin/schedule/move-lesson', {
        lesson_id: added.id, mode: 'template', day_of_week: 4, time_start: '16:40', time_end: '18:10'
    });
    assert.equal(moved.moved, true);
    assert.deepEqual(await studentSees('2026-11-05'), [], 'Thursday of this week: not doubled');
    assert.deepEqual(await studentSees('2026-11-12'), ['16:40 Новая']);

    db().prepare('DELETE FROM lessons WHERE specific_week IS NULL').run();
});

test('an exam over a pair: confirmed with remove_pairs, the pair leaves that day and its hours; the constructor warns the other way round', async () => {
    const { ok, call, pair, groupId, hours, studentSees } = await getContext();
    at('2026-11-10T12:00:00'); // week 11

    // A counted pair in week 12 (own week), an exam on top of it.
    await ok('POST', '/api/admin/lessons', { ...pair, specific_week: 12, time_start: '11:30', time_end: '13:00' });
    at('2026-11-30T12:00:00');
    const withPair = await hours();
    at('2026-11-10T12:00:00');

    const exam = { kind: 'exam', group_id: groupId, date: '2026-11-16', time_start: '11:30', discipline_text: 'Химия', room: '1' };
    const asked = await call('POST', '/api/admin/attestations', exam);
    assert.equal(asked.status, 409);
    assert.deepEqual(asked.data.covered_pairs, [{ subject: 'Физика', time_start: '11:30', time_end: '13:00' }]);

    const saved = await ok('POST', '/api/admin/attestations', { ...exam, confirm: true, remove_pairs: true });
    assert.equal(saved.removed_pairs, 1);
    assert.deepEqual(await studentSees('2026-11-16'), ['11:30 Химия'], 'only the exam that day');
    at('2026-11-30T12:00:00');
    assert.equal(await hours(), withPair - 2, 'the replaced pair no longer counts');
    at('2026-11-10T12:00:00');

    // A week not entered yet has nothing to take out; when it is entered as the
    // template has it, the pair under a credit with an end time comes in already out.
    const tuesday = { group_id: groupId, day_of_week: 2, lesson_type: 'Практика', week_type: 0 };
    await ok('POST', '/api/admin/lessons', { ...tuesday, time_start: '08:00', time_end: '09:30', subject: 'Утро' });
    await ok('POST', '/api/admin/lessons', { ...tuesday, time_start: '09:40', time_end: '11:10', subject: 'Вторая' });
    const credit = await ok('POST', '/api/admin/attestations', {
        kind: 'credit', group_id: groupId, date: '2026-11-24', time_start: '08:00', time_end: '09:30', discipline_text: 'Зачёт', confirm: true, remove_pairs: true
    });
    assert.equal(credit.removed_pairs, 0, 'week 13 not entered: no pair is shown, none to take out');
    await ok('POST', '/api/admin/schedule/materialize-week', { group_id: groupId, week_number: 13, action: 'copy' });
    at('2026-11-24T07:00:00');
    assert.deepEqual(await studentSees('2026-11-24'), ['08:00 Зачёт', '09:40 Вторая'], 'the rest of that day stays');
    // The credit moves away: the pair it held comes back.
    await ok('PUT', `/api/admin/attestations/${credit.id}`, { kind: 'credit', group_id: groupId, date: '2026-11-25', time_start: '15:00', time_end: '16:30', discipline_text: 'Зачёт' });
    assert.deepEqual(await studentSees('2026-11-24'), ['08:00 Утро', '09:40 Вторая']);
    at('2026-11-10T12:00:00');
    db().prepare('DELETE FROM lessons WHERE specific_week IS NULL OR specific_week = 13').run();
    db().prepare('DELETE FROM attestations WHERE id = ?').run(credit.id);

    // Constructor: a pair saved on top of a consultation is reported.
    await ok('POST', '/api/admin/attestations', {
        kind: 'consultation', group_id: groupId, date: '2026-11-18', time_start: '14:00', discipline_text: 'Химия', confirm: true
    });
    const over = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 3, specific_week: 12, time_start: '13:10', time_end: '14:40' });
    assert.equal(over.attestation_warnings.length, 1);
    assert.match(over.attestation_warnings[0], /консультация «Химия» 18\.11 14:00/);
});

test('small guards: a row keeps its week, types come from the plan\'s list, the sheet follows the student page, session records follow semester dates', async () => {
    const { ok, call, download, pair, groupId, semester } = await getContext();
    at('2026-11-10T12:00:00');

    const row = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 4, specific_week: 14, time_start: '15:00', time_end: '16:30' });
    assert.equal((await call('PUT', `/api/admin/lessons/${row.id}`, { specific_week: null })).status, 409, 'not into the template');
    assert.equal((await call('PUT', `/api/admin/lessons/${row.id}`, { specific_week: 15 })).status, 409, 'not into another week');
    await ok('PUT', `/api/admin/lessons/${row.id}`, { specific_week: 14, room: '305' }); // the page always sends its own week

    assert.equal((await call('POST', '/api/admin/lessons', { ...pair, day_of_week: 4, specific_week: 14, lesson_type: 'лекция' })).status, 400);
    await ok('POST', '/api/admin/lessons', { group_id: groupId, day_of_week: 5, specific_week: 14, time_start: '08:00', time_end: '09:30', subject: 'Линейка', kind: 'event' });

    // The sheet prints what students see: a week entered, never the bare template.
    await ok('POST', '/api/admin/lessons', { group_id: groupId, day_of_week: 1, week_type: 0, time_start: '16:40', time_end: '18:10', subject: 'Шаблонная пара', lesson_type: 'Практика' });
    const ExcelJS = require('exceljs');
    const sheetText = async (weekStart) => {
        const raw = await download(`/api/admin/schedule/export?week_start=${weekStart}`);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(raw);
        const parts = [];
        workbook.eachSheet((sheet) => sheet.eachRow((r) => r.eachCell((cell) => parts.push(String(cell.value?.richText ? cell.value.richText.map((t) => t.text).join('') : cell.value ?? '')))));
        return parts.join(' | ');
    };
    assert.doesNotMatch(await sheetText('2026-11-23'), /Шаблонная пара/, 'week 13 not entered: not printed');
    await ok('POST', '/api/admin/schedule/materialize-week', { group_id: groupId, week_number: 13, action: 'copy' });
    assert.match(await sheetText('2026-11-23'), /Шаблонная пара/, 'entered as the template has it: printed');
    assert.doesNotMatch(await sheetText('2027-01-18'), /Шаблонная пара/, 'week 21: not any more');
    db().prepare('DELETE FROM lessons WHERE specific_week IS NULL OR specific_week = 13').run();

    // A consultation in the gap after autumn belongs to autumn — until spring is created starting before it.
    const consultation = await ok('POST', '/api/admin/attestations', {
        kind: 'consultation', group_id: groupId, date: '2027-02-02', time_start: '10:00', discipline_text: 'Физика', confirm: true
    });
    assert.equal(consultation.semester_id, semester.id);
    const spring = await ok('POST', '/api/admin/semesters', { label: 'Весна', start_date: '2027-02-01', weeks_count: 18, first_week_parity: 1 });
    assert.equal(db().prepare('SELECT semester_id FROM attestations WHERE id = ?').get(consultation.id).semester_id, spring.id);
    await ok('PUT', `/api/admin/semesters/${spring.id}`, { start_date: '2027-02-08' });
    assert.equal(db().prepare('SELECT semester_id FROM attestations WHERE id = ?').get(consultation.id).semester_id, semester.id, 'and back');
});

test('an event keeps only its title: no teacher, discipline or type, whatever is sent — never counted', async () => {
    const { ok, pair, groupId, hours, studentSees } = await getContext();
    at('2026-12-31T12:00:00');
    const before = await hours();
    at('2026-11-10T12:00:00');

    const event = await ok('POST', '/api/admin/lessons', { ...pair, kind: 'event', subject: 'Спартакиада', day_of_week: 6, specific_week: 15, time_start: '08:00', time_end: '09:30' });
    assert.deepEqual([event.kind, event.teacher_id, event.discipline_id, event.lesson_type, event.subject], ['event', null, null, null, 'Спартакиада']);

    const pairRow = await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 6, specific_week: 15, time_start: '09:40', time_end: '11:10' });
    const turned = await ok('PUT', `/api/admin/lessons/${pairRow.id}`, { kind: 'event', subject: 'Кураторский час' });
    assert.deepEqual([turned.kind, turned.teacher_id, turned.discipline_id, turned.subject], ['event', null, null, 'Кураторский час']);

    at('2026-12-31T12:00:00');
    assert.equal(await hours(), before, 'neither counts');
    assert.deepEqual(await studentSees('2026-12-12'), ['08:00 Спартакиада', '09:40 Кураторский час'], 'both shown to students');
    void groupId;
});

test('a subgroup\'s credit over a whole-group pair does not offer to take the pair away from the other subgroup', async () => {
    const { ok, call, pair, groupId } = await getContext();
    at('2026-11-10T12:00:00');
    await ok('POST', '/api/admin/lessons', { ...pair, day_of_week: 5, specific_week: 16, time_start: '13:10', time_end: '14:40' });

    const record = { kind: 'credit', group_id: groupId, subgroup: 1, date: '2026-12-18', time_start: '13:10', discipline_text: 'Зачёт п/г 1' };
    const asked = await call('POST', '/api/admin/attestations', record);
    assert.equal(asked.status, 409, 'still warned about the pair');
    assert.deepEqual(asked.data.covered_pairs, [], 'but not offered for removal');

    const saved = await ok('POST', '/api/admin/attestations', { ...record, confirm: true, remove_pairs: true });
    assert.equal(saved.removed_pairs, 0, 'and not removed even if asked');
});
