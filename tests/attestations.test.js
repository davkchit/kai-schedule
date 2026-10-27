const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Экзамены, зачёты и консультации: entered in the admin panel, shown to
// students on their dates, listed on the teacher's page, counted per teacher —
// never added to a plan row's hours — and exported as the branch's two documents.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.ADMIN_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-attest-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };

test('exams, credits and consultations: entered, shown, counted and exported', async (t) => {
    const db = getDb();
    db.exec(`
        DELETE FROM attestations; DELETE FROM lessons; DELETE FROM load_plan; DELETE FROM semesters; DELETE FROM teachers;
        DELETE FROM disciplines; DELETE FROM admins; DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    const universityId = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23101')").run(universityId).lastInsertRowid);
    const otherGroupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23103')").run(universityId).lastInsertRowid);
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); delete process.env.KAI_FAKE_NOW; resolve(); })));

    const auth = { Authorization: `Bearer ${createToken({ id: 1, username: 'admin' })}` };
    const call = async (method, url, body) => {
        const isFile = Buffer.isBuffer(body) || body instanceof ArrayBuffer;
        const response = await fetch(`${baseUrl}${url}`, {
            method,
            headers: { ...auth, 'Content-Type': isFile ? 'application/octet-stream' : 'application/json' },
            body: body === undefined ? undefined : isFile ? body : JSON.stringify(body)
        });
        return { status: response.status, data: await response.json() };
    };
    const ok = async (method, url, body) => {
        const result = await call(method, url, body);
        assert.ok(result.status < 300, `${method} ${url} → ${result.status} ${JSON.stringify(result.data)}`);
        return result.data;
    };

    at('2027-02-01T10:00:00');
    const spring = await ok('POST', '/api/admin/semesters', {
        label: 'Весна 2027', start_date: '2027-02-08', weeks_count: 17, first_week_parity: 1
    });
    await ok('PUT', `/api/admin/semesters/${spring.id}`, { is_active: true });
    const teacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Иванов И.И.' })).id;
    const physicsId = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;

    // A teaching pair so the week has a template: an exam must not hide it.
    await ok('POST', '/api/admin/lessons', {
        group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', week_type: 0,
        subject: 'Физика', lesson_type: 'Лекция', teacher_id: teacherId, discipline_id: physicsId
    });

    // ── By hand ──
    const exam = await ok('POST', '/api/admin/attestations', {
        kind: 'exam', group_id: groupId, date: '2027-05-17', time_start: '09:40', room: '231',
        discipline_id: physicsId, discipline_text: 'не то', teacher_id: teacherId
    });
    assert.equal(exam.subject, 'Физика', 'the dictionary name wins over typed text');
    assert.equal(exam.teacher, 'Иванов И.И.');
    assert.equal(exam.semester_id, spring.id, 'the semester is the one in effect on the date');

    const bad = await call('POST', '/api/admin/attestations', { kind: 'exam', group_id: groupId, date: '2026-01-01', time_start: '09:40', discipline_text: 'Физика' });
    assert.equal(bad.status, 400, 'no semester on that date');
    assert.equal((await call('POST', '/api/admin/attestations', { kind: 'party', group_id: groupId, date: '2027-05-17', time_start: '09:40', discipline_text: 'Физика' })).status, 400);

    // Students see it on its date months ahead — session days are published
    // early — while that week's pairs aren't out (nor is the template, ever).
    const week = await ok('GET', `/api/schedule/${groupId}?date=2027-05-17&days=7`);
    assert.equal(week.attestations.length, 1);
    assert.equal(week.attestations[0].kind, 'exam');
    assert.equal(week.attestations[0].date, '2027-05-17');
    assert.equal(week.lessons.length, 0, 'no pairs of a week not open yet, no template rows');
    assert.equal(week.visible_until, '2027-02-07');
    assert.equal((await ok('GET', `/api/schedule/${otherGroupId}?date=2027-05-17&days=7`)).attestations.length, 0);

    // The teacher's page lists it; the plan's hours don't change.
    const teacherPage = await ok('GET', `/api/teachers/${teacherId}/load?semester_id=${spring.id}`);
    assert.equal(teacherPage.attestations.length, 1);
    assert.equal(teacherPage.attestations[0].group_name, '23101');

    // ── More of each kind ──
    const add = (body) => ok('POST', '/api/admin/attestations', { group_id: groupId, ...body });
    await add({ kind: 'credit', date: '2027-05-21', time_start: '11:30', room: '105', discipline_text: 'История', teacher_id: teacherId });
    await add({ kind: 'credit', subgroup: 1, date: '2027-05-22', time_start: '09:40', room: '206', discipline_text: 'Иностранный язык', teacher_text: 'Петрова А.А.' });
    await add({ kind: 'exam', date: '2027-06-11', time_start: '08:00', room: '231', discipline_id: physicsId, teacher_id: teacherId });
    await add({ kind: 'consultation', date: '2027-06-10', time_start: '15:00', room: '231', discipline_id: physicsId, teacher_id: teacherId });

    // ── Export: the branch's two documents ──
    const download = async (type) => {
        const response = await fetch(`${baseUrl}/api/admin/attestations/export?semester_id=${spring.id}&type=${type}`, { headers: auth });
        assert.equal(response.status, 200);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
        const rows = [];
        workbook.getWorksheet('1 курс').eachRow((row) => rows.push(row.values.slice(1).map((value) => (value == null ? '' : String(value)))));
        return rows;
    };
    const session = await download('session');
    assert.ok(session.some((row) => row.includes('за весенний семестр 2026/2027 учебный год')));
    const sessionData = session.slice(session.findIndex((row) => row[2] === 'зачет') + 1);
    assert.deepEqual(sessionData.map((row) => row.slice(0, 7)), [
        ['23101', 'История', '21.05.2027', '', '11:30', 'Иванов И.И.', '105'],
        ['23101', 'Иностранный язык 1 п/г', '22.05.2027', '', '9:40', 'Петрова А.А.', '206'],
        ['23101', 'Физика', '', '17.05.2027', '9:40', 'Иванов И.И.', '231'],
        ['23101', 'Физика', '', '11.06.2027', '8:00', 'Иванов И.И.', '231']
    ], 'зачёты first, then экзамены, the date under its own column (the group cell is merged down the block)');
    const consultationsSheet = await download('consultations');
    assert.deepEqual(consultationsSheet.at(-1).slice(0, 6), ['23101', 'Физика', '10.06.2027', '15:00', 'Иванов И.И.', '231']);
    assert.equal((await call('GET', '/api/admin/attestations/export?semester_id=999&type=consultations')).status, 404);

    // ── Counts ──
    const list = await ok('GET', `/api/admin/attestations?semester_id=${spring.id}`);
    assert.equal(list.items.length, 5);
    const ivanov = list.by_teacher.find((row) => row.teacher_id === teacherId);
    assert.deepEqual({ exam: ivanov.exam, credit: ivanov.credit, consultation: ivanov.consultation }, { exam: 2, credit: 1, consultation: 1 });
    assert.ok(list.by_teacher.some((row) => row.teacher_id === null && row.teacher === 'Петрова А.А.'), 'an unmatched name is still counted');

    // ── Collisions: refused only when it is the same record twice, otherwise confirmed ──
    // Monday 24 May, week 16, entered as the template has it: its 08:00–09:30 pair is on.
    await ok('POST', '/api/admin/schedule/materialize-week', { group_id: groupId, week_number: 16, action: 'copy' });
    const onPair = { kind: 'exam', group_id: groupId, date: '2027-05-24', time_start: '08:30', discipline_text: 'Химия', teacher_id: teacherId };
    const clash = await call('POST', '/api/admin/attestations', onPair);
    assert.equal(clash.status, 409);
    assert.equal(clash.data.needs_confirm, true);
    assert.ok(clash.data.warnings.some((warning) => warning.startsWith('У группы в это время пара: Физика')), JSON.stringify(clash.data));
    const confirmed = await ok('POST', '/api/admin/attestations', { ...onPair, confirm: true });

    const twice = await call('POST', '/api/admin/attestations', { ...onPair, confirm: true });
    assert.equal(twice.status, 409, 'the same record twice is refused even when confirmed');
    assert.equal(twice.data.needs_confirm, undefined);

    // The teacher can't be in two rooms; a joint exam for two groups is not a clash.
    const busy = await call('POST', '/api/admin/attestations', { ...onPair, group_id: otherGroupId, discipline_text: 'Экология' });
    assert.ok(busy.data.warnings.some((warning) => warning.includes('в это время занят')), JSON.stringify(busy.data));
    const shared = { ...onPair, date: '2027-05-26', time_start: '13:10' };
    const jointFirst = await ok('POST', '/api/admin/attestations', shared);
    const joint = await call('POST', '/api/admin/attestations', { ...shared, group_id: otherGroupId });
    assert.equal(joint.status, 201, JSON.stringify(joint.data));

    const sunday = await call('POST', '/api/admin/attestations', { ...onPair, date: '2027-05-23', time_start: '10:00', discipline_text: 'Экология' });
    assert.deepEqual(sunday.data.warnings, ['Это воскресенье']);

    // A consultation after the subject's last exam.
    const late = await call('POST', '/api/admin/attestations', { kind: 'consultation', group_id: groupId, date: '2027-06-20', time_start: '10:00', discipline_id: physicsId });
    assert.ok(late.data.warnings.some((warning) => warning.includes('уже после экзамена')), JSON.stringify(late.data));

    // A pair added later in the constructor shows on the row it now covers.
    const freeExam = await ok('POST', '/api/admin/attestations', { kind: 'exam', group_id: groupId, date: '2027-05-25', time_start: '13:10', discipline_text: 'Экономика' });
    await ok('POST', '/api/admin/lessons', {
        group_id: groupId, day_of_week: 2, time_start: '13:10', time_end: '14:40', week_type: 0, specific_week: 16,
        subject: 'Экономика', lesson_type: 'Практика'
    });
    const rechecked = (await ok('GET', `/api/admin/attestations?semester_id=${spring.id}`)).items;
    assert.ok(rechecked.find((row) => row.id === freeExam.id).warnings.some((warning) => warning.startsWith('У группы в это время пара: Экономика')));
    assert.ok(rechecked.find((row) => row.id === confirmed.id).warnings.length > 0);
    for (const row of [confirmed, freeExam, jointFirst, joint.data]) await ok('DELETE', `/api/admin/attestations/${row.id}`);

    // ── Dictionary links ──
    assert.equal((await call('DELETE', `/api/admin/teachers/${teacherId}`)).status, 409);
    await ok('PUT', `/api/admin/teachers/${teacherId}`, { full_name: 'Иванов Иван И.' });
    assert.equal((await ok('GET', `/api/admin/attestations?semester_id=${spring.id}`)).items.find((row) => row.id === exam.id).teacher, 'Иванов Иван И.');

    // ── Edit and delete ──
    const moved = await ok('PUT', `/api/admin/attestations/${exam.id}`, {
        kind: 'credit', group_id: groupId, date: '2027-05-18', time_start: '11:30', time_end: '13:00', discipline_id: physicsId, teacher_id: teacherId
    });
    assert.equal(moved.kind, 'credit');
    assert.equal(moved.time_end, '13:00');
    await ok('DELETE', `/api/admin/attestations/${exam.id}`);
    assert.equal((await call('DELETE', `/api/admin/attestations/${exam.id}`)).status, 404);

    // ── Joined groups: the member's events move to the leader ──
    db.prepare('INSERT INTO attestations (semester_id, group_id, kind, date, time_start, discipline_text) VALUES (?, ?, ?, ?, ?, ?)')
        .run(spring.id, otherGroupId, 'exam', '2027-06-20', '08:00', 'Экология');
    await ok('PUT', `/api/admin/groups/${otherGroupId}`, { joined_to: groupId });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM attestations WHERE group_id = ?').get(otherGroupId).c, 0);
    assert.deepEqual((await ok('GET', `/api/schedule/${otherGroupId}?date=2027-06-01&days=30`)).attestations.map((row) => row.subject),
        ['Физика', 'Физика', 'Экология'], 'the member sees the leader\'s');
    assert.equal((await call('POST', '/api/admin/attestations', { kind: 'exam', group_id: otherGroupId, date: '2027-06-21', time_start: '08:00', discipline_text: 'Физика' })).status, 409);
    await ok('PUT', `/api/admin/groups/${otherGroupId}`, { joined_to: null });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM attestations WHERE group_id = ?').get(otherGroupId).c,
        db.prepare('SELECT COUNT(*) c FROM attestations WHERE group_id = ?').get(groupId).c, 'splitting copies them back');

    // ── A closed semester is final ──
    await ok('POST', `/api/admin/semesters/${spring.id}/close`);
    const anyRow = db.prepare('SELECT id FROM attestations LIMIT 1').get();
    assert.equal((await call('DELETE', `/api/admin/attestations/${anyRow.id}`)).status, 409);
    assert.equal((await call('POST', '/api/admin/attestations', { kind: 'exam', group_id: groupId, date: '2027-06-01', time_start: '08:00', discipline_text: 'Физика' })).status, 409);
});
