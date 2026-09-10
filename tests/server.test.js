const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

process.env.JWT_SECRET = 'test-secret';

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { ADMIN_COOKIE_NAME } = require('../server/config');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');
const { parseTrustProxy } = require('../server/config');
const { formatLocalDate, getWeekMeta } = require('../server/utils/date');
const { resolveTemplateLessons } = require('../server/utils/templateResolve');

test.afterEach(async () => {
    closeDb();
    delete process.env.ADMIN_ALLOWED_IPS;
    delete process.env.BACKUPS_DIR;
    delete process.env.SEED_DB_PATH;

    if (process.env.DB_PATH) {
        const tempDir = path.dirname(process.env.DB_PATH);
        await fs.rm(tempDir, { recursive: true, force: true });
        delete process.env.DB_PATH;
    }
});

test('a missing database bootstraps from the seed snapshot instead of booting empty', async () => {
    // Build a tiny "seed" database with one recognizable marker row.
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-seed-'));
    const seedDbPath = path.join(seedDir, 'schedule.seed.db');

    process.env.DB_PATH = seedDbPath;
    closeDb();
    getDb().prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)')
        .run('Seed University', 'SEED-MARKER');
    closeDb();
    delete process.env.DB_PATH;

    // Point at a target path that does not exist yet, with SEED_DB_PATH set.
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-target-'));
    const targetDbPath = path.join(targetDir, 'schedule.db');

    process.env.DB_PATH = targetDbPath;
    process.env.SEED_DB_PATH = seedDbPath;

    const db = getDb();
    const university = db.prepare('SELECT * FROM universities WHERE short_name = ?').get('SEED-MARKER');

    assert.ok(university, 'expected the target database to be bootstrapped from the seed snapshot');
    assert.equal(university.name, 'Seed University');

    closeDb();
    delete process.env.DB_PATH;
    delete process.env.SEED_DB_PATH;
    await fs.rm(seedDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
});

test('an existing database is never overwritten by the seed snapshot', async () => {
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-seed-'));
    const seedDbPath = path.join(seedDir, 'schedule.seed.db');

    process.env.DB_PATH = seedDbPath;
    closeDb();
    getDb().prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)')
        .run('Seed University', 'SEED-MARKER');
    closeDb();
    delete process.env.DB_PATH;

    // Target already has its own real data before bootstrap ever runs.
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-target-'));
    const targetDbPath = path.join(targetDir, 'schedule.db');

    process.env.DB_PATH = targetDbPath;
    closeDb();
    getDb().prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)')
        .run('Real University', 'REAL-DATA');
    closeDb();
    delete process.env.DB_PATH;

    process.env.DB_PATH = targetDbPath;
    process.env.SEED_DB_PATH = seedDbPath;

    const db = getDb();
    const seedRow = db.prepare('SELECT * FROM universities WHERE short_name = ?').get('SEED-MARKER');
    const realRow = db.prepare('SELECT * FROM universities WHERE short_name = ?').get('REAL-DATA');

    assert.equal(seedRow, undefined, 'seed data must not be merged into an already-existing database');
    assert.ok(realRow, 'the real, pre-existing data must be untouched');

    closeDb();
    delete process.env.DB_PATH;
    delete process.env.SEED_DB_PATH;
    await fs.rm(seedDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
});

test('parseTrustProxy resolves a bare digit to a hop count, not the permissive boolean', () => {
    // This is the exact regression that shipped to Railway: TRUST_PROXY=1 was
    // meant as "trust one proxy hop" but resolved to `true` ("trust every
    // hop"), which express-rate-limit flags as ERR_ERL_PERMISSIVE_TRUST_PROXY
    // because it lets a client spoof X-Forwarded-For to dodge rate limiting.
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('0'), 0);
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy(' 1 '), 1);

    // Word forms still mean the fully-permissive/disabled boolean settings.
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('yes'), true);
    assert.equal(parseTrustProxy('on'), true);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('no'), false);
    assert.equal(parseTrustProxy('off'), false);

    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('not-a-number'), false);
});

test('getWeekMeta clamps dates before semester start to week 1', () => {
    const weekMeta = getWeekMeta('2026-02-09', '2026-01-01');

    assert.equal(weekMeta.weekNumber, 1);
    assert.equal(weekMeta.weekType, 'odd');
});

test('public schedule endpoint rejects invalid subgroup values', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/schedule/${context.primaryGroupId}?subgroup=3&date=2026-04-23`);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'Параметр subgroup должен быть 0, 1 или 2');

    await context.close();
});

test('admin lessons endpoint returns 404 for unknown groups', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/lessons?group_id=999999`, {
        headers: context.authHeaders
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Группа не найдена');

    await context.close();
});

test('admin lesson updates accept sunday as day_of_week', async () => {
    const context = await createTestContext();
    const lesson = getDb().prepare('SELECT id FROM lessons WHERE group_id = ? ORDER BY id LIMIT 1').get(context.primaryGroupId);

    const response = await fetch(`${context.baseUrl}/api/admin/lessons/${lesson.id}`, {
        method: 'PUT',
        headers: {
            ...context.authHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            day_of_week: 7
        })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.day_of_week, 7);

    await context.close();
});

test('schedule upload requires university when group name is ambiguous', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/upload`, {
        method: 'POST',
        headers: {
            ...context.authHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            group: '23113',
            target_week: 'template',
            lessons: [
                {
                    day: 1,
                    subgroup: 0,
                    time_start: '09:40',
                    time_end: '11:10',
                    subject: 'Высшая математика',
                    week_type: 'all'
                }
            ]
        })
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.error, /укажите поле university/i);

    await context.close();
});

test('public schedule endpoint only returns specific_week rows for requested window', async () => {
    const context = await createTestContext();
    const db = getDb();
    const insertLesson = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertLesson.run(
        context.primaryGroupId,
        0,
        2,
        0,
        2,
        '11:20',
        '12:50',
        'Specific Week In Range',
        '401',
        'Практика',
        null,
        2
    );
    insertLesson.run(
        context.primaryGroupId,
        0,
        2,
        0,
        8,
        '13:00',
        '14:30',
        'Specific Week Out Of Range',
        '402',
        'Практика',
        null,
        3
    );

    const response = await fetch(`${context.baseUrl}/api/schedule/${context.primaryGroupId}?date=2026-02-09&days=14`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.range_days, 14);
    assert.deepEqual(body.exception_weeks, [2]);
    assert.ok(body.lessons.some((lesson) => lesson.specific_week === 2));
    assert.ok(!body.lessons.some((lesson) => lesson.specific_week === 8));

    await context.close();
});

test('settings updates are written to the audit log', async () => {
    const context = await createTestContext();

    const updateResponse = await fetch(`${context.baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: {
            ...context.authHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            semester_start_date: '2026-02-16'
        })
    });

    assert.equal(updateResponse.status, 200);

    const logsResponse = await fetch(`${context.baseUrl}/api/admin/audit-logs?limit=10`, {
        headers: context.authHeaders
    });
    const logs = await logsResponse.json();

    assert.equal(logsResponse.status, 200);
    assert.ok(Array.isArray(logs));

    const settingsLog = logs.find((entry) => entry.action === 'settings.update');

    assert.ok(settingsLog);
    assert.equal(settingsLog.details.semester_start_date, '2026-02-16');
    assert.equal(settingsLog.admin_username, 'admin');

    await context.close();
});

test('cookie-authenticated admin mutations require a CSRF token', async () => {
    const context = await createTestContext();
    const authCookie = `${ADMIN_COOKIE_NAME}=${createToken({ id: 1, username: 'admin' })}`;
    const sessionResponse = await fetch(`${context.baseUrl}/api/admin/session`, {
        headers: {
            Cookie: authCookie
        }
    });
    const sessionBody = await sessionResponse.json();
    const csrfCookie = sessionResponse.headers.get('set-cookie').split(';')[0];
    const cookieHeader = `${authCookie}; ${csrfCookie}`;

    assert.equal(sessionResponse.status, 200);
    assert.ok(sessionBody.csrf_token);

    const blockedResponse = await fetch(`${context.baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: {
            Cookie: cookieHeader,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            semester_start_date: '2026-02-16'
        })
    });
    const blockedBody = await blockedResponse.json();

    assert.equal(blockedResponse.status, 403);
    assert.equal(blockedBody.error, 'Требуется CSRF-токен');

    const updateResponse = await fetch(`${context.baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: {
            Cookie: cookieHeader,
            'Content-Type': 'application/json',
            'X-CSRF-Token': sessionBody.csrf_token
        },
        body: JSON.stringify({
            semester_start_date: '2026-02-16'
        })
    });

    assert.equal(updateResponse.status, 200);

    await context.close();
});

test('admin API is blocked for IPs outside the allowlist', async () => {
    process.env.ADMIN_ALLOWED_IPS = '10.10.10.10';
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/session`, {
        headers: context.authHeaders
    });
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.error, 'Доступ к админке с этого IP-адреса запрещён');

    await context.close();
});

test('login rate limit survives a server restart', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-test-'));
    process.env.DB_PATH = path.join(tempDir, 'schedule.db');

    closeDb();
    seedTestDatabase();

    let serverContext = await startTestServer();

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`${serverContext.baseUrl}/api/admin/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: 'admin',
                password: 'wrong-password'
            })
        });

        assert.equal(response.status, 401);
    }

    await serverContext.close();
    serverContext = await startTestServer();

    const blockedResponse = await fetch(`${serverContext.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            username: 'admin',
            password: 'wrong-password'
        })
    });
    const blockedBody = await blockedResponse.json();

    assert.equal(blockedResponse.status, 429);
    assert.ok(blockedBody.retry_after_sec > 0);

    await serverContext.close();
});

test('backup endpoints create and list SQLite backups', async () => {
    const context = await createTestContext();

    const createResponse = await fetch(`${context.baseUrl}/api/admin/backups`, {
        method: 'POST',
        headers: context.authHeaders
    });
    const createBody = await createResponse.json();

    assert.equal(createResponse.status, 200);
    assert.equal(createBody.success, true);
    assert.match(createBody.backup.file_name, /^schedule-backup-\d{8}-\d{6}\.db$/);

    const listResponse = await fetch(`${context.baseUrl}/api/admin/backups`, {
        headers: context.authHeaders
    });
    const listBody = await listResponse.json();

    assert.equal(listResponse.status, 200);
    assert.ok(Array.isArray(listBody));
    assert.ok(listBody.some((entry) => entry.file_name === createBody.backup.file_name));

    await context.close();
});

test('audit log CSV export returns text/csv with audit entries', async () => {
    const context = await createTestContext();

    await fetch(`${context.baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: {
            ...context.authHeaders,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            semester_start_date: '2026-02-16'
        })
    });

    const response = await fetch(`${context.baseUrl}/api/admin/audit-logs/export?limit=100`, {
        headers: context.authHeaders
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(body, /settings\.update/);
    assert.match(body, /semester_start_date/);

    await context.close();
});

// Mirrors the per-day visibility decision in buildScheduleDays (src/pages/SchedulePage.jsx):
// on an exception week, only that week's own specific_week rows are shown (no merge
// with the template); otherwise the shared resolveTemplateLessons algorithm picks the
// active template version. Duplicated here (not imported) because that file is JSX
// wired to react-router-dom and isn't loadable in a plain Node test.
function resolveVisibleLessons(lessonsForDay, weekNumber, weekType, exceptionWeeks) {
    if (exceptionWeeks.has(weekNumber)) {
        return lessonsForDay.filter((lesson) => lesson.specific_week === weekNumber);
    }

    const templateCandidates = lessonsForDay.filter(
        (lesson) => lesson.specific_week == null && (lesson.week_type === 0 || lesson.week_type === weekType)
    );

    return resolveTemplateLessons(templateCandidates, weekNumber);
}

test('editing the template mid-semester does not rewrite history for past weeks', async () => {
    const context = await createTestContext();
    const db = getDb();

    // Simulate an admin edit that takes effect from week 5 onward, on the same
    // slot as the seeded week-1 template lesson (Monday, odd weeks).
    db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order
        )
        VALUES (?, 0, 1, 1, NULL, 5, 0, '09:40', '11:10', 'Дискретная математика', '305 каб.', 'Лекция', 'Иванов И.И.', 1)
    `).run(context.primaryGroupId);

    const pastResponse = await fetch(`${context.baseUrl}/api/schedule/${context.primaryGroupId}?date=2026-02-23&days=1`);
    const pastBody = await pastResponse.json();
    assert.equal(pastBody.week_number, 3);

    const pastLessons = resolveVisibleLessons(pastBody.by_day[1] || [], 3, 1, new Set(pastBody.exception_weeks));
    assert.deepEqual(pastLessons.map((l) => l.subject), ['Высшая математика']);

    const futureResponse = await fetch(`${context.baseUrl}/api/schedule/${context.primaryGroupId}?date=2026-03-09&days=1`);
    const futureBody = await futureResponse.json();
    assert.equal(futureBody.week_number, 5);

    const futureLessons = resolveVisibleLessons(futureBody.by_day[1] || [], 5, 1, new Set(futureBody.exception_weeks));
    assert.deepEqual(futureLessons.map((l) => l.subject), ['Дискретная математика']);

    await context.close();
});

test('POST /lessons ignores a client-supplied template_from_week and always anchors to the real current week', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/lessons`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            group_id: context.primaryGroupId,
            day_of_week: 1,
            time_start: '09:40',
            time_end: '11:10',
            subject: 'Подделанная версия',
            subgroup: 0,
            week_type: 1,
            specific_week: null,
            // An attacker (or a buggy client) claiming this version took effect
            // back at week 1 must not be able to rewrite what week 1 showed.
            template_from_week: 1,
            is_removed: false
        })
    });
    const created = await response.json();

    assert.equal(response.status, 201);

    const expectedWeek = getWeekMeta('2026-02-09', formatLocalDate()).weekNumber;
    assert.equal(created.template_from_week, expectedWeek);
    assert.notEqual(created.template_from_week, 1);

    await context.close();
});

test('materialize-week clones the rest of the template, not just the touched slot', async () => {
    const context = await createTestContext();
    const db = getDb();

    // Second template lesson, untouched by the upcoming edit, that must survive cloning.
    db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order
        )
        VALUES (?, 0, 2, 0, NULL, '11:30', '13:00', 'Физика', '210 каб.', 'Практика', 'Петров П.П.', 1)
    `).run(context.primaryGroupId);

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/materialize-week`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            group_id: context.primaryGroupId,
            week_number: 3,
            action: 'upsert',
            day_of_week: 3,
            time_start: '14:20',
            time_end: '15:50',
            subgroup: 0,
            subject: 'Новый предмет',
            room: '101 каб.',
            lesson_type: 'Семинар',
            teacher: 'Сидоров С.С.'
        })
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.count, 3);

    const lessonsResponse = await fetch(`${context.baseUrl}/api/admin/lessons?group_id=${context.primaryGroupId}`, {
        headers: context.authHeaders
    });
    const allLessons = await lessonsResponse.json();
    const weekLessons = allLessons.filter((lesson) => lesson.specific_week === 3);

    assert.equal(weekLessons.length, 3);
    assert.deepEqual(
        weekLessons.map((lesson) => lesson.subject).sort(),
        ['Высшая математика', 'Новый предмет', 'Физика']
    );

    await context.close();
});

test('a materialized week fully suppresses the template for that week (no merge)', async () => {
    const context = await createTestContext();

    const materializeResponse = await fetch(`${context.baseUrl}/api/admin/schedule/materialize-week`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            group_id: context.primaryGroupId,
            week_number: 3,
            action: 'upsert',
            day_of_week: 3,
            time_start: '14:20',
            time_end: '15:50',
            subgroup: 0,
            subject: 'Новый предмет',
            room: '101 каб.',
            lesson_type: 'Семинар',
            teacher: 'Сидоров С.С.'
        })
    });
    assert.equal(materializeResponse.status, 201);

    const response = await fetch(`${context.baseUrl}/api/schedule/${context.primaryGroupId}?date=2026-02-23&days=7`);
    const body = await response.json();

    assert.deepEqual(body.exception_weeks, [3]);

    // The server still returns the raw template row for Monday alongside the
    // cloned specific_week=3 row — the "no merge" guarantee is enforced by the
    // client's visibility filter, not by the API pre-filtering it away.
    const mondayRaw = body.by_day[1] || [];
    assert.ok(mondayRaw.some((lesson) => lesson.specific_week === null && lesson.subject === 'Высшая математика'));
    assert.ok(mondayRaw.some((lesson) => lesson.specific_week === 3 && lesson.subject === 'Высшая математика'));

    const mondayVisible = resolveVisibleLessons(mondayRaw, 3, 1, new Set(body.exception_weeks));
    assert.equal(mondayVisible.length, 1);
    assert.equal(mondayVisible[0].specific_week, 3);

    await context.close();
});

test('deleting a materialized week reverts the group back to the template', async () => {
    const context = await createTestContext();

    await fetch(`${context.baseUrl}/api/admin/schedule/materialize-week`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            group_id: context.primaryGroupId,
            week_number: 3,
            action: 'upsert',
            day_of_week: 3,
            time_start: '14:20',
            time_end: '15:50',
            subgroup: 0,
            subject: 'Новый предмет',
            room: null,
            lesson_type: null,
            teacher: null
        })
    });

    const deleteResponse = await fetch(
        `${context.baseUrl}/api/admin/schedule/week?group_id=${context.primaryGroupId}&week_number=3`,
        { method: 'DELETE', headers: context.authHeaders }
    );
    const deleteBody = await deleteResponse.json();

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteBody.deleted, 2);

    const response = await fetch(`${context.baseUrl}/api/schedule/${context.primaryGroupId}?date=2026-02-23&days=1`);
    const body = await response.json();

    assert.deepEqual(body.exception_weeks, []);

    const mondayVisible = resolveVisibleLessons(body.by_day[1] || [], 3, 1, new Set(body.exception_weeks));
    assert.deepEqual(mondayVisible.map((lesson) => lesson.subject), ['Высшая математика']);

    await context.close();
});

test('PUT /account rejects a wrong current password', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/account`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'wrong-password', new_password: 'new-password-123' })
    });

    assert.equal(response.status, 401);

    await context.close();
});

test('PUT /account rejects a new password shorter than 8 characters', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/account`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'admin123', new_password: 'short' })
    });

    assert.equal(response.status, 400);

    await context.close();
});

test('PUT /account changes the password and the old password stops working', async () => {
    const context = await createTestContext();

    const updateResponse = await fetch(`${context.baseUrl}/api/admin/account`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'admin123', new_password: 'new-password-123' })
    });
    const updateBody = await updateResponse.json();

    assert.equal(updateResponse.status, 200);
    assert.equal(updateBody.username, 'admin');

    const oldLoginResponse = await fetch(`${context.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
    });
    assert.equal(oldLoginResponse.status, 401);

    const newLoginResponse = await fetch(`${context.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'new-password-123' })
    });
    assert.equal(newLoginResponse.status, 200);

    await context.close();
});

test('PUT /account changes the username and rejects a collision with an existing one', async () => {
    const context = await createTestContext();
    const db = getDb();

    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)')
        .run('second_admin', bcrypt.hashSync('irrelevant-password', 10));

    const collisionResponse = await fetch(`${context.baseUrl}/api/admin/account`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'admin123', new_username: 'second_admin' })
    });
    assert.equal(collisionResponse.status, 409);

    const okResponse = await fetch(`${context.baseUrl}/api/admin/account`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: 'admin123', new_username: 'renamed_admin' })
    });
    const okBody = await okResponse.json();

    assert.equal(okResponse.status, 200);
    assert.equal(okBody.username, 'renamed_admin');

    await context.close();
});

test('public API is rate-limited past the configured request budget', async () => {
    const context = await createTestContext();

    const requests = [];

    for (let i = 0; i < 201; i += 1) {
        requests.push(fetch(`${context.baseUrl}/api/universities`));
    }

    const responses = await Promise.all(requests);
    const statuses = responses.map((response) => response.status);

    assert.ok(statuses.includes(429), 'expected at least one request to be rate-limited');
    assert.ok(statuses.filter((status) => status === 200).length <= 200);

    await context.close();
});

test('move in template mode: tombstones the old slot and creates the new one, without rewriting past weeks', async () => {
    const context = await createTestContext();
    const db = getDb();

    const original = db.prepare('SELECT * FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/move-lesson`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lesson_id: original.id,
            mode: 'template',
            day_of_week: 3,
            time_start: '13:10',
            time_end: '14:40'
        })
    });

    assert.equal(response.status, 200);

    // The original row is untouched — history is never rewritten in place.
    const untouched = db.prepare('SELECT * FROM lessons WHERE id = ?').get(original.id);
    assert.equal(untouched.day_of_week, original.day_of_week);
    assert.equal(untouched.is_removed, 0);

    const currentWeek = getWeekMeta('2026-02-09', formatLocalDate()).weekNumber;

    const tombstone = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ? AND is_removed = 1 AND day_of_week = ? AND time_start = ?
    `).get(context.primaryGroupId, original.day_of_week, original.time_start);
    assert.ok(tombstone, 'expected a tombstone at the old slot');
    assert.equal(tombstone.template_from_week, currentWeek);

    const moved = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ? AND day_of_week = 3 AND time_start = '13:10' AND is_removed = 0
    `).get(context.primaryGroupId);
    assert.ok(moved, 'expected a new row at the target slot');
    assert.equal(moved.subject, original.subject);
    assert.equal(moved.template_from_week, currentWeek);

    // A week before the move still resolves to the old slot.
    const pastWeekLessons = resolveTemplateLessons(
        db.prepare('SELECT * FROM lessons WHERE group_id = ? AND specific_week IS NULL').all(context.primaryGroupId),
        1
    );
    assert.equal(pastWeekLessons.length, 1);
    assert.equal(pastWeekLessons[0].day_of_week, original.day_of_week);
    assert.equal(pastWeekLessons[0].time_start, original.time_start);

    await context.close();
});

test('move in week mode materializes the week and places the lesson at its new slot', async () => {
    const context = await createTestContext();
    const db = getDb();

    // A second template lesson that must survive the materialization untouched.
    db.prepare(`
        INSERT INTO lessons (group_id, subgroup, day_of_week, week_type, specific_week, time_start, time_end, subject, sort_order)
        VALUES (?, 0, 2, 0, NULL, '11:30', '13:00', 'Физика', 1)
    `).run(context.primaryGroupId);

    const original = db.prepare("SELECT * FROM lessons WHERE group_id = ? AND subject = 'Высшая математика'").get(context.primaryGroupId);

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/move-lesson`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lesson_id: original.id,
            mode: 'week',
            week_number: 3,
            day_of_week: 5,
            time_start: '15:00',
            time_end: '16:30'
        })
    });

    assert.equal(response.status, 200);

    const weekRows = db.prepare('SELECT * FROM lessons WHERE group_id = ? AND specific_week = 3').all(context.primaryGroupId);

    // Both lessons are now real rows for week 3 — the untouched one kept its slot,
    // the moved one landed on its new one.
    assert.equal(weekRows.length, 2);
    const movedRow = weekRows.find((row) => row.subject === 'Высшая математика');
    const untouchedRow = weekRows.find((row) => row.subject === 'Физика');

    assert.equal(movedRow.day_of_week, 5);
    assert.equal(movedRow.time_start, '15:00');
    assert.equal(untouchedRow.day_of_week, 2);
    assert.equal(untouchedRow.time_start, '11:30');

    // The template itself is untouched — other weeks still show the original slot.
    const templateRow = db.prepare('SELECT * FROM lessons WHERE id = ?').get(original.id);
    assert.equal(templateRow.day_of_week, original.day_of_week);

    await context.close();
});

test('move in an already-materialized week updates that week only', async () => {
    const context = await createTestContext();
    const db = getDb();

    db.prepare(`
        INSERT INTO lessons (group_id, subgroup, day_of_week, week_type, specific_week, time_start, time_end, subject, sort_order)
        VALUES (?, 0, 1, 0, 4, '09:40', '11:10', 'Уже материализовано', 0)
    `).run(context.primaryGroupId);

    const weekRow = db.prepare("SELECT * FROM lessons WHERE specific_week = 4 AND group_id = ?").get(context.primaryGroupId);

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/move-lesson`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lesson_id: weekRow.id,
            mode: 'week',
            week_number: 4,
            day_of_week: 4,
            time_start: '11:30',
            time_end: '13:00'
        })
    });

    assert.equal(response.status, 200);

    const updated = db.prepare('SELECT * FROM lessons WHERE id = ?').get(weekRow.id);
    assert.equal(updated.day_of_week, 4);
    assert.equal(updated.time_start, '11:30');
    assert.equal(updated.specific_week, 4, 'the row must stay scoped to its own week');

    // No extra rows were created — this branch moves in place.
    const weekRowCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ? AND specific_week = 4').get(context.primaryGroupId).c;
    assert.equal(weekRowCount, 1);

    await context.close();
});

test('move rejects a target slot that is already taken', async () => {
    const context = await createTestContext();
    const db = getDb();

    db.prepare(`
        INSERT INTO lessons (group_id, subgroup, day_of_week, week_type, specific_week, time_start, time_end, subject, sort_order)
        VALUES (?, 0, 2, 1, NULL, '11:30', '13:00', 'Занятая ячейка', 1)
    `).run(context.primaryGroupId);

    const original = db.prepare("SELECT * FROM lessons WHERE group_id = ? AND subject = 'Высшая математика'").get(context.primaryGroupId);

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/move-lesson`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lesson_id: original.id,
            mode: 'template',
            day_of_week: 2,
            time_start: '11:30',
            time_end: '13:00'
        })
    });

    assert.equal(response.status, 409);

    // Nothing was written — no tombstone, no new row.
    const tombstones = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ? AND is_removed = 1').get(context.primaryGroupId).c;
    assert.equal(tombstones, 0);

    await context.close();
});

test('moving a lesson onto its own slot is a no-op', async () => {
    const context = await createTestContext();
    const db = getDb();

    const original = db.prepare('SELECT * FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);
    const countBefore = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ?').get(context.primaryGroupId).c;

    const response = await fetch(`${context.baseUrl}/api/admin/schedule/move-lesson`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lesson_id: original.id,
            mode: 'template',
            day_of_week: original.day_of_week,
            time_start: original.time_start,
            time_end: original.time_end
        })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.moved, false);

    const countAfter = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ?').get(context.primaryGroupId).c;
    assert.equal(countAfter, countBefore, 'a no-op move must not write anything');

    await context.close();
});

test('teachers and disciplines: create, list, and reject duplicates', async () => {
    const context = await createTestContext();

    const teacherResponse = await fetch(`${context.baseUrl}/api/admin/teachers`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Мустафин А.Р.' })
    });
    assert.equal(teacherResponse.status, 201);

    const dupResponse = await fetch(`${context.baseUrl}/api/admin/teachers`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Мустафин А.Р.' })
    });
    assert.equal(dupResponse.status, 409);

    const disciplineResponse = await fetch(`${context.baseUrl}/api/admin/disciplines`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Матанализ' })
    });
    assert.equal(disciplineResponse.status, 201);

    const listResponse = await fetch(`${context.baseUrl}/api/admin/teachers`, { headers: context.authHeaders });
    const list = await listResponse.json();
    assert.deepEqual(list.map((t) => t.full_name), ['Мустафин А.Р.']);

    await context.close();
});

test('semesters: activating one deactivates every other', async () => {
    const context = await createTestContext();

    const fallResponse = await fetch(`${context.baseUrl}/api/admin/semesters`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Осень 2026-2027', start_date: '2026-09-01', weeks_count: 18 })
    });
    const fall = await fallResponse.json();

    const springResponse = await fetch(`${context.baseUrl}/api/admin/semesters`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Весна 2026-2027', start_date: '2027-02-01', weeks_count: 18 })
    });
    const spring = await springResponse.json();

    await fetch(`${context.baseUrl}/api/admin/semesters/${fall.id}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true })
    });

    const afterFallActivate = await (await fetch(`${context.baseUrl}/api/admin/semesters`, { headers: context.authHeaders })).json();
    assert.equal(afterFallActivate.find((s) => s.id === fall.id).is_active, true);
    assert.equal(afterFallActivate.find((s) => s.id === spring.id).is_active, false);

    await fetch(`${context.baseUrl}/api/admin/semesters/${spring.id}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: true })
    });

    const afterSpringActivate = await (await fetch(`${context.baseUrl}/api/admin/semesters`, { headers: context.authHeaders })).json();
    assert.equal(afterSpringActivate.find((s) => s.id === fall.id).is_active, false);
    assert.equal(afterSpringActivate.find((s) => s.id === spring.id).is_active, true);

    await context.close();
});

test('load plan end-to-end: create a plan, link a schedule lesson, and see real hours counted', async () => {
    const context = await createTestContext();
    const db = getDb();

    const teacherId = (await (await fetch(`${context.baseUrl}/api/admin/teachers`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Гареева Л.М.' })
    })).json()).id;

    const disciplineId = (await (await fetch(`${context.baseUrl}/api/admin/disciplines`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Программирование' })
    })).json()).id;

    // A semester safely in the past relative to "now" — every one of its
    // weeks should already have happened, so the expected total is exact
    // and never flaky.
    const semester = await (await fetch(`${context.baseUrl}/api/admin/semesters`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Test semester', start_date: '2026-02-09', weeks_count: 4 })
    })).json();

    const planResponse = await fetch(`${context.baseUrl}/api/admin/load-plan`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            semester_id: semester.id,
            teacher_id: teacherId,
            discipline_id: disciplineId,
            lesson_type: 'Лаб',
            group_id: context.primaryGroupId,
            planned_hours: 8
        })
    });
    const plan = await planResponse.json();

    assert.equal(planResponse.status, 201);
    // Not linked to any schedule lesson yet — zero hours so far.
    assert.equal(plan.progress.occurred_hours, 0);

    // Link the group's existing Monday template lesson (seeded by
    // seedTestDatabase, week_type odd) to this plan row.
    const lessonRow = db.prepare('SELECT id FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);
    const linkResponse = await fetch(`${context.baseUrl}/api/admin/lessons/${lessonRow.id}/load-plan`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_plan_id: plan.id })
    });
    assert.equal(linkResponse.status, 200);

    const listResponse = await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semester.id}`, {
        headers: context.authHeaders
    });
    const list = await listResponse.json();
    const updatedPlan = list.find((p) => p.id === plan.id);

    // week_type=1 (odd) over 4 weeks => weeks 1 and 3 => 2 occurrences x 2h.
    assert.equal(updatedPlan.progress.occurred_count, 2);
    assert.equal(updatedPlan.progress.occurred_hours, 4);
    assert.equal(updatedPlan.progress.remaining_hours, 4);

    // Unlinking brings it back to zero.
    await fetch(`${context.baseUrl}/api/admin/lessons/${lessonRow.id}/load-plan`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ load_plan_id: null })
    });
    const afterUnlink = await (await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semester.id}`, {
        headers: context.authHeaders
    })).json();
    assert.equal(afterUnlink.find((p) => p.id === plan.id).progress.occurred_hours, 0);

    await context.close();
});

test('load plan rejects a reference to a group/teacher/discipline that does not exist', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/admin/load-plan`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            semester_id: 999999,
            teacher_id: 999999,
            discipline_id: 999999,
            lesson_type: 'Лекция',
            group_id: context.primaryGroupId,
            planned_hours: 10
        })
    });

    assert.equal(response.status, 404);

    await context.close();
});

test('public teacher search finds by partial name, and the load endpoint returns the active semester without asking for it', async () => {
    const context = await createTestContext();
    const db = getDb();

    const teacher = db.prepare('INSERT INTO teachers (full_name) VALUES (?)').run('Хамидуллин М. Р.');
    const discipline = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run('Информационная безопасность');
    const semester = db.prepare(`
        INSERT INTO semesters (label, start_date, weeks_count, is_active)
        VALUES (?, ?, ?, 1)
    `).run('Осень 2026-2027', '2026-02-09', 4);
    db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours, entered_by, confirmed)
        VALUES (?, ?, ?, 'Лекция', ?, 36, 'specialist', 1)
    `).run(semester.lastInsertRowid, teacher.lastInsertRowid, discipline.lastInsertRowid, context.primaryGroupId);

    const searchResponse = await fetch(`${context.baseUrl}/api/teachers/search?q=хамидул`);
    const searchResults = await searchResponse.json();
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].full_name, 'Хамидуллин М. Р.');

    const loadResponse = await fetch(`${context.baseUrl}/api/teachers/${teacher.lastInsertRowid}/load`);
    const loadBody = await loadResponse.json();

    assert.equal(loadBody.semester.label, 'Осень 2026-2027');
    assert.equal(loadBody.plan.length, 1);
    assert.equal(loadBody.plan[0].discipline_name, 'Информационная безопасность');
    assert.equal(loadBody.plan[0].planned_hours, 36);

    await context.close();
});

async function createTestContext() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-test-'));
    process.env.DB_PATH = path.join(tempDir, 'schedule.db');

    closeDb();
    seedTestDatabase();

    const serverContext = await startTestServer();

    return {
        ...serverContext,
        primaryGroupId: getPrimaryGroupId(),
        authHeaders: {
            Authorization: `Bearer ${createToken({ id: 1, username: 'admin' })}`
        }
    };
}

async function startTestServer() {
    const { app } = createApp();
    const server = http.createServer(app);

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return {
        baseUrl,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                closeDb();
                resolve();
            });
        })
    };
}

function seedTestDatabase() {
    const db = getDb();

    db.exec(`
        DELETE FROM audit_logs;
        DELETE FROM login_attempts;
        DELETE FROM lessons;
        DELETE FROM admins;
        DELETE FROM groups_;
        DELETE FROM universities;
        DELETE FROM settings;
    `);

    const adminHash = bcrypt.hashSync('admin123', 10);
    const insertUniversity = db.prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)');
    const insertGroup = db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)');
    const insertLesson = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const firstUniversity = insertUniversity.run('Казанский национальный исследовательский технический университет им. А.Н. Туполева', 'КНИТУ-КАИ');
    const secondUniversity = insertUniversity.run('Второй тестовый университет', 'ТЕСТ-ВУЗ');

    const primaryGroup = insertGroup.run(firstUniversity.lastInsertRowid, '23113');
    insertGroup.run(secondUniversity.lastInsertRowid, '23113');

    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'admin', adminHash);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('semester_start_date', '2026-02-09');

    insertLesson.run(
        primaryGroup.lastInsertRowid,
        0,
        1,
        1,
        null,
        '09:40',
        '11:10',
        'Высшая математика',
        '305 каб.',
        'Лекция',
        'Иванов И.И.',
        1
    );
}

function getPrimaryGroupId() {
    const db = getDb();
    const row = db.prepare(`
        SELECT g.id
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        WHERE u.short_name = ? AND g.name = ?
    `).get('КНИТУ-КАИ', '23113');

    return row.id;
}
