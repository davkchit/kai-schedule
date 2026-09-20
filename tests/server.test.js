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
const { computeLoadProgress } = require('../server/utils/loadCalc');

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
    // PUT /lessons/:id is for a week's OWN row — a template row (specific_week
    // IS NULL) must go through the versioned POST instead, so this fixture
    // needs its own specific-week row rather than reusing the seeded template.
    const inserted = getDb().prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order, semester_id
        )
        VALUES (?, 0, 2, 0, 3, '11:20', '12:50', 'Физика', '210 каб.', 'Лекция', 'Петров П.П.', 1, ?)
    `).run(context.primaryGroupId, context.semesterId);
    const lesson = { id: inserted.lastInsertRowid };

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

test('PUT /lessons/:id refuses to edit a live template row in place, only its own week', async () => {
    const context = await createTestContext();
    // The seeded fixture lesson is a template row (specific_week IS NULL) —
    // editing it via PUT would rewrite it in place, changing what every week
    // (past ones included) shows, since resolveTemplateLessons never sees a
    // new version. That has to go through POST /lessons + replaces_lesson_id.
    const templateLesson = getDb().prepare('SELECT id FROM lessons WHERE group_id = ? AND specific_week IS NULL LIMIT 1').get(context.primaryGroupId);

    const blocked = await fetch(`${context.baseUrl}/api/admin/lessons/${templateLesson.id}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: '999' })
    });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /шаблон/i);
    assert.equal(getDb().prepare('SELECT room FROM lessons WHERE id = ?').get(templateLesson.id).room, '305 каб.', 'the refused PUT must not have written anything');

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
            // A slot the fixture leaves free — the point here is the
            // template_from_week anchoring, not slot occupancy (which has its
            // own tests), and an occupied cell is now correctly refused.
            day_of_week: 6,
            time_start: '16:40',
            time_end: '18:10',
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

test('a burst of public reads from one address is not throttled — the whole campus shares one', async () => {
    // Everyone on the university network leaves through a single NAT address,
    // so a per-IP budget counts a thousand students as one visitor. A break
    // between pairs must not end with most of them seeing an error.
    const context = await createTestContext();

    const statuses = await fireRequests(400, () => fetch(`${context.baseUrl}/api/universities`));

    assert.equal(statuses.filter((status) => status === 429).length, 0, 'public reads must survive a campus-sized burst');

    await context.close();
});

test('the admin area keeps a tight request budget', async () => {
    // Writing needs a login, and one specialist never makes hundreds of
    // requests a minute — so a flood here is either a bug or an attack.
    const context = await createTestContext();

    const statuses = await fireRequests(320, () => fetch(`${context.baseUrl}/api/admin/groups`, { headers: context.authHeaders }));

    assert.ok(statuses.includes(429), 'expected the admin limiter to kick in');

    await context.close();
});

test('health check answers with the state of the database', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.database, 'ok');
    assert.ok(body.groups > 0, 'a live server can count its groups');
    assert.equal(body.working_semester, 'Тестовый семестр');

    await context.close();
});

test('an "every week" template pair blocks its cell on both parities, and a чётная/нечётная pair can still share one', async () => {
    const context = await createTestContext();
    const db = getDb();

    const slot = { day_of_week: 4, time_start: '13:10', time_end: '14:40' };
    const create = (body) => fetch(`${context.baseUrl}/api/admin/lessons`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: context.primaryGroupId, ...slot, ...body })
    });

    // чётная + нечётная in one cell is legitimate — different subject depending
    // on the week. The real schedule has 90 such slots, so this must stay allowed.
    assert.equal((await create({ week_type: 1, subject: 'Нечётный предмет' })).status, 201);
    assert.equal((await create({ week_type: 2, subject: 'Чётный предмет' })).status, 201);

    // "Every week" overlaps both, so the cell is taken.
    const everyWeek = await create({ week_type: 0, subject: 'Каждую неделю' });
    assert.equal(everyWeek.status, 409, 'an "every week" pair must not fit a cell that already has a parity pair');

    // And the reverse: an "every week" pair blocks a parity pair afterwards.
    const freeSlot = { day_of_week: 5, time_start: '15:00', time_end: '16:30' };
    const createFree = (body) => fetch(`${context.baseUrl}/api/admin/lessons`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: context.primaryGroupId, ...freeSlot, ...body })
    });
    assert.equal((await createFree({ week_type: 0, subject: 'Каждую неделю' })).status, 201);
    assert.equal((await createFree({ week_type: 1, subject: 'Нечётный' })).status, 409);
    assert.equal((await createFree({ week_type: 2, subject: 'Чётный' })).status, 409);

    const inFreeSlot = db.prepare(`
        SELECT COUNT(*) c FROM lessons
        WHERE group_id = ? AND day_of_week = 5 AND time_start = '15:00' AND specific_week IS NULL
    `).get(context.primaryGroupId).c;
    assert.equal(inFreeSlot, 1, 'the refused creates must not have written anything');

    await context.close();
});

test('a cell emptied by retiring its pair can be filled again (the occupancy check resolves tombstones)', async () => {
    const context = await createTestContext();
    const db = getDb();

    const existing = db.prepare('SELECT * FROM lessons WHERE group_id = ? AND specific_week IS NULL LIMIT 1').get(context.primaryGroupId);

    // Same slot, same parity — must be refused while the pair is live.
    const blocked = await fetch(`${context.baseUrl}/api/admin/lessons`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            group_id: context.primaryGroupId,
            day_of_week: existing.day_of_week,
            time_start: existing.time_start,
            time_end: existing.time_end,
            week_type: existing.week_type,
            subject: 'Дубль'
        })
    });
    assert.equal(blocked.status, 409);

    // Retire it, then the cell must accept a new pair — a naive
    // "any row with is_removed = 0" check would keep reporting it as taken.
    db.prepare('UPDATE lessons SET template_from_week = 1 WHERE id = ?').run(existing.id);
    const retire = await fetch(`${context.baseUrl}/api/admin/lessons/${existing.id}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(retire.status, 200);

    const refill = await fetch(`${context.baseUrl}/api/admin/lessons`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            group_id: context.primaryGroupId,
            day_of_week: existing.day_of_week,
            time_start: existing.time_start,
            time_end: existing.time_end,
            week_type: existing.week_type,
            subject: 'Новая пара'
        })
    });
    assert.equal(refill.status, 201, 'an emptied cell must be refillable');

    await context.close();
});

test('deleting a template pair mid-semester retires it forward instead of erasing hours already taught', async () => {
    const context = await createTestContext();
    const db = getDb();

    const teacherId = db.prepare("INSERT INTO teachers (full_name) VALUES ('Историк И.И.')").run().lastInsertRowid;
    const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('История часов')").run().lastInsertRowid;
    // A semester entirely in the past, so every week has already elapsed.
    // The seeded working semester (start 2026-02-09) — the database allows
    // only one active semester, so fixtures reuse it rather than adding one.
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 6 WHERE id = ?').run(semesterId);
    const planId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, subgroup, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 0, 40)
    `).run(semesterId, teacherId, disciplineId, context.primaryGroupId).lastInsertRowid;

    const lesson = db.prepare('SELECT * FROM lessons WHERE group_id = ? AND specific_week IS NULL LIMIT 1').get(context.primaryGroupId);
    // No explicit link any more — a lesson counts toward the plan row the
    // moment its own identity matches, so the fixture sets that identity
    // directly on the lesson.
    db.prepare(`
        UPDATE lessons SET teacher_id = ?, discipline_id = ?, lesson_type = 'Лекция', subgroup = 0, template_from_week = 1
        WHERE id = ?
    `).run(teacherId, disciplineId, lesson.id);

    const hoursNow = () => {
        const response = db.prepare(`
            SELECT * FROM lessons WHERE teacher_id = ? AND discipline_id = ? AND lesson_type = 'Лекция' AND group_id = ? AND subgroup = 0
        `).all(teacherId, disciplineId, context.primaryGroupId);
        return computeLoadProgress({
            semesterStartDate: '2026-02-09',
            weeksCount: 6,
            linkedLessons: response,
            exceptionWeeks: new Set(),
            now: new Date('2026-12-31T00:00:00')
        }).occurred_hours;
    };

    const before = hoursNow();
    assert.ok(before > 0, 'fixture must produce some elapsed hours to begin with');

    const response = await fetch(`${context.baseUrl}/api/admin/lessons/${lesson.id}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.retired_from_week, 'a live template row must be retired, not hard-deleted');

    // The original row must still exist — that is what keeps past weeks intact.
    assert.ok(db.prepare('SELECT id FROM lessons WHERE id = ?').get(lesson.id), 'the original row must survive');
    assert.equal(hoursNow(), before, 'hours already taught must not change when a pair is removed going forward');

    // And the tombstone must carry the same identity, or the counter cannot see the slot stop.
    const tombstone = db.prepare(`
        SELECT * FROM lessons WHERE group_id = ? AND is_removed = 1 AND day_of_week = ? AND time_start = ?
    `).get(context.primaryGroupId, lesson.day_of_week, lesson.time_start);
    assert.ok(tombstone);
    assert.equal(tombstone.teacher_id, teacherId);
    assert.equal(tombstone.discipline_id, disciplineId);
    assert.ok(planId, 'plan row exists for the assertions above');

    await context.close();
});

test('a specific-week row marked removed stops counting hours, matching what the schedule shows', async () => {
    const linkedLessons = [
        { id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', week_type: 0, specific_week: 2, template_from_week: 1, is_removed: 0 }
    ];
    const args = {
        semesterStartDate: '2026-02-09',
        weeksCount: 4,
        exceptionWeeks: new Set([2]),
        now: new Date('2026-12-31T00:00:00')
    };

    assert.equal(computeLoadProgress({ ...args, linkedLessons }).occurred_hours, 2);

    const removed = [{ ...linkedLessons[0], is_removed: 1 }];
    assert.equal(
        computeLoadProgress({ ...args, linkedLessons: removed }).occurred_hours,
        0,
        'a row hidden from the schedule must not bill hours'
    );
});

test('the same teacher and discipline taught to a different group never feeds another group\'s plan row', async () => {
    const context = await createTestContext();
    const db = getDb();

    const otherGroupId = db.prepare('SELECT id FROM groups_ WHERE id != ? LIMIT 1').get(context.primaryGroupId)?.id
        ?? db.prepare("INSERT INTO groups_ (university_id, name) VALUES (1, 'Чужая')").run().lastInsertRowid;

    const teacherId = db.prepare("INSERT INTO teachers (full_name) VALUES ('Общий О.О.')").run().lastInsertRowid;
    const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Общая дисциплина')").run().lastInsertRowid;
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 4 WHERE id = ?').run(semesterId);

    // Same teacher, same discipline, same type — but one plan row per group,
    // as the department actually enters streams (one row per group).
    const planId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, subgroup, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 0, 10)
    `).run(semesterId, teacherId, disciplineId, context.primaryGroupId).lastInsertRowid;

    db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, subgroup, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 0, 10)
    `).run(semesterId, teacherId, disciplineId, otherGroupId);

    // A lesson for the OTHER group, with the exact same teacher/discipline/type.
    const lesson = db.prepare('SELECT id FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);
    db.prepare('UPDATE lessons SET teacher_id = ?, discipline_id = ?, lesson_type = ?, subgroup = 0, group_id = ?, template_from_week = 1 WHERE id = ?')
        .run(teacherId, disciplineId, 'Лекция', otherGroupId, lesson.id);

    const listResponse = await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semesterId}`, { headers: context.authHeaders });
    const list = await listResponse.json();

    assert.equal(list.find((row) => row.id === planId).progress.occurred_hours, 0, 'a pair taught to a different group must not count here');

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

test('move in template mode carries teacher_id/discipline_id onto the tombstone, so the hour counter sees the old slot stop and the new one start', async () => {
    const context = await createTestContext();
    const db = getDb();

    const original = db.prepare('SELECT * FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);

    const teacherId = db.prepare('INSERT INTO teachers (full_name) VALUES (?)').run('Тестов Т.Т.').lastInsertRowid;
    const disciplineId = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run('Тестовая дисциплина').lastInsertRowid;
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 18 WHERE id = ?').run(semesterId);
    const planId = db.prepare(`
        INSERT INTO load_plan (teacher_id, discipline_id, lesson_type, group_id, subgroup, semester_id, planned_hours)
        VALUES (?, ?, 'Лекция', ?, 0, ?, 36)
    `).run(teacherId, disciplineId, context.primaryGroupId, semesterId).lastInsertRowid;

    db.prepare('UPDATE lessons SET teacher_id = ?, discipline_id = ?, lesson_type = ?, subgroup = 0 WHERE id = ?')
        .run(teacherId, disciplineId, 'Лекция', original.id);

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

    // A tombstone written with no identity is invisible to the hour engine's
    // matching — the old slot would then count forever, even though the
    // schedule no longer shows it there.
    const tombstone = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ? AND is_removed = 1 AND day_of_week = ? AND time_start = ?
    `).get(context.primaryGroupId, original.day_of_week, original.time_start);
    assert.ok(tombstone, 'expected a tombstone at the old slot');
    assert.equal(tombstone.teacher_id, teacherId, 'tombstone must keep the identity so the counter can see the slot stopped');
    assert.equal(tombstone.discipline_id, disciplineId);

    const moved = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ? AND day_of_week = 3 AND time_start = '13:10' AND is_removed = 0
    `).get(context.primaryGroupId);
    assert.equal(moved.teacher_id, teacherId, 'the moved row must keep the same identity');
    assert.equal(moved.discipline_id, disciplineId);
    assert.ok(planId, 'plan row exists for context');

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

test('teachers and disciplines: rename fixes a typo, delete is blocked while a load_plan row still references them', async () => {
    const context = await createTestContext();
    const db = getDb();

    const teacherId = (await (await fetch(`${context.baseUrl}/api/admin/teachers`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Мустфин А.Р.' }) // typo: missing "а"
    })).json()).id;

    const disciplineId = (await (await fetch(`${context.baseUrl}/api/admin/disciplines`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Матанализ' })
    })).json()).id;

    // Renaming fixes the typo without touching anything that references it.
    const renameResponse = await fetch(`${context.baseUrl}/api/admin/teachers/${teacherId}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Мустафин А.Р.' })
    });
    assert.equal(renameResponse.status, 200);
    assert.equal((await renameResponse.json()).full_name, 'Мустафин А.Р.');

    const renameDisciplineResponse = await fetch(`${context.baseUrl}/api/admin/disciplines/${disciplineId}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Математический анализ' })
    });
    assert.equal(renameDisciplineResponse.status, 200);
    assert.equal((await renameDisciplineResponse.json()).name, 'Математический анализ');

    // No load_plan rows reference either yet — both can be deleted cleanly.
    const deleteTeacherClean = await fetch(`${context.baseUrl}/api/admin/teachers/${teacherId}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(deleteTeacherClean.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM teachers WHERE id = ?').get(teacherId).c, 0);

    // Recreate the teacher, then link it into a load_plan row and confirm
    // deletion is now refused (would otherwise silently cascade-delete it).
    const teacher2Id = (await (await fetch(`${context.baseUrl}/api/admin/teachers`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: 'Второй В.В.' })
    })).json()).id;

    // The seeded working semester (start 2026-02-09) — the database allows
    // only one active semester, so fixtures reuse it rather than adding one.
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 4 WHERE id = ?').run(semesterId);
    db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 10)
    `).run(semesterId, teacher2Id, disciplineId, context.primaryGroupId);

    const blockedTeacherDelete = await fetch(`${context.baseUrl}/api/admin/teachers/${teacher2Id}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(blockedTeacherDelete.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM teachers WHERE id = ?').get(teacher2Id).c, 1, 'teacher must survive the refused delete');

    const blockedDisciplineDelete = await fetch(`${context.baseUrl}/api/admin/disciplines/${disciplineId}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(blockedDisciplineDelete.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM disciplines WHERE id = ?').get(disciplineId).c, 1, 'discipline must survive the refused delete');

    await context.close();
});

test('unmatched pairs: the schedule shows them, no plan row claims their hours', async () => {
    const context = await createTestContext();
    const db = getDb();
    db.exec('DELETE FROM lessons');

    const teacherId = db.prepare("INSERT INTO teachers (full_name) VALUES ('Несовпадов Н.Н.')").run().lastInsertRowid;
    const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Дисциплина без плана')").run().lastInsertRowid;
    db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, subgroup, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 0, 40)
    `).run(context.semesterId, teacherId, disciplineId, context.primaryGroupId);

    const insert = db.prepare(`
        INSERT INTO lessons (
            group_id, semester_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
            time_start, time_end, subject, lesson_type, teacher, teacher_id, discipline_id, kind
        )
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const lesson = (overrides) => {
        const row = {
            subgroup: 0, day_of_week: 1, specific_week: null, template_from_week: 1, is_removed: 0,
            time_start: '08:00', time_end: '09:30', subject: 'Дисциплина без плана', lesson_type: 'Лекция',
            teacher: 'Несовпадов Н.Н.', teacher_id: teacherId, discipline_id: disciplineId, kind: 'lesson',
            ...overrides
        };
        return insert.run(
            context.primaryGroupId, context.semesterId, row.subgroup, row.day_of_week, row.specific_week,
            row.template_from_week, row.is_removed, row.time_start, row.time_end, row.subject,
            row.lesson_type, row.teacher, row.teacher_id, row.discipline_id, row.kind
        ).lastInsertRowid;
    };

    lesson({ day_of_week: 1 });                                            // matches the plan row
    lesson({ day_of_week: 2, lesson_type: 'Практика' });                   // one field off: hours go nowhere
    lesson({ day_of_week: 3, teacher_id: null, discipline_id: null, teacher: 'Гость Г.Г.', subject: 'Разовая пара' });
    lesson({ day_of_week: 4, kind: 'event', subject: 'Линейка', lesson_type: null, teacher_id: null, discipline_id: null });
    lesson({ day_of_week: 5, lesson_type: 'Зачёт', specific_week: 3, is_removed: 1 }); // a week's own removal marker: nobody's hours
    // An old template version, replaced later by one that does match: the
    // retired row is not a problem, only what the schedule shows now is.
    lesson({ day_of_week: 6, lesson_type: 'Консультация', template_from_week: 1 });
    lesson({ day_of_week: 6, template_from_week: 2 });

    const response = await fetch(`${context.baseUrl}/api/admin/load-plan/unmatched?semester_id=${context.semesterId}`, { headers: context.authHeaders });
    const body = await response.json();
    assert.equal(response.status, 200);

    const listed = body.items.map((item) => `${item.reason}:${item.subject}:${item.lesson_type}`).sort();
    assert.deepEqual(listed, [
        'no_plan_row:Дисциплина без плана:Практика',
        'not_in_dictionary:Разовая пара:Лекция'
    ]);
    assert.equal(body.items.find((item) => item.reason === 'no_plan_row').lessons_count, 1);
    assert.equal(body.items.find((item) => item.reason === 'no_plan_row').group_name, '23113');

    // Give the stray pair a plan row of its own and it stops being listed.
    db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, subgroup, planned_hours)
        VALUES (?, ?, ?, 'Практика', ?, 0, 20)
    `).run(context.semesterId, teacherId, disciplineId, context.primaryGroupId);

    const after = await (await fetch(`${context.baseUrl}/api/admin/load-plan/unmatched?semester_id=${context.semesterId}`, { headers: context.authHeaders })).json();
    assert.deepEqual(after.items.map((item) => item.reason), ['not_in_dictionary']);

    await context.close();
});

test('a room holding the whole imported cell gets its real room back from the source sheet, or is cleared; real rooms are kept', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-rooms-'));
    process.env.DB_PATH = path.join(tempDir, 'schedule.db');

    closeDb();
    let db = getDb();
    db.exec('DELETE FROM lessons');
    const universityId = db.prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)').run('U', 'U').lastInsertRowid;
    const groupId = db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)').run(universityId, 'G').lastInsertRowid;
    const insert = db.prepare(`
        INSERT INTO lessons (group_id, day_of_week, time_start, time_end, subject, room)
        VALUES (?, 1, '08:00', '09:30', ?, ?)
    `);
    const garbage = insert.run(groupId, 'Физика', 'Физика (лек.) Акст Е.Р.').lastInsertRowid;
    const knownGroupId = db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)').run(universityId, '23203').lastInsertRowid;
    const recoverable = db.prepare(`
        INSERT INTO lessons (group_id, day_of_week, time_start, time_end, subject, room)
        VALUES (?, 4, '13:10', '14:40', 'Физика', 'Физика (лек.) Акст Е.Р.')
    `).run(knownGroupId).lastInsertRowid;
    const realRoom = insert.run(groupId, 'Физика', '206').lastInsertRowid;
    const namedPlace = insert.run(groupId, 'Физическая культура', 'с/з').lastInsertRowid;
    const otherSubjectsText = insert.run(groupId, 'Химия', 'Физика (лек.) Акст Е.Р.').lastInsertRowid;
    closeDb();

    db = getDb(); // reopening re-runs the migrations
    const roomOf = (id) => db.prepare('SELECT room FROM lessons WHERE id = ?').get(id).room;
    assert.equal(roomOf(garbage), null, 'no known room for this one: cleared');
    assert.equal(roomOf(recoverable), '104', 'a joint lecture gets the room from after the merged cell');
    assert.equal(roomOf(realRoom), '206');
    assert.equal(roomOf(namedPlace), 'с/з');
    assert.equal(roomOf(otherSubjectsText), 'Физика (лек.) Акст Е.Р.', 'only a room echoing the row\'s own subject is touched');

    closeDb();
    delete process.env.DB_PATH;
    await fs.rm(tempDir, { recursive: true, force: true });
});

test('a legacy load_plan table (planned_hours NOT NULL CHECK > 0) is migrated to allow NULL, without losing existing rows', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-legacy-load-plan-'));
    process.env.DB_PATH = path.join(tempDir, 'schedule.db');

    closeDb();
    let db = getDb(); // creates the current (already-migrated) schema

    // Roll load_plan back to the old shape, as if this were a database from
    // before planned_hours became nullable, then seed one real row into it —
    // this is exactly the shape every existing production database is in.
    db.exec(`
        DROP TABLE load_plan;
        CREATE TABLE load_plan (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id   INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
            teacher_id    INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
            discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
            lesson_type   TEXT NOT NULL,
            group_id      INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup      INTEGER NOT NULL DEFAULT 0,
            planned_hours INTEGER NOT NULL CHECK(planned_hours > 0),
            entered_by    TEXT NOT NULL DEFAULT 'specialist' CHECK(entered_by IN ('specialist', 'teacher')),
            confirmed     INTEGER NOT NULL DEFAULT 0,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const universityId = db.prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)').run('U', 'U').lastInsertRowid;
    const groupId = db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)').run(universityId, 'G').lastInsertRowid;
    const teacherId = db.prepare('INSERT INTO teachers (full_name) VALUES (?)').run('Легаси Л.Л.').lastInsertRowid;
    const disciplineId = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run('Легаси-дисциплина').lastInsertRowid;
    const semesterId = db.prepare('INSERT INTO semesters (label, start_date, weeks_count) VALUES (?, ?, ?)').run('Л', '2026-02-09', 18).lastInsertRowid;

    const existingRowId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 24)
    `).run(semesterId, teacherId, disciplineId, groupId).lastInsertRowid;

    // Confirm the old constraint really is in force before migrating past it.
    assert.throws(() => {
        db.prepare(`
            INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours)
            VALUES (?, ?, ?, 'Лаб', ?, NULL)
        `).run(semesterId, teacherId, disciplineId, groupId);
    });

    closeDb();

    // Reopening the same file re-runs the schema setup, including the migration.
    db = getDb();

    const survived = db.prepare('SELECT * FROM load_plan WHERE id = ?').get(existingRowId);
    assert.ok(survived, 'the pre-existing row must survive the table rebuild');
    assert.equal(survived.planned_hours, 24);
    assert.equal(survived.teacher_id, teacherId);

    const nullHoursId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours)
        VALUES (?, ?, ?, 'Лаб', ?, NULL)
    `).run(semesterId, teacherId, disciplineId, groupId).lastInsertRowid;

    assert.ok(nullHoursId, 'a plan row with unset hours must now be insertable');

    closeDb();
    delete process.env.DB_PATH;
    await fs.rm(tempDir, { recursive: true, force: true });
});

test('rebuilding load_plan does not leave lessons.load_plan_id pointing at a dropped legacy table', async () => {
    // Regression test for a real corruption caught while migrating production
    // data: load_plan is the FK TARGET of lessons.load_plan_id on any database
    // that already has load tracking installed. Renaming load_plan out of the
    // way to rebuild it (load_plan -> load_plan_legacy -> drop) makes SQLite
    // silently rewrite lessons' stored schema to reference "load_plan_legacy"
    // — which then no longer exists, so every later write touching
    // lessons.load_plan_id fails with "no such table: main.load_plan_legacy".
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-load-plan-fk-'));
    process.env.DB_PATH = path.join(tempDir, 'schedule.db');

    closeDb();
    let db = getDb(); // creates the current (already-migrated) schema, including lessons.load_plan_id

    // Roll load_plan back to the pre-nullable shape — this is the state every
    // database that had load tracking before this fix is actually in.
    db.exec(`
        DROP TABLE load_plan;
        CREATE TABLE load_plan (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id   INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
            teacher_id    INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
            discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
            lesson_type   TEXT NOT NULL,
            group_id      INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup      INTEGER NOT NULL DEFAULT 0,
            planned_hours INTEGER NOT NULL CHECK(planned_hours > 0),
            entered_by    TEXT NOT NULL DEFAULT 'specialist' CHECK(entered_by IN ('specialist', 'teacher')),
            confirmed     INTEGER NOT NULL DEFAULT 0,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const universityId = db.prepare('INSERT INTO universities (name, short_name) VALUES (?, ?)').run('U', 'U').lastInsertRowid;
    const groupId = db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)').run(universityId, 'G').lastInsertRowid;
    const teacherId = db.prepare('INSERT INTO teachers (full_name) VALUES (?)').run('Регресс Р.Р.').lastInsertRowid;
    const disciplineId = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run('Регресс-дисциплина').lastInsertRowid;
    const semesterId = db.prepare('INSERT INTO semesters (label, start_date, weeks_count) VALUES (?, ?, ?)').run('Р', '2026-02-09', 18).lastInsertRowid;

    const planId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 20)
    `).run(semesterId, teacherId, disciplineId, groupId).lastInsertRowid;

    const lessonId = db.prepare(`
        INSERT INTO lessons (group_id, day_of_week, time_start, time_end, subject, load_plan_id)
        VALUES (?, 1, '09:00', '10:30', 'Регресс-дисциплина', ?)
    `).run(groupId, planId).lastInsertRowid;

    closeDb();

    // Reopening re-runs the schema setup: the planned_hours migration, then
    // (this test's actual subject) the FK repair it would otherwise need.
    db = getDb();

    const lessonsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lessons'").get().sql;
    assert.ok(
        !/load_plan_legacy/i.test(lessonsSql),
        `lessons must not reference a dropped legacy table:\n${lessonsSql}`
    );
    assert.match(lessonsSql, /REFERENCES\s+load_plan\s*\(/i);

    // The existing link must have survived the whole rebuild intact.
    const survivedLesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
    assert.equal(survivedLesson.load_plan_id, planId);

    // The bug surfaced as a crash on the FIRST write that touched
    // lessons.load_plan_id after the corruption — e.g. a cascading delete
    // from groups_. This must now succeed cleanly.
    assert.doesNotThrow(() => {
        db.prepare('DELETE FROM groups_ WHERE id = ?').run(groupId);
    });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lessons WHERE id = ?').get(lessonId).c, 0);

    closeDb();
    delete process.env.DB_PATH;
    await fs.rm(tempDir, { recursive: true, force: true });
});

test('the schedule\'s semester start and the load semester\'s start move together, from either side', async () => {
    const context = await createTestContext();
    const db = getDb();

    // The seeded working semester (start 2026-02-09) — the database allows
    // only one active semester, so fixtures reuse it rather than adding one.
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 18 WHERE id = ?').run(semesterId);

    const settingsDate = () => db.prepare("SELECT value v FROM settings WHERE key = 'semester_start_date'").get()?.v;
    const semesterDate = () => db.prepare('SELECT start_date FROM semesters WHERE id = ?').get(semesterId).start_date;

    // Changing it through Settings must move the active semester too.
    const viaSettings = await fetch(`${context.baseUrl}/api/admin/settings`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ semester_start_date: '2026-09-07' })
    });
    assert.equal(viaSettings.status, 200);
    assert.equal(settingsDate(), '2026-09-07');
    assert.equal(semesterDate(), '2026-09-07', 'the load semester must follow the schedule setting');

    // And changing it through the semester must move the setting.
    const viaSemester = await fetch(`${context.baseUrl}/api/admin/semesters/${semesterId}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_date: '2026-08-31' })
    });
    assert.equal(viaSemester.status, 200);
    assert.equal(semesterDate(), '2026-08-31');
    assert.equal(settingsDate(), '2026-08-31', 'the schedule setting must follow the load semester');

    await context.close();
});

test('the impact preview reports how many teachers a semester date/length change would move, without writing anything', async () => {
    const context = await createTestContext();
    const db = getDb();

    const teacherId = db.prepare("INSERT INTO teachers (full_name) VALUES ('Затронутый З.З.')").run().lastInsertRowid;
    const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Предмет')").run().lastInsertRowid;
    // The seeded working semester (start 2026-02-09) — the database allows
    // only one active semester, so fixtures reuse it rather than adding one.
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 8 WHERE id = ?').run(semesterId);
    const planId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, subgroup, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 0, 40)
    `).run(semesterId, teacherId, disciplineId, context.primaryGroupId).lastInsertRowid;

    const lesson = db.prepare('SELECT id FROM lessons WHERE group_id = ? AND specific_week IS NULL LIMIT 1').get(context.primaryGroupId);
    db.prepare(`
        UPDATE lessons SET teacher_id = ?, discipline_id = ?, lesson_type = 'Лекция', subgroup = 0, template_from_week = 1
        WHERE id = ?
    `).run(teacherId, disciplineId, lesson.id);

    const response = await fetch(
        `${context.baseUrl}/api/admin/semesters/${semesterId}/impact?weeks_count=4`,
        { headers: context.authHeaders }
    );
    assert.equal(response.status, 200);
    const impact = await response.json();

    assert.equal(impact.current.weeks_count, 8);
    assert.equal(impact.proposed.weeks_count, 4);
    assert.ok(impact.hours_after < impact.hours_before, 'halving the semester must reduce the counted hours');
    assert.equal(impact.teachers_changed, 1);
    assert.deepEqual(impact.teacher_names, ['Затронутый З.З.']);

    // A preview must not have changed the semester it previewed.
    const untouched = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);
    assert.equal(untouched.weeks_count, 8);
    assert.equal(untouched.start_date, '2026-02-09');

    await context.close();
});

test('a group that still holds lessons or plan rows cannot be deleted out from under them', async () => {
    const context = await createTestContext();
    const db = getDb();

    // The seeded group has lessons — deleting it would cascade them away.
    const blocked = await fetch(`${context.baseUrl}/api/admin/groups/${context.primaryGroupId}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(blocked.status, 409);
    assert.ok(db.prepare('SELECT id FROM groups_ WHERE id = ?').get(context.primaryGroupId), 'the group must survive');
    assert.ok(
        db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ?').get(context.primaryGroupId).c > 0,
        'its lessons must survive too'
    );

    // An empty group deletes cleanly.
    const universityId = db.prepare('SELECT university_id FROM groups_ WHERE id = ?').get(context.primaryGroupId).university_id;
    const emptyGroupId = db.prepare('INSERT INTO groups_ (university_id, name) VALUES (?, ?)').run(universityId, 'Пустая').lastInsertRowid;
    const allowed = await fetch(`${context.baseUrl}/api/admin/groups/${emptyGroupId}`, {
        method: 'DELETE', headers: context.authHeaders
    });
    assert.equal(allowed.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM groups_ WHERE id = ?').get(emptyGroupId).c, 0);

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
    // The plan must live in the same semester as the lesson it counts — the
    // seeded working semester, shortened to 4 weeks for an exact total.
    const semester = { id: context.semesterId };
    await fetch(`${context.baseUrl}/api/admin/semesters/${semester.id}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ weeks_count: 4 })
    });

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
    // No lesson matches this identity yet — zero hours so far.
    assert.equal(plan.progress.occurred_hours, 0);

    // "Select this teacher/discipline from the dropdown" for the group's
    // existing Monday template lesson (seeded by seedTestDatabase, week_type
    // odd) — there is no separate link step any more, the lesson's own
    // identity is what makes it count. Written directly (as the dropdown
    // would leave it), rather than through the versioned POST .../lessons,
    // which takes effect only from the real current week forward and would
    // miss this semester's already-elapsed weeks 1 and 3.
    const lessonRow = db.prepare('SELECT * FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);
    db.prepare('UPDATE lessons SET teacher_id = ?, discipline_id = ?, lesson_type = ? WHERE id = ?')
        .run(teacherId, disciplineId, 'Лаб', lessonRow.id);

    const listResponse = await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semester.id}`, {
        headers: context.authHeaders
    });
    const list = await listResponse.json();
    const updatedPlan = list.find((p) => p.id === plan.id);

    // week_type=1 (odd) over 4 weeks => weeks 1 and 3 => 2 occurrences x 2h.
    assert.equal(updatedPlan.progress.occurred_count, 2);
    assert.equal(updatedPlan.progress.occurred_hours, 4);
    assert.equal(updatedPlan.progress.remaining_hours, 4);

    // Picking a different discipline for that same pair brings it back to
    // zero — the old plan row simply stops matching.
    const otherDisciplineId = (await (await fetch(`${context.baseUrl}/api/admin/disciplines`, {
        method: 'POST',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Другая дисциплина' })
    })).json()).id;
    db.prepare('UPDATE lessons SET discipline_id = ? WHERE id = ?').run(otherDisciplineId, lessonRow.id);
    const afterUnlink = await (await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semester.id}`, {
        headers: context.authHeaders
    })).json();
    assert.equal(afterUnlink.find((p) => p.id === plan.id).progress.occurred_hours, 0);

    await context.close();
});

test('load plan full-row edit: fixing a wrongly entered teacher/discipline/type/group, and moving a plan row between groups just re-targets who its hours match', async () => {
    const context = await createTestContext();
    const db = getDb();

    const wrongTeacherId = db.prepare("INSERT INTO teachers (full_name) VALUES ('Неверный Н.Н.')").run().lastInsertRowid;
    const rightTeacherId = db.prepare("INSERT INTO teachers (full_name) VALUES ('Верный В.В.')").run().lastInsertRowid;
    const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Тестовая дисциплина')").run().lastInsertRowid;
    const otherGroupId = db.prepare('SELECT id FROM groups_ WHERE id != ? LIMIT 1').get(context.primaryGroupId)?.id
        ?? db.prepare("INSERT INTO groups_ (university_id, name) VALUES (1, 'ДругаяГруппа')").run().lastInsertRowid;
    const semesterId = context.semesterId;
    db.prepare('UPDATE semesters SET weeks_count = 4 WHERE id = ?').run(semesterId);

    const planId = db.prepare(`
        INSERT INTO load_plan (semester_id, teacher_id, discipline_id, lesson_type, group_id, planned_hours)
        VALUES (?, ?, ?, 'Лекция', ?, 10)
    `).run(semesterId, wrongTeacherId, disciplineId, context.primaryGroupId).lastInsertRowid;

    // Fix the teacher and hours in one edit — this is the "I typed it wrong,
    // let me correct it" path, distinct from delete-and-recreate.
    const editResponse = await fetch(`${context.baseUrl}/api/admin/load-plan/${planId}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher_id: rightTeacherId, lesson_type: 'Практика', planned_hours: 20 })
    });
    assert.equal(editResponse.status, 200);
    const edited = await editResponse.json();
    assert.equal(edited.teacher_id, rightTeacherId);
    assert.equal(edited.teacher_name, 'Верный В.В.');
    assert.equal(edited.lesson_type, 'Практика');
    assert.equal(edited.planned_hours, 20);

    // A pair matching this row's identity, in the original group.
    const lessonRow = db.prepare('SELECT id FROM lessons WHERE group_id = ? LIMIT 1').get(context.primaryGroupId);
    db.prepare(`
        UPDATE lessons SET teacher_id = ?, discipline_id = ?, lesson_type = 'Практика', subgroup = 0, template_from_week = 1
        WHERE id = ?
    `).run(rightTeacherId, disciplineId, lessonRow.id);
    const beforeMove = await (await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semesterId}`, { headers: context.authHeaders })).json();
    assert.ok(beforeMove.find((row) => row.id === planId).progress.occurred_hours > 0, 'the pair must count before the move');

    // There is no explicit link to detach any more — moving the plan row to
    // a different group is just a write. It no longer matches the pair
    // still sitting in the original group.
    const groupChange = await fetch(`${context.baseUrl}/api/admin/load-plan/${planId}`, {
        method: 'PUT',
        headers: { ...context.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: otherGroupId })
    });
    assert.equal(groupChange.status, 200);
    assert.equal((await groupChange.json()).group_id, otherGroupId);

    const afterMove = await (await fetch(`${context.baseUrl}/api/admin/load-plan?semester_id=${semesterId}`, { headers: context.authHeaders })).json();
    assert.equal(afterMove.find((row) => row.id === planId).progress.occurred_hours, 0, 'the pair stayed in the old group and no longer matches');

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
    // The seeded working semester, renamed and shortened for this scenario.
    db.prepare("UPDATE semesters SET label = 'Осень 2026-2027', weeks_count = 4 WHERE id = ?").run(context.semesterId);
    const semester = { lastInsertRowid: context.semesterId };
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

test('load plan refuses the same teacher/discipline/type/group twice in a semester, on create and on edit', async () => {
    const context = await createTestContext();
    const post = (url, body) => fetch(`${context.baseUrl}${url}`, {
        method: 'POST', headers: { ...context.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const teacherId = (await (await post('/api/admin/teachers', { full_name: 'Петров П.П.' })).json()).id;
    const disciplineId = (await (await post('/api/admin/disciplines', { name: 'Химия' })).json()).id;
    const row = { semester_id: context.semesterId, teacher_id: teacherId, discipline_id: disciplineId, lesson_type: 'Лаб', group_id: context.primaryGroupId, planned_hours: 16 };

    assert.equal((await post('/api/admin/load-plan', row)).status, 201);
    const again = await post('/api/admin/load-plan', row);
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /уже есть/);

    // Another type is a different row; turning it into a duplicate by editing is refused too.
    const practice = await (await post('/api/admin/load-plan', { ...row, lesson_type: 'Практика' })).json();
    const edit = await fetch(`${context.baseUrl}/api/admin/load-plan/${practice.id}`, {
        method: 'PUT', headers: { ...context.authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ lesson_type: 'Лаб' })
    });
    assert.equal(edit.status, 409);

    await context.close();
});

test('a crash in the browser is reported to the server instead of vanishing', async () => {
    const context = await createTestContext();

    const response = await fetch(`${context.baseUrl}/api/client-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Cannot read properties of undefined', path: '/schedule', stack: 'at buildScheduleDays' })
    });

    assert.equal(response.status, 204);

    await context.close();
});

/**
 * Fires many requests in small batches. All at once exhausts the local socket
 * pool on Windows and fails with ECONNREFUSED long before any rate limit is
 * reached — which says nothing about the limiter.
 */
async function fireRequests(total, send, batchSize = 40) {
    const statuses = [];

    for (let sent = 0; sent < total; sent += batchSize) {
        const batch = Array.from({ length: Math.min(batchSize, total - sent) }, send);
        statuses.push(...(await Promise.all(batch)).map((response) => response.status));
    }

    return statuses;
}

async function createTestContext() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anti-vuz-test-'));
    process.env.DB_PATH = path.join(tempDir, 'schedule.db');

    closeDb();
    seedTestDatabase();

    const serverContext = await startTestServer();

    return {
        ...serverContext,
        primaryGroupId: getPrimaryGroupId(),
        semesterId: getDb().prepare('SELECT id FROM semesters WHERE is_active = 1').get().id,
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
        DELETE FROM load_plan;
        DELETE FROM semesters;
        DELETE FROM admins;
        DELETE FROM groups_;
        DELETE FROM universities;
        DELETE FROM settings;
    `);

    // One working semester, starting on the date every test's week arithmetic
    // assumes. Lessons inserted below (and by tests via raw SQL) land in it.
    // 2026-02-09 is ISO week 7, so week 1 is нечётная — week N parity equals
    // N's own parity, the rule these fixtures were originally written against.
    db.prepare(`
        INSERT INTO semesters (label, start_date, weeks_count, is_active, first_week_parity)
        VALUES ('Тестовый семестр', '2026-02-09', 18, 1, 1)
    `).run();

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
