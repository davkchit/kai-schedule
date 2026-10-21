const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// The Alice skill through its real webhook: remembering the group (per
// account and per device), the day asked for in words or as Alice's date
// entity, the week overview, exams in the answer, a joined group, the
// evening switch to tomorrow, help, exit, and the optional URL token.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-alice-')), 'schedule.db');

const { createApp } = require('../server/app');
const { closeDb, getDb } = require('../server/db');

const at = (localDateTime) => { process.env.KAI_FAKE_NOW = `${localDateTime}+03:00`; };
let baseUrl;
let leaderId;
let memberId;
let server;

test.before(async () => {
    const db = getDb();
    db.exec('DELETE FROM lessons; DELETE FROM attestations; DELETE FROM semesters; DELETE FROM groups_; DELETE FROM universities;');
    const uni = db.prepare("INSERT INTO universities (name, short_name) VALUES ('КНИТУ-КАИ', 'КНИТУ-КАИ')").run().lastInsertRowid;
    const leader = Number(db.prepare("INSERT INTO groups_ (university_id, name) VALUES (?, '23303')").run(uni).lastInsertRowid);
    leaderId = leader;
    memberId = Number(db.prepare("INSERT INTO groups_ (university_id, name, joined_to) VALUES (?, '23313', ?)").run(uni, leader).lastInsertRowid);
    const semester = Number(db.prepare("INSERT INTO semesters (label, start_date, weeks_count, first_week_parity, is_active) VALUES ('Осень', '2026-08-31', 18, 2, 1)").run().lastInsertRowid);
    const insert = db.prepare(`
        INSERT INTO lessons (semester_id, group_id, subgroup, day_of_week, week_type, specific_week, template_from_week, time_start, time_end, subject, room, lesson_type, kind)
        VALUES (?, ?, 0, ?, 0, 8, 1, ?, ?, ?, ?, ?, ?)
    `);
    // Week 8: 19–25 October 2026.
    insert.run(semester, leader, 3, '08:00', '09:30', 'Математика', '305', 'Лекция', 'lesson');
    insert.run(semester, leader, 3, '09:40', '11:10', 'Физика', 'онлайн', 'Практика', 'lesson');
    insert.run(semester, leader, 4, '11:30', '13:00', 'Информатика', '210', 'Лаб', 'lesson');
    insert.run(semester, leader, 5, '08:00', '09:30', 'Кураторский час', null, null, 'event');
    db.prepare(`INSERT INTO attestations (semester_id, group_id, subgroup, kind, date, time_start, discipline_text, room)
                VALUES (?, ?, 0, 'exam', '2026-10-23', '13:10', 'Химия', '101')`).run(semester, leader);

    const { app } = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(() => { closeDb(); delete process.env.KAI_FAKE_NOW; resolve(); })));

/** One phrase to the skill; returns { text, end, body }. */
async function say(command, { state = {}, user = false, isNew = false, entities = [], url = '/api/alice' } = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            version: '1.0',
            meta: { locale: 'ru-RU', timezone: 'Europe/Moscow' },
            session: { new: isNew, session_id: 's', message_id: 1, skill_id: 'k', application: { application_id: 'device-1' }, ...(user ? { user: { user_id: 'u-1' } } : {}) },
            request: { command, original_utterance: command, type: 'SimpleUtterance', nlu: { tokens: command.split(' '), entities } },
            state
        })
    });
    const body = await response.json();
    return { status: response.status, text: body.response?.text, end: body.response?.end_session, body };
}

test('first time: asks for the group, remembers it, then answers days', async () => {
    at('2026-10-21T07:00:00'); // Wednesday morning

    const hello = await say('', { isNew: true });
    assert.match(hello.text, /^Привет!.*номер вашей группы/);
    assert.equal(hello.end, false);

    const remembered = await say('двадцать три триста три', { entities: [] });
    assert.match(remembered.text, /номер/, 'words alone are not a number yet');

    const set = await say('23 303');
    assert.match(set.text, /^Запомнила: группа 23303\. Сегодня, в среду, 21 октября, 2 пары\. 8:00 — Математика, лекция, аудитория 305\. 9:40 — Физика, практика, онлайн\./);
    assert.deepEqual(set.body.application_state, { group_id: leaderId, group_name: '23303' });
    assert.equal(set.body.user_state_update, undefined, 'no Yandex account — device storage only');

    const state = { application: set.body.application_state };
    const tomorrow = await say('какие пары завтра', { state });
    assert.equal(tomorrow.text, 'Завтра, в четверг, 22 октября, 1 пара. 11:30 — Информатика, лабораторная, аудитория 210.');

    const friday = await say('что в пятницу', { state });
    assert.equal(friday.text, 'Послезавтра, в пятницу, 23 октября, пар нет. 8:00 — Кураторский час. 13:10 — экзамен по предмету Химия, аудитория 101.');

    const entity = await say('расписание на субботу', { state, entities: [{ type: 'YANDEX.DATETIME', value: { day: 3, day_is_relative: true } }] });
    assert.match(entity.text, /пар нет/);

    const week = await say('что на неделе', { state });
    assert.match(week.text, /^Неделя с 19 октября: среда — 2 занятия, с 8:00; четверг — 1 занятие, с 11:30; пятница — 2 занятия, с 8:00\./);
});

test('a logged-in user keeps the group on the account; a joined group hears its leader\'s pairs', async () => {
    at('2026-10-21T07:00:00');
    const set = await say('я из группы 23313', { user: true });
    assert.match(set.text, /^Запомнила: группа 23313\. Сегодня.*Математика/);
    assert.deepEqual(set.body.user_state_update, { group_id: memberId, group_name: '23313' });

    const later = await say('завтра', { user: true, state: { user: set.body.user_state_update } });
    assert.match(later.text, /Информатика/);

    const forget = await say('другая группа', { user: true, state: { user: set.body.user_state_update } });
    assert.deepEqual(forget.body.user_state_update, { group_id: null, group_name: null });
    assert.deepEqual(forget.body.application_state, {});
});

test('evening: with today\'s pairs over, tomorrow is told; unknown group, help, exit, ping, token', async () => {
    at('2026-10-21T19:00:00');
    const state = { application: { group_id: leaderId, group_name: '23303' } };
    const evening = await say('', { state });
    assert.match(evening.text, /^Сегодня пары уже закончились\. Завтра, в четверг/);

    assert.match((await say('группа 99999')).text, /Не нашла группу 99999/);
    assert.match((await say('что ты умеешь')).text, /расписание групп/);
    const bye = await say('хватит', { state });
    assert.equal(bye.end, true);
    assert.equal((await say('ping')).text, 'pong');

    process.env.ALICE_WEBHOOK_TOKEN = 'secret';
    delete require.cache[require.resolve('../server/config')];
    // The token is read at start-up; checked here through a fresh app.
    const { createApp: fresh } = (() => { for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key]; return require('../server/app'); })();
    const guarded = http.createServer(fresh().app);
    await new Promise((resolve) => guarded.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${guarded.address().port}/api/alice`;
    const post = (suffix) => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request: { command: 'ping', original_utterance: 'ping' }, session: {}, state: {} }) });
    assert.equal((await post('')).status, 403);
    assert.equal((await post('?token=secret')).status, 200);
    await new Promise((resolve) => guarded.close(resolve));
    delete process.env.ALICE_WEBHOOK_TOKEN;
});
