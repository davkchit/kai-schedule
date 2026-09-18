const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// A whole academic year lived through the real HTTP API with a moving clock:
// autumn is built, edited, cancelled and moved; spring is prepared in January
// while autumn's totals are still being reported; students, teachers and the
// specialist each look at their own semester; then the next autumn starts.
//
// Every earlier rollover bug here was invisible until the calendar reached it
// (spring reading autumn's week numbers, an autumn delete in February erasing
// its hours, a hard-coded year-end cap). This test makes the calendar reach
// all of them now. Its own process (node --test runs each file separately), so
// the fake clock cannot leak into other tests.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-year-'));
process.env.DB_PATH = path.join(tempDir, 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

/** Moscow wall-clock time, the zone server/config.js pins the process to. */
function at(localDateTime) {
    process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`;
}

function localDate(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day);
}

test('a year of the schedule: autumn, rollover to spring, next autumn', async (t) => {
    const { resolveLessonsForDay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'scheduleResolve.js')).href);

    const db = getDb();
    db.exec(`
        DELETE FROM audit_logs; DELETE FROM login_attempts; DELETE FROM lessons; DELETE FROM load_plan;
        DELETE FROM semesters; DELETE FROM teachers; DELETE FROM disciplines; DELETE FROM admins;
        DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    const university = db.prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)').run('КНИТУ-КАИ', 'КНИТУ-КАИ');
    const groupId = Number(db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)').run(university.lastInsertRowid, '23303').lastInsertRowid);
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));

    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); delete process.env.KAI_FAKE_NOW; resolve(); })));

    const auth = { Authorization: `Bearer ${createToken({ id: 1, username: 'admin' })}` };

    async function call(method, url, body) {
        const response = await fetch(`${baseUrl}${url}`, {
            method,
            headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await response.json();
        return { status: response.status, data };
    }

    async function ok(method, url, body) {
        const result = await call(method, url, body);
        assert.ok(result.status >= 200 && result.status < 300, `${method} ${url} → ${result.status} ${JSON.stringify(result.data)}`);
        return result.data;
    }

    /** What a student sees on each of the given days, as subject lists. */
    async function studentSees(days) {
        const sorted = [...days].sort();
        const from = sorted[0];
        const span = Math.round((localDate(sorted.at(-1)) - localDate(from)) / 86400000) + 1;
        const seen = {};
        if (span <= 60) {
            // One response for the whole span, exactly as the page fetches a range.
            const schedule = await ok('GET', `/api/schedule/${groupId}?date=${from}&days=${span}`);
            for (const day of days) seen[day] = resolveLessonsForDay(schedule, localDate(day)).map((lesson) => lesson.subject);
        } else {
            for (const day of days) {
                const schedule = await ok('GET', `/api/schedule/${groupId}?date=${day}&days=7`);
                seen[day] = resolveLessonsForDay(schedule, localDate(day)).map((lesson) => lesson.subject);
            }
        }
        return seen;
    }

    async function planHours(semesterId, planId) {
        const rows = await ok('GET', `/api/admin/load-plan?semester_id=${semesterId}`);
        return rows.find((row) => row.id === planId).progress.occurred_hours;
    }

    const autumnLessonCount = (semesterId) => db.prepare('SELECT COUNT(*) AS c FROM lessons WHERE semester_id = ?').get(semesterId).c;

    // ── Autumn 2026 ─────────────────────────────────────────────────────────
    at('2026-08-20T10:00:00');

    // Entered as the first teaching day, a Tuesday; weeks must still run Mon–Sun.
    const autumn = await ok('POST', '/api/admin/semesters', {
        label: 'Осень 2026', start_date: '2026-09-01', weeks_count: 18, first_week_parity: 2
    });
    assert.equal(autumn.start_date, '2026-08-31');
    await ok('PUT', `/api/admin/semesters/${autumn.id}`, { is_active: true });

    const teacherId = (await ok('POST', '/api/admin/teachers', { full_name: 'Качеишвили Н.В.' })).id;
    const disciplineId = (await ok('POST', '/api/admin/disciplines', { name: 'Программирование' })).id;
    const autumnPlan = await ok('POST', '/api/admin/load-plan', {
        semester_id: autumn.id, teacher_id: teacherId, discipline_id: disciplineId,
        lesson_type: 'Лекция', group_id: groupId, planned_hours: 40
    });

    // L1 every Monday; L2 on Wednesdays of нечётная weeks (= semester weeks 2, 4, …, since week 1 is чётная).
    // teacher_id/discipline_id match the plan directly — hours are matched
    // live by identity now, no separate linking step.
    const l1 = await ok('POST', '/api/admin/lessons', {
        group_id: groupId, day_of_week: 1, time_start: '08:00', time_end: '09:30', week_type: 0,
        subject: 'Программирование', lesson_type: 'Лекция', teacher: 'Качеишвили Н.В.',
        teacher_id: teacherId, discipline_id: disciplineId
    });
    const l2 = await ok('POST', '/api/admin/lessons', {
        group_id: groupId, day_of_week: 3, time_start: '09:40', time_end: '11:10', week_type: 1,
        subject: 'Программирование', lesson_type: 'Лекция', teacher: 'Качеишвили Н.В.',
        teacher_id: teacherId, discipline_id: disciplineId
    });

    // Mid-October (week 7): cancel week 9's Monday — the ONLY pair of that
    // week — and move L2 from Wednesday to Thursday from now on.
    at('2026-10-14T12:00:00');
    await ok('POST', '/api/admin/schedule/materialize-week', {
        group_id: groupId, week_number: 9, action: 'remove', day_of_week: 1, time_start: '08:00', time_end: '09:30'
    });
    await ok('POST', '/api/admin/schedule/move-lesson', {
        lesson_id: l2.id, mode: 'template', day_of_week: 4, time_start: '09:40', time_end: '11:10'
    });

    // Early November (week 10): L1 is dropped for the rest of the semester.
    at('2026-11-04T12:00:00');
    const retired = await ok('DELETE', `/api/admin/lessons/${l1.id}`);
    assert.equal(retired.retired_from_week, 10, 'an already-live pair is retired, not erased');

    assert.deepEqual(await studentSees(['2026-09-02', '2026-09-09', '2026-10-19', '2026-10-22', '2026-10-26', '2026-11-09']), {
        '2026-09-02': [], // week 1 (чётная): no L2
        '2026-09-09': ['Программирование'], // week 2 Wednesday: L2 before the move
        '2026-10-19': ['Программирование'], // week 8 Monday: L1
        '2026-10-22': ['Программирование'], // week 8 Thursday: L2 after the move
        '2026-10-26': [], // week 9 Monday: cancelled, even though it was the week's only pair
        '2026-11-09': [] // week 11 Monday: L1 retired
    });

    // After the semester: L1 weeks 1–8 (9 cancelled, retired from 10) = 8 pairs;
    // L2 weeks 2, 4, 6 on Wed + 8…18 even on Thu = 9 pairs. 17 × 2 h.
    at('2027-01-15T12:00:00');
    const AUTUMN_TOTAL = 34;
    assert.equal(await planHours(autumn.id, autumnPlan.id), AUTUMN_TOTAL);

    // Сессия: past week 18 the template no longer shows (week 20 Thursday would be L2).
    assert.deepEqual(await studentSees(['2027-01-14']), { '2027-01-14': [] });

    // ── Spring 2027, prepared in January ────────────────────────────────────
    const spring = await ok('POST', '/api/admin/semesters', {
        label: 'Весна 2027', start_date: '2027-02-09', weeks_count: 18, first_week_parity: 1
    });
    assert.equal(spring.start_date, '2027-02-08');
    const beforeActivation = await ok('GET', '/api/admin/settings');
    assert.equal(beforeActivation.active_semester.id, autumn.id, 'creating a semester does not switch the working one');

    await ok('PUT', `/api/admin/semesters/${spring.id}`, { is_active: true });
    assert.equal(await planHours(autumn.id, autumnPlan.id), AUTUMN_TOTAL, 'activating spring leaves autumn hours alone');

    // Teachers still see autumn in January — it is the semester in effect.
    const januaryTeacher = await ok('GET', `/api/teachers/${teacherId}/load`);
    assert.equal(januaryTeacher.semester.id, autumn.id);
    assert.equal(januaryTeacher.plan[0].occurred_hours, AUTUMN_TOTAL);

    // The constructor now works in spring and sees none of autumn's rows.
    assert.deepEqual(await ok('GET', `/api/admin/lessons?group_id=${groupId}`), []);

    const autumnRowsBefore = autumnLessonCount(autumn.id);
    await ok('POST', '/api/admin/schedule/upload-bulk', {
        target_week: 'template',
        groups: [{
            group: '23303', university: 'КНИТУ-КАИ', lessons: [
                { day: 1, time_start: '08:00', time_end: '09:30', subject: 'Базы данных', type: 'Лекция', teacher: 'Качеишвили Н.В.', week_type: 'all' },
                { day: 2, time_start: '09:40', time_end: '11:10', subject: 'Сети', type: 'Практика', week_type: 'odd' }
            ]
        }]
    });
    assert.equal(autumnLessonCount(autumn.id), autumnRowsBefore, 'uploading spring does not touch autumn rows');

    const springLessons = await ok('GET', `/api/admin/lessons?group_id=${groupId}`);
    const databases = springLessons.find((lesson) => lesson.subject === 'Базы данных');
    const networks = springLessons.find((lesson) => lesson.subject === 'Сети');
    const springDiscipline = (await ok('POST', '/api/admin/disciplines', { name: 'Базы данных' })).id;
    const springPlan = await ok('POST', '/api/admin/load-plan', {
        semester_id: spring.id, teacher_id: teacherId, discipline_id: springDiscipline,
        lesson_type: 'Лекция', group_id: groupId, planned_hours: 36
    });
    // "Select from the dropdown" for the uploaded pair — hours are matched
    // live by identity, no separate linking step.
    await ok('PUT', `/api/admin/lessons/${databases.id}`, { teacher_id: teacherId, discipline_id: springDiscipline });

    // Semester scoping alone keeps an autumn pair from feeding a spring plan
    // row, even with the exact same identity: the matching query is always
    // scoped to one semester_id. A raw row planted directly in autumn (the
    // constructor itself never offers a non-working semester to write into)
    // must not move springPlan's total.
    const beforePlant = await planHours(spring.id, springPlan.id);
    db.prepare(`
        INSERT INTO lessons (group_id, subgroup, day_of_week, week_type, time_start, time_end, subject, lesson_type, teacher_id, discipline_id, semester_id)
        VALUES (?, 0, 5, 0, '13:10', '14:40', 'Базы данных', 'Лекция', ?, ?, ?)
    `).run(groupId, teacherId, springDiscipline, autumn.id);
    assert.equal(await planHours(spring.id, springPlan.id), beforePlant, 'an autumn pair, even of identical identity, cannot feed a spring plan row');

    // A four-week view across the rollover: autumn is over, spring starts on
    // its own week 1 with its own stored parity (week 1 нечётная, although the
    // calendar rule would call 8 Feb 2027 чётная).
    assert.deepEqual(await studentSees(['2027-01-25', '2027-02-01', '2027-02-08', '2027-02-09', '2027-02-16']), {
        '2027-01-25': [],
        '2027-02-01': [],
        '2027-02-08': ['Базы данных'],
        '2027-02-09': ['Сети'],
        '2027-02-16': []
    });

    // September still shows autumn, and only autumn.
    const september = await ok('GET', `/api/schedule/${groupId}?date=2026-09-07&days=7`);
    assert.ok(september.lessons.every((lesson) => lesson.semester_id === autumn.id));
    assert.deepEqual(resolveLessonsForDay(september, localDate('2026-09-07')).map((l) => l.subject), ['Программирование']);
    const february = await ok('GET', `/api/schedule/${groupId}?date=2027-02-08&days=7`);
    assert.ok(february.lessons.every((lesson) => lesson.semester_id === spring.id), 'no autumn rows in February');

    // Rebuilding spring (removing a pair, moving its start) never moves autumn's numbers.
    await ok('DELETE', `/api/admin/lessons/${networks.id}`);
    await ok('PUT', `/api/admin/semesters/${spring.id}`, { start_date: '2027-02-15' });
    await ok('PUT', `/api/admin/semesters/${spring.id}`, { start_date: '2027-02-08' });
    assert.equal(await planHours(autumn.id, autumnPlan.id), AUTUMN_TOTAL);

    // ── Spring under way ────────────────────────────────────────────────────
    at('2027-03-01T07:00:00'); // Monday of week 4, before its 08:00 pair
    const marchTeacher = await ok('GET', `/api/teachers/${teacherId}/load`);
    assert.equal(marchTeacher.semester.id, spring.id, 'teachers move to spring once it is in effect');
    assert.equal(marchTeacher.plan[0].occurred_hours, 6);
    const autumnOnDemand = await ok('GET', `/api/teachers/${teacherId}/load?semester_id=${autumn.id}`);
    assert.equal(autumnOnDemand.plan[0].occurred_hours, AUTUMN_TOTAL, 'last semester stays reachable');

    // The specialist looking at autumn's plan does not switch anything.
    await ok('GET', `/api/admin/load-plan?semester_id=${autumn.id}`);
    assert.equal((await ok('GET', '/api/admin/settings')).active_semester.id, spring.id);

    // ── Autumn 2027 ─────────────────────────────────────────────────────────
    at('2027-08-25T10:00:00');
    const nextAutumn = await ok('POST', '/api/admin/semesters', {
        label: 'Осень 2027', start_date: '2027-09-01', weeks_count: 18
    });
    await ok('PUT', `/api/admin/semesters/${nextAutumn.id}`, { is_active: true });

    assert.equal(await planHours(autumn.id, autumnPlan.id), AUTUMN_TOTAL);
    assert.equal(await planHours(spring.id, springPlan.id), 36, 'spring complete: 18 Mondays');
    assert.equal((await ok('GET', `/api/teachers/${teacherId}/load`)).semester.id, spring.id, 'before 1 Sept the finished spring is still shown');
    assert.deepEqual(await ok('GET', `/api/admin/lessons?group_id=${groupId}`), [], 'new autumn starts empty');

    const semesters = await ok('GET', '/api/semesters');
    assert.deepEqual(semesters.map((s) => s.label), ['Осень 2027', 'Весна 2027', 'Осень 2026']);
});
