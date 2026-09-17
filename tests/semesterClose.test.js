const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Closing a semester freezes what it reports. The hours in a signed report must
// stay what they were on the day it was signed — a later correction to an old
// pair, or simply the clock moving past more weeks, must not change them.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.ADMIN_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-close-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };

test('a closed semester stops changing — its hours and its schedule are final', async (t) => {
    const db = getDb();
    db.exec(`
        DELETE FROM lessons; DELETE FROM load_plan; DELETE FROM semesters; DELETE FROM teachers;
        DELETE FROM disciplines; DELETE FROM admins; DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    const universityId = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23303')").run(universityId).lastInsertRowid);
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); delete process.env.KAI_FAKE_NOW; resolve(); })));

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
    const adminHours = async (planId) => (await ok('GET', `/api/admin/load-plan?semester_id=${semester.id}`))
        .find((row) => row.id === planId).progress.occurred_hours;

    at('2026-08-25T10:00:00');
    const semester = await ok('POST', '/api/admin/semesters', {
        label: 'Осень 2026', start_date: '2026-08-31', weeks_count: 10, first_week_parity: 1
    });
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { is_active: true });

    const teacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Иванов И.И.' })).id;
    const disciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;
    const plan = await ok('POST', '/api/admin/load-plan', {
        semester_id: semester.id, teacher_id: teacherId, discipline_id: disciplineId,
        lesson_type: 'Лекция', group_id: groupId, planned_hours: 20
    });
    const pair = {
        group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', week_type: 0,
        subject: 'Физика', lesson_type: 'Лекция', teacher: 'Иванов И.И.'
    };
    const lesson = await ok('POST', '/api/admin/lessons', pair);
    await ok('PUT', `/api/admin/lessons/${lesson.id}/load-plan`, { load_plan_id: plan.id });

    // Week 3: three Mondays have happened.
    at('2026-09-16T12:00:00');
    assert.equal(await adminHours(plan.id), 6);

    const closed = await ok('POST', `/api/admin/semesters/${semester.id}/close`);
    assert.equal(closed.closed, true);
    assert.equal(closed.closed_at, '2026-09-16');
    assert.equal(closed.plan_rows, 1);
    assert.equal(closed.total_hours, 6);
    assert.equal((await call('POST', `/api/admin/semesters/${semester.id}/close`)).status, 409, 'closing twice is refused');

    // Nothing in a closed semester can be edited any more.
    for (const [method, url, body] of [
        ['POST', '/api/admin/lessons', { ...pair, day_of_week: 2 }],
        ['PUT', `/api/admin/lessons/${lesson.id}`, { room: '404' }],
        ['DELETE', `/api/admin/lessons/${lesson.id}`, undefined],
        ['PUT', `/api/admin/lessons/${lesson.id}/load-plan`, { load_plan_id: null }],
        ['POST', '/api/admin/load-plan', {
            semester_id: semester.id, teacher_id: teacherId, discipline_id: disciplineId,
            lesson_type: 'Практика', group_id: groupId, planned_hours: 10
        }],
        ['PUT', `/api/admin/load-plan/${plan.id}`, { planned_hours: 40 }],
        ['DELETE', `/api/admin/load-plan/${plan.id}`, undefined],
        ['PUT', `/api/admin/semesters/${semester.id}`, { weeks_count: 12 }],
        ['POST', '/api/admin/schedule/materialize-week', {
            group_id: groupId, week_number: 4, action: 'remove', day_of_week: 1, time_start: '08:00', time_end: '09:30'
        }],
        ['POST', '/api/admin/schedule/upload-bulk', {
            target_week: 'template',
            groups: [{ group: '23303', university: 'КНИТУ-КАИ', lessons: [{ day: 5, time_start: '08:00', time_end: '09:30', subject: 'Химия', week_type: 'all' }] }]
        }]
    ]) {
        const result = await call(method, url, body);
        assert.equal(result.status, 409, `${method} ${url} должен быть отклонён, а вернул ${result.status}`);
        assert.match(result.data.error, /закрыт/i);
    }

    // The semester ran to its end; the reported total stays what it was at closing.
    at('2026-12-01T12:00:00');
    assert.equal(await adminHours(plan.id), 6, 'the clock moving on does not add hours to a closed semester');

    const teacherView = await ok('GET', `/api/teachers/${teacherId}/load?semester_id=${semester.id}`);
    assert.equal(teacherView.semester.closed, true);
    assert.equal(teacherView.plan[0].occurred_hours, 6);

    const publicList = await ok('GET', '/api/semesters');
    assert.equal(publicList.find((row) => row.id === semester.id).closed, true);

    // Reopening goes back to a live calculation: ten weeks have now run.
    const reopened = await ok('POST', `/api/admin/semesters/${semester.id}/reopen`);
    assert.equal(reopened.closed, false);
    assert.equal(await adminHours(plan.id), 20);
    assert.equal((await call('POST', `/api/admin/semesters/${semester.id}/reopen`)).status, 409, 'reopening an open semester is refused');
    assert.equal((await call('POST', '/api/admin/lessons', { ...pair, day_of_week: 2 })).status, 201, 'editing works again');

    const log = await ok('GET', '/api/admin/audit-logs?limit=50');
    assert.ok(log.some((entry) => entry.action === 'semester.close'), 'closing is written to the journal');
    assert.ok(log.some((entry) => entry.action === 'semester.reopen'), 'reopening is written to the journal');
});
