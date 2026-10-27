const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// What the public sees: only weeks entered as their own, only up to the end of
// this week — or of the next one once it is entered — and session days ahead
// of that. The template is the specialist's draft: never sent, never counted.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.ADMIN_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-visibility-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };
const localDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };

test('students see this week (and the next once entered), never the template; session days ahead; teachers and Alice alike', async (t) => {
    const { dayStatus, resolveLessonsForDay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'scheduleResolve.js')).href);
    const db = getDb();
    db.exec(`
        DELETE FROM attestations; DELETE FROM lessons; DELETE FROM load_plan; DELETE FROM semesters; DELETE FROM teachers;
        DELETE FROM disciplines; DELETE FROM admins; DELETE FROM groups_; DELETE FROM universities; DELETE FROM settings;
    `);
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('admin', bcrypt.hashSync('x', 4));
    const server = http.createServer(createApp().app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); delete process.env.KAI_FAKE_NOW; resolve(); })));
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

    const uni = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const groupId = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23101')").run(uni).lastInsertRowid);
    at('2026-08-25T10:00:00');
    const semester = await ok('POST', '/api/admin/semesters', { label: 'Осень', start_date: '2026-08-31', weeks_count: 18, first_week_parity: 1 });
    await ok('PUT', `/api/admin/semesters/${semester.id}`, { is_active: true });
    const teacher = (await ok('POST', '/api/admin/teachers', { full_name: 'Учитель А.А.' })).id;
    const discipline = (await ok('POST', '/api/admin/disciplines', { name: 'Физика' })).id;
    const plan = (await ok('POST', '/api/admin/load-plan', { semester_id: semester.id, teacher_id: teacher, discipline_id: discipline, lesson_type: 'Лекция', group_id: groupId, planned_hours: 40 })).id;
    const pair = { group_id: groupId, day_of_week: 2, time_start: '08:00', time_end: '09:30', week_type: 0, subject: 'Физика', room: '101', teacher_id: teacher, discipline_id: discipline, lesson_type: 'Лекция' };
    const enter = (week) => ok('POST', '/api/admin/schedule/materialize-week', { group_id: groupId, week_number: week, action: 'copy' });

    // The draft: a Tuesday pair. «Внести как в шаблоне» with nothing in it is refused first.
    assert.equal((await call('POST', '/api/admin/schedule/materialize-week', { group_id: groupId, week_number: 1, action: 'copy' })).status, 409);
    await ok('POST', '/api/admin/lessons', pair);

    at('2026-10-21T12:00:00'); // Wednesday of week 8
    await enter(8);
    const week = async (from, days = 21) => ok('GET', `/api/schedule/${groupId}?date=${from}&days=${days}`);
    const sees = (data, day) => resolveLessonsForDay(data, localDate(day)).map((item) => `${item.time_start} ${item.subject}`);

    // This week shows; the next isn't entered, so it isn't out; the template never comes.
    let data = await week('2026-10-19');
    assert.equal(data.visible_until, '2026-10-25');
    assert.ok(data.lessons.every((lesson) => lesson.specific_week !== null), 'no template rows on the wire');
    assert.deepEqual(sees(data, '2026-10-20'), ['08:00 Физика']);
    assert.equal(dayStatus(data, localDate('2026-10-24')), 'open', 'an entered week\'s free Saturday is a day off');
    assert.equal(dayStatus(data, localDate('2026-10-27')), 'closed');
    assert.deepEqual(sees(data, '2026-10-27'), []);

    // A week gone by that nobody entered: «Расписание не внесено».
    assert.equal(dayStatus(await week('2026-10-05', 7), localDate('2026-10-06')), 'not_entered');

    // Thursday: week 9 is entered — it opens. Week 10, entered too, stays closed.
    await enter(9);
    await enter(10);
    data = await week('2026-10-19');
    assert.equal(data.visible_until, '2026-11-01');
    assert.deepEqual(sees(data, '2026-10-27'), ['08:00 Физика']);
    assert.deepEqual(sees(data, '2026-11-03'), [], 'two weeks ahead: not yet');
    assert.ok(!data.lessons.some((lesson) => lesson.specific_week === 10), 'its rows are not even sent');

    // A session day ahead is shown — only it.
    await ok('POST', '/api/admin/attestations', { semester_id: semester.id, group_id: groupId, kind: 'exam', date: '2027-01-12', time_start: '09:00', time_end: '10:30', discipline_id: discipline, teacher_id: teacher });
    data = await ok('GET', `/api/schedule/${groupId}?date=2026-10-21&span=semester`);
    assert.deepEqual(sees(data, '2027-01-12'), ['09:00 Физика']);
    assert.equal(dayStatus(data, localDate('2027-01-12')), 'closed');

    // The teacher's page lists pairs as far as students may look; hours are what has passed.
    const load = await ok('GET', `/api/teachers/${teacher}/load`);
    const row = load.plan.find((item) => item.id === plan);
    assert.ok(row.occurrences.every((occurrence) => occurrence.date <= '2026-11-01'));
    assert.deepEqual(row.occurrences.map((occurrence) => occurrence.date), ['2026-10-20', '2026-10-27']);
    assert.equal(row.occurred_hours, 2, 'week 8 only — the draft weeks never counted');
    assert.equal(load.attestations.length, 1, 'the exam is shown ahead');

    // Alice says the same.
    const say = async (command) => (await (await fetch(`${baseUrl}/api/alice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: { command, original_utterance: command }, session: {}, state: { application: { group_id: groupId } } })
    })).json()).response.text;
    assert.match(await say('что 27 октября'), /27 октября, 1 пара/);
    assert.equal(await say('что 3 ноября'), 'Во вторник, 3 ноября: расписание ещё не внесено.');
    assert.match(await say('что 12 января'), /экзамен по предмету Физика.*Расписание пар ещё не внесено/);

    // Entered from the draft, a pair under an exam with an end time comes in taken out.
    await ok('POST', '/api/admin/attestations', { semester_id: semester.id, group_id: groupId, kind: 'credit', date: '2026-11-10', time_start: '08:00', time_end: '09:30', discipline_id: discipline, teacher_id: teacher });
    await enter(11);
    assert.deepEqual(db.prepare('SELECT is_removed FROM lessons WHERE specific_week = 11').all().map((r) => r.is_removed), [1]);
});
