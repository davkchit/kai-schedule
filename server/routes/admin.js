const express = require('express');
const bcrypt = require('bcryptjs');
const { writeAuditLog } = require('../audit');
const {
    createDatabaseBackup,
    getBackupDownloadPath,
    listDatabaseBackups
} = require('../backups');
const { getDb } = require('../db');
const { buildScheduleWorkbook } = require('../exportSchedule');
const { buildLoadWorkbook } = require('../exportLoad');
const {
    clearAdminAuthCookie,
    createToken,
    requireAuth,
    setAdminAuthCookie
} = require('../middleware/auth');
const { ensureCsrfToken, requireCsrf } = require('../middleware/csrf');
const {
    clearFailedLoginAttempts,
    getRateLimitInfo,
    registerFailedLogin
} = require('../login-rate-limit');
const {
    addDaysToIsoDate,
    formatLocalDate,
    getWeekMeta,
    getWeekTypeForWeekNumber,
    isValidIsoDate
} = require('../utils/date');
const { getCourseFromGroupName, getSemesterLabel } = require('../utils/course');
const { resolveTemplateLessons } = require('../utils/templateResolve');
const { findTemplateSlotOccupant, findWeekSlotOccupant } = require('../utils/slots');
const { computeExceptionWeeks, computeLoadProgress } = require('../utils/loadCalc');
const {
    validateAccountUpdateBody,
    validateBulkScheduleUploadBody,
    validateDisciplineCreateBody,
    validateGroupCreateBody,
    validateGroupUpdateBody,
    validateLessonCreateBody,
    validateLessonLoadPlanLinkBody,
    validateLessonUpdateBody,
    validateLoadPlanCreateBody,
    validateLoadPlanUpdateBody,
    validateLoginBody,
    validateMaterializeWeekBody,
    validateMoveLessonBody,
    validateScheduleUploadBody,
    validateSemesterCreateBody,
    validateSemesterUpdateBody,
    validateSettingsBody,
    validateTeacherCreateBody
} = require('../validation');

const router = express.Router();

router.post('/login', (req, res) => {
    let credentials;

    try {
        credentials = validateLoginBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const clientKey = getClientAddress(req);
    const rateLimitInfo = getRateLimitInfo(clientKey);

    if (rateLimitInfo.isBlocked) {
        return res.status(429).json({
            error: 'Слишком много попыток входа. Попробуйте позже.',
            retry_after_sec: Math.ceil(rateLimitInfo.retryAfterMs / 1000)
        });
    }

    const db = getDb();
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(credentials.username);

    if (!admin || !bcrypt.compareSync(credentials.password, admin.password_hash)) {
        registerFailedLogin(clientKey);
        return res.status(401).json({ error: 'Неправильный логин или пароль' });
    }

    clearFailedLoginAttempts(clientKey);

    const token = createToken(admin);
    setAdminAuthCookie(res, token);
    writeAuditLog(db, {
        adminId: admin.id,
        action: 'login.success',
        entityType: 'admin_session',
        entityId: admin.id,
        ipAddress: clientKey,
        details: {
            username: admin.username
        }
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, username: admin.username });
});

router.post('/logout', requireAuth, requireCsrf, (req, res) => {
    clearAdminAuthCookie(res);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true });
});

router.get('/session', requireAuth, (req, res) => {
    const csrfToken = ensureCsrfToken(req, res);
    res.set('Cache-Control', 'no-store');
    res.json({ authenticated: true, admin: req.admin, csrf_token: csrfToken });
});

router.use(requireAuth);
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(requireCsrf);

router.put('/account', (req, res) => {
    let payload;

    try {
        payload = validateAccountUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);

    if (!admin || !bcrypt.compareSync(payload.current_password, admin.password_hash)) {
        return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    if (payload.new_username && payload.new_username !== admin.username) {
        const usernameTaken = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?')
            .get(payload.new_username, admin.id);

        if (usernameTaken) {
            return res.status(409).json({ error: 'Этот логин уже занят' });
        }
    }

    const nextUsername = payload.new_username || admin.username;
    const nextPasswordHash = payload.new_password
        ? bcrypt.hashSync(payload.new_password, 10)
        : admin.password_hash;

    db.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?')
        .run(nextUsername, nextPasswordHash, admin.id);

    writeAuditLog(db, {
        adminId: admin.id,
        action: 'admin.update_credentials',
        entityType: 'admin_account',
        entityId: admin.id,
        ipAddress: getClientAddress(req),
        details: {
            username_changed: Boolean(payload.new_username && payload.new_username !== admin.username),
            password_changed: Boolean(payload.new_password)
        }
    });

    // Refresh the session so the cookie reflects the new username immediately —
    // otherwise the current browser session would keep showing the old one
    // until the next login.
    const token = createToken({ id: admin.id, username: nextUsername });
    setAdminAuthCookie(res, token);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, username: nextUsername });
});

router.get('/groups', (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
        SELECT g.id, g.name, g.direction, u.short_name as university
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        ORDER BY u.short_name, g.name
    `).all();

    res.json(rows);
});

router.post('/groups', (req, res) => {
    let payload;

    try {
        payload = validateGroupCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const university = db.prepare('SELECT id FROM universities WHERE id = ?').get(payload.university_id);

    if (!university) {
        return res.status(404).json({ error: 'Университет не найден' });
    }

    const existing = db.prepare('SELECT id FROM groups_ WHERE university_id = ? AND name = ?')
        .get(payload.university_id, payload.name);

    if (existing) {
        return res.status(409).json({ error: `Группа «${payload.name}» уже существует в этом вузе` });
    }

    const result = db.prepare('INSERT INTO groups_ (university_id, name, direction) VALUES (?, ?, ?)')
        .run(payload.university_id, payload.name, payload.direction);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.create',
        entityType: 'group',
        entityId: result.lastInsertRowid,
        ipAddress: getClientAddress(req),
        details: { name: payload.name, university_id: payload.university_id }
    });

    const created = db.prepare(`
        SELECT g.id, g.name, g.direction, u.short_name as university
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        WHERE g.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(created);
});

router.put('/groups/:id', (req, res) => {
    const db = getDb();
    const groupId = Number(req.params.id);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID группы' });
    }

    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    let payload;

    try {
        payload = validateGroupUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    db.prepare('UPDATE groups_ SET direction = ? WHERE id = ?').run(payload.direction, groupId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.update',
        entityType: 'group',
        entityId: groupId,
        ipAddress: getClientAddress(req),
        details: { direction: payload.direction }
    });

    const updated = db.prepare(`
        SELECT g.id, g.name, g.direction, u.short_name as university
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        WHERE g.id = ?
    `).get(groupId);

    res.json(updated);
});

/**
 * Refuses while the group still holds anything. Both foreign keys pointing at
 * groups_ cascade, so an unguarded delete would take the group's whole
 * timetable AND every load_plan row built on it — including hours already
 * counted — with no way back short of a backup. Clear the group first and the
 * delete becomes the harmless thing it looks like.
 */
router.delete('/groups/:id', (req, res) => {
    const groupId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID группы' });
    }

    const db = getDb();
    const group = db.prepare('SELECT id, name FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    const lessonCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ?').get(groupId).c;
    const planCount = db.prepare('SELECT COUNT(*) c FROM load_plan WHERE group_id = ?').get(groupId).c;

    if (lessonCount > 0 || planCount > 0) {
        const parts = [];
        if (lessonCount > 0) parts.push(`пар в расписании: ${lessonCount}`);
        if (planCount > 0) parts.push(`строк в плане нагрузки: ${planCount}`);

        return res.status(409).json({
            error: `Группу «${group.name}» нельзя удалить — ${parts.join(', ')}. Сначала очистите её, иначе вместе с группой пропадут и эти записи.`
        });
    }

    db.prepare('DELETE FROM groups_ WHERE id = ?').run(groupId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.delete',
        entityType: 'group',
        entityId: groupId,
        ipAddress: getClientAddress(req),
        details: { name: group.name }
    });

    res.json({ success: true, deleted: groupId });
});

router.post('/schedule/upload', (req, res) => {
    let payload;

    try {
        payload = validateScheduleUploadBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const { university, group, lessons, target_week: targetWeek, reference_date: referenceDate } = payload;
    const db = getDb();

    let groupRow;

    if (university) {
        groupRow = db.prepare(`
            SELECT g.id, u.short_name AS university_short_name FROM groups_ g
            JOIN universities u ON u.id = g.university_id
            WHERE u.short_name = ? AND g.name = ?
        `).get(university, group);
    } else {
        const groupCandidates = db.prepare(`
            SELECT g.id, u.short_name AS university_short_name
            FROM groups_ g
            JOIN universities u ON u.id = g.university_id
            WHERE g.name = ?
            ORDER BY u.short_name, g.id
        `).all(group);

        if (groupCandidates.length > 1) {
            return res.status(409).json({
                error: `Группа "${group}" найдена в нескольких вузах. Укажите поле university в JSON.`
            });
        }

        groupRow = groupCandidates[0];
    }

    if (!groupRow) {
        return res.status(404).json({ error: `Группа "${group}" не найдена` });
    }

    const weekTypeMap = { all: 0, odd: 1, even: 2 };
    let specificWeek = null;

    if (targetWeek === 'current') {
        const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
        const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
        specificWeek = getWeekMeta(semesterStart, referenceDate || formatLocalDate()).weekNumber;
    } else if (typeof targetWeek === 'number') {
        specificWeek = targetWeek;
    }

    const transaction = db.transaction(() => {
        if (specificWeek === null) {
            db.prepare('DELETE FROM lessons WHERE group_id = ? AND specific_week IS NULL').run(groupRow.id);
        } else {
            db.prepare('DELETE FROM lessons WHERE group_id = ? AND specific_week = ?').run(groupRow.id, specificWeek);
        }

        const insert = db.prepare(`
            INSERT INTO lessons (
                group_id, subgroup, day_of_week, week_type, specific_week,
                time_start, time_end, subject, room, lesson_type, teacher, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let count = 0;

        for (const lesson of lessons) {
            insert.run(
                groupRow.id,
                lesson.subgroup,
                lesson.day,
                weekTypeMap[lesson.week_type],
                specificWeek,
                lesson.time_start,
                lesson.time_end,
                lesson.subject,
                lesson.room,
                lesson.type,
                lesson.teacher,
                lesson.sort_order ?? count
            );

            count += 1;
        }

        return count;
    });

    try {
        const imported = transaction();
        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'schedule.upload',
            entityType: 'group_schedule',
            entityId: groupRow.id,
            ipAddress: getClientAddress(req),
            details: {
                group,
                university: groupRow.university_short_name || university || null,
                imported,
                lesson_count: lessons.length,
                target_week: targetWeek,
                specific_week: specificWeek
            }
        });
        res.json({
            success: true,
            imported,
            group,
            applied_to: specificWeek === null ? 'template' : 'specific_week',
            specific_week: specificWeek
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: `Ошибка при загрузке расписания: ${error.message}` });
    }
});

router.post('/schedule/upload-bulk', (req, res) => {
    let payload;

    try {
        payload = validateBulkScheduleUploadBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const { groups: groupPayloads, target_week: targetWeek, reference_date: referenceDate } = payload;
    const db = getDb();
    const weekTypeMap = { all: 0, odd: 1, even: 2 };

    let specificWeek = null;

    if (targetWeek === 'current') {
        const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
        const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
        specificWeek = getWeekMeta(semesterStart, referenceDate || formatLocalDate()).weekNumber;
    } else if (typeof targetWeek === 'number') {
        specificWeek = targetWeek;
    }

    // Pre-resolve all groups before any writes — fail fast if any group is missing
    const resolvedGroups = [];

    for (const entry of groupPayloads) {
        const { university, group, lessons } = entry;
        let groupRow;

        if (university) {
            groupRow = db.prepare(`
                SELECT g.id, u.short_name AS university_short_name FROM groups_ g
                JOIN universities u ON u.id = g.university_id
                WHERE u.short_name = ? AND g.name = ?
            `).get(university, group);
        } else {
            const candidates = db.prepare(`
                SELECT g.id, u.short_name AS university_short_name
                FROM groups_ g
                JOIN universities u ON u.id = g.university_id
                WHERE g.name = ?
                ORDER BY u.short_name, g.id
            `).all(group);

            if (candidates.length > 1) {
                return res.status(409).json({
                    error: `Группа "${group}" найдена в нескольких вузах. Укажите поле university.`
                });
            }

            groupRow = candidates[0];
        }

        if (!groupRow) {
            return res.status(404).json({ error: `Группа "${group}" не найдена` });
        }

        resolvedGroups.push({ groupRow, group, lessons });
    }

    const transaction = db.transaction(() => {
        const insert = db.prepare(`
            INSERT INTO lessons (
                group_id, subgroup, day_of_week, week_type, specific_week,
                time_start, time_end, subject, room, lesson_type, teacher, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const results = [];

        for (const { groupRow, group, lessons } of resolvedGroups) {
            if (specificWeek === null) {
                db.prepare('DELETE FROM lessons WHERE group_id = ? AND specific_week IS NULL').run(groupRow.id);
            } else {
                db.prepare('DELETE FROM lessons WHERE group_id = ? AND specific_week = ?').run(groupRow.id, specificWeek);
            }

            let count = 0;

            for (const lesson of lessons) {
                insert.run(
                    groupRow.id,
                    lesson.subgroup,
                    lesson.day,
                    weekTypeMap[lesson.week_type],
                    specificWeek,
                    lesson.time_start,
                    lesson.time_end,
                    lesson.subject,
                    lesson.room,
                    lesson.type,
                    lesson.teacher,
                    lesson.sort_order ?? count
                );
                count += 1;
            }

            results.push({ group, imported: count });
        }

        return results;
    });

    try {
        const results = transaction();
        const totalImported = results.reduce((sum, r) => sum + r.imported, 0);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'schedule.upload',
            entityType: 'bulk_schedule',
            entityId: null,
            ipAddress: getClientAddress(req),
            details: {
                groups: results.map(r => r.group),
                total_imported: totalImported,
                group_count: results.length,
                target_week: targetWeek,
                specific_week: specificWeek
            }
        });

        res.json({
            success: true,
            total_imported: totalImported,
            groups: results,
            applied_to: specificWeek === null ? 'template' : 'specific_week',
            specific_week: specificWeek
        });
    } catch (error) {
        console.error('Bulk upload error:', error);
        res.status(500).json({ error: `Ошибка при загрузке расписания: ${error.message}` });
    }
});

router.get('/schedule/export', async (req, res) => {
    const db = getDb();
    const weekStart = typeof req.query.week_start === 'string' ? req.query.week_start : '';

    if (!isValidIsoDate(weekStart)) {
        return res.status(400).json({ error: 'Укажите week_start в формате YYYY-MM-DD' });
    }

    const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();

    if (!semesterStartRow) {
        return res.status(400).json({ error: 'Сначала задайте дату начала семестра в разделе «Настройки»' });
    }

    const weekMeta = getWeekMeta(semesterStartRow.value, weekStart);
    const groups = db.prepare('SELECT id, name, direction FROM groups_ ORDER BY name').all();

    const courseMap = new Map();

    for (const group of groups) {
        const course = getCourseFromGroupName(group.name);

        if (course === null) {
            continue;
        }

        const allLessons = db.prepare(`
            SELECT id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
                   time_start, time_end, subject, room, lesson_type, teacher
            FROM lessons
            WHERE group_id = ?
        `).all(group.id);

        const hasExceptionWeek = allLessons.some((lesson) => lesson.specific_week === weekMeta.weekNumber);
        let lessonsForWeek;

        if (hasExceptionWeek) {
            lessonsForWeek = allLessons.filter((lesson) => lesson.specific_week === weekMeta.weekNumber);
        } else {
            const candidates = allLessons.filter((lesson) =>
                lesson.specific_week === null &&
                (lesson.week_type === 0 || lesson.week_type === weekMeta.weekTypeNumber)
            );
            lessonsForWeek = resolveTemplateLessons(candidates, weekMeta.weekNumber);
        }

        if (!courseMap.has(course)) {
            courseMap.set(course, []);
        }

        courseMap.get(course).push({
            name: group.name,
            direction: group.direction,
            lessons: lessonsForWeek
        });
    }

    if (courseMap.size === 0) {
        return res.status(404).json({ error: 'Нет ни одной группы с корректным номером (23XYZ) для формирования расписания' });
    }

    const dayDates = {};

    for (let offset = 0; offset < 6; offset += 1) {
        const isoDate = addDaysToIsoDate(weekStart, offset);
        const [year, month, day] = isoDate.split('-');
        dayDates[offset + 1] = `${day}.${month}.${year}`;
    }

    const settingsRows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};

    for (const row of settingsRows) {
        settings[row.key] = row.value;
    }

    const termParity = settings.term_parity === 'fall' ? 'fall' : 'spring';
    const courseSheets = Array.from(courseMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([course, courseGroups]) => ({ course, groups: courseGroups }));

    try {
        const workbook = buildScheduleWorkbook({
            courseSheets,
            dayDates,
            weekTypeLabel: weekMeta.weekTypeLabel.toUpperCase(),
            semesterLabelForCourse: (course) => getSemesterLabel(course, termParity),
            studyForm: settings.study_form || 'очная форма обучения',
            academicYear: settings.academic_year || '',
            directorName: settings.director_name || 'ФИО директора',
            directorTitle: settings.director_title || 'Директор филиала'
        });

        const fileName = `raspisanie_${weekStart}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Schedule export error:', error);
        res.status(500).json({ error: 'Не удалось сформировать файл расписания' });
    }
});

/**
 * Moves one lesson to a different day/time slot — what a drag-and-drop in the
 * builder ends up calling. Deliberately built on the same primitives the
 * normal edit flows already use rather than new logic:
 *
 * - template mode: append a tombstone at the old slot + a new row at the new
 *   one, both stamped from the current week, so past weeks keep resolving to
 *   where the lesson actually was (the same "edits never rewrite history"
 *   guarantee every other template edit has).
 * - week mode, already materialized: the row is real, so just move it.
 * - week mode, not yet materialized: clone the week's resolved template into
 *   real rows exactly like materialize-week does, but drop the moved lesson
 *   at its new slot instead of the old one.
 *
 * Every branch runs inside a single transaction: a move can't half-apply and
 * leave the lesson both gone from the old slot and missing from the new one.
 */
router.post('/schedule/move-lesson', (req, res) => {
    let payload;

    try {
        payload = validateMoveLessonBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(payload.lesson_id);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    const isSameSlot =
        lesson.day_of_week === payload.day_of_week &&
        lesson.time_start === payload.time_start &&
        lesson.time_end === payload.time_end;

    if (isSameSlot) {
        return res.json({ success: true, moved: false });
    }

    const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
    const currentWeek = getWeekMeta(semesterStart, formatLocalDate()).weekNumber;

    const insertLesson = () => db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order,
            kind, load_plan_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
        if (payload.mode === 'template') {
            // Shared with POST /lessons: resolves through tombstones (so an
            // emptied cell reads as free) and treats "every week" as
            // overlapping both parities (the raw query this replaced did not,
            // so an "every week" pair could be dropped onto a чётная one).
            const occupied = findTemplateSlotOccupant(db, {
                groupId: lesson.group_id,
                dayOfWeek: payload.day_of_week,
                timeStart: payload.time_start,
                timeEnd: payload.time_end,
                subgroup: lesson.subgroup,
                weekType: lesson.week_type,
                targetWeek: currentWeek,
                ignoreLessonId: lesson.id
            });

            if (occupied) {
                return res.status(409).json({ error: `В этой ячейке уже есть занятие: ${occupied.subject}` });
            }

            const transaction = db.transaction(() => {
                const statement = insertLesson();

                // Tombstone at the old slot, effective from this week forward.
                // It MUST carry the same load_plan_id: the hour counter selects a
                // plan's rows by that column, so a tombstone written with NULL is
                // invisible to it and the old slot keeps counting forever.
                statement.run(
                    lesson.group_id, lesson.subgroup, lesson.day_of_week, lesson.week_type, null,
                    currentWeek, 1,
                    lesson.time_start, lesson.time_end, lesson.subject, lesson.room,
                    lesson.lesson_type, lesson.teacher, lesson.sort_order,
                    lesson.kind, lesson.load_plan_id
                );

                // Same lesson, new slot, same effective week.
                statement.run(
                    lesson.group_id, lesson.subgroup, payload.day_of_week, lesson.week_type, null,
                    currentWeek, 0,
                    payload.time_start, payload.time_end, lesson.subject, lesson.room,
                    lesson.lesson_type, lesson.teacher, lesson.sort_order,
                    lesson.kind, lesson.load_plan_id
                );
            });

            transaction();
        } else {
            const alreadyMaterialized = db.prepare(
                'SELECT 1 FROM lessons WHERE group_id = ? AND specific_week = ? LIMIT 1'
            ).get(lesson.group_id, payload.week_number);

            const occupied = findWeekSlotOccupant(db, {
                groupId: lesson.group_id,
                weekNumber: payload.week_number,
                dayOfWeek: payload.day_of_week,
                timeStart: payload.time_start,
                timeEnd: payload.time_end,
                subgroup: lesson.subgroup,
                ignoreLessonId: lesson.id
            });

            if (occupied) {
                return res.status(409).json({ error: `В этой ячейке уже есть занятие: ${occupied.subject}` });
            }

            if (alreadyMaterialized) {
                db.prepare(`
                    UPDATE lessons
                    SET day_of_week = ?, time_start = ?, time_end = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(payload.day_of_week, payload.time_start, payload.time_end, lesson.id);
            } else {
                const weekTypeNumber = getWeekTypeForWeekNumber(semesterStart, payload.week_number);
                const templateRows = db.prepare(`
                    SELECT id, subgroup, day_of_week, week_type, template_from_week, is_removed,
                           time_start, time_end, subject, room, lesson_type, teacher, sort_order,
                           kind, load_plan_id
                    FROM lessons
                    WHERE group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
                `).all(lesson.group_id, weekTypeNumber);

                const resolved = resolveTemplateLessons(templateRows, payload.week_number);
                const movedKey = `${lesson.day_of_week}|${lesson.time_start}|${lesson.time_end}|${lesson.subgroup}`;

                const transaction = db.transaction(() => {
                    const statement = insertLesson();
                    let sortOrder = 0;

                    for (const row of resolved) {
                        const key = `${row.day_of_week}|${row.time_start}|${row.time_end}|${row.subgroup}`;
                        const isMoved = key === movedKey;

                        statement.run(
                            lesson.group_id,
                            row.subgroup,
                            isMoved ? payload.day_of_week : row.day_of_week,
                            0,
                            payload.week_number,
                            1,
                            0,
                            isMoved ? payload.time_start : row.time_start,
                            isMoved ? payload.time_end : row.time_end,
                            row.subject, row.room, row.lesson_type, row.teacher,
                            sortOrder, row.kind, row.load_plan_id
                        );
                        sortOrder += 1;
                    }
                });

                transaction();
            }
        }
    } catch (error) {
        console.error('Move lesson error:', error);
        return res.status(500).json({ error: 'Не удалось перенести занятие' });
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.move',
        entityType: 'lesson',
        entityId: lesson.id,
        ipAddress: getClientAddress(req),
        details: {
            mode: payload.mode,
            week_number: payload.week_number ?? null,
            from: { day_of_week: lesson.day_of_week, time_start: lesson.time_start, time_end: lesson.time_end },
            to: { day_of_week: payload.day_of_week, time_start: payload.time_start, time_end: payload.time_end }
        }
    });

    res.json({ success: true, moved: true });
});

router.post('/schedule/materialize-week', (req, res) => {
    let payload;

    try {
        payload = validateMaterializeWeekBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(payload.group_id);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    // This endpoint only makes sense the first time a week is touched — once it has
    // its own rows, edits should go through the normal single-lesson endpoints.
    const alreadyMaterialized = db.prepare(
        'SELECT 1 FROM lessons WHERE group_id = ? AND specific_week = ? LIMIT 1'
    ).get(payload.group_id, payload.week_number);

    if (alreadyMaterialized) {
        return res.status(409).json({ error: 'Эта неделя уже содержит собственные записи' });
    }

    const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
    const weekTypeNumber = getWeekTypeForWeekNumber(semesterStart, payload.week_number);
    const templateRows = db.prepare(`
        SELECT id, subgroup, day_of_week, week_type, template_from_week, is_removed,
               time_start, time_end, subject, room, lesson_type, teacher, kind, load_plan_id
        FROM lessons
        WHERE group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
    `).all(payload.group_id, weekTypeNumber);

    const resolved = resolveTemplateLessons(templateRows, payload.week_number);
    const slotKey = (lesson) => `${lesson.day_of_week}|${lesson.time_start}|${lesson.time_end}|${lesson.subgroup}`;
    const touchedKey = `${payload.day_of_week}|${payload.time_start}|${payload.time_end}|${payload.subgroup}`;

    const finalLessons = [];
    let touchedHandled = false;

    for (const lesson of resolved) {
        if (slotKey(lesson) === touchedKey) {
            touchedHandled = true;

            if (payload.action === 'upsert') {
                finalLessons.push({
                    day_of_week: payload.day_of_week,
                    time_start: payload.time_start,
                    time_end: payload.time_end,
                    subgroup: payload.subgroup,
                    subject: payload.subject,
                    room: payload.room,
                    lesson_type: payload.lesson_type,
                    teacher: payload.teacher,
                    // Editing a slot in place keeps whatever the template row was
                    // linked to — otherwise the first week edit would silently
                    // detach the lesson from its load plan and drop its hours.
                    kind: lesson.kind,
                    load_plan_id: lesson.load_plan_id
                });
            }
            // action === 'remove' — simply not carried into finalLessons
        } else {
            finalLessons.push({
                day_of_week: lesson.day_of_week,
                time_start: lesson.time_start,
                time_end: lesson.time_end,
                subgroup: lesson.subgroup,
                subject: lesson.subject,
                room: lesson.room,
                lesson_type: lesson.lesson_type,
                teacher: lesson.teacher,
                kind: lesson.kind,
                load_plan_id: lesson.load_plan_id
            });
        }
    }

    if (!touchedHandled && payload.action === 'upsert') {
        finalLessons.push({
            day_of_week: payload.day_of_week,
            time_start: payload.time_start,
            time_end: payload.time_end,
            subgroup: payload.subgroup,
            subject: payload.subject,
            room: payload.room,
            lesson_type: payload.lesson_type,
            teacher: payload.teacher,
            kind: 'lesson',
            load_plan_id: null
        });
    }

    const transaction = db.transaction(() => {
        const insert = db.prepare(`
            INSERT INTO lessons (
                group_id, subgroup, day_of_week, week_type, specific_week,
                template_from_week, is_removed,
                time_start, time_end, subject, room, lesson_type, teacher, sort_order,
                kind, load_plan_id
            )
            VALUES (?, ?, ?, 0, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let count = 0;

        for (const lesson of finalLessons) {
            insert.run(
                payload.group_id,
                lesson.subgroup,
                lesson.day_of_week,
                payload.week_number,
                lesson.time_start,
                lesson.time_end,
                lesson.subject,
                lesson.room,
                lesson.lesson_type,
                lesson.teacher,
                count,
                lesson.kind || 'lesson',
                lesson.load_plan_id ?? null
            );
            count += 1;
        }

        return count;
    });

    try {
        const count = transaction();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'schedule.materialize_week',
            entityType: 'group_schedule',
            entityId: payload.group_id,
            ipAddress: getClientAddress(req),
            details: { group_id: payload.group_id, week_number: payload.week_number, lesson_count: count }
        });

        res.status(201).json({ success: true, count });
    } catch (error) {
        console.error('Materialize week error:', error);
        res.status(500).json({ error: 'Не удалось сохранить неделю' });
    }
});

router.delete('/schedule/week', (req, res) => {
    const db = getDb();
    const groupId = Number.parseInt(req.query.group_id, 10);
    const weekNumber = Number.parseInt(req.query.week_number, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Укажите корректный group_id' });
    }

    if (!Number.isInteger(weekNumber) || weekNumber <= 0) {
        return res.status(400).json({ error: 'Укажите корректный week_number' });
    }

    const result = db.prepare('DELETE FROM lessons WHERE group_id = ? AND specific_week = ?').run(groupId, weekNumber);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'schedule.clear_week',
        entityType: 'group_schedule',
        entityId: groupId,
        ipAddress: getClientAddress(req),
        details: { group_id: groupId, week_number: weekNumber, deleted: result.changes }
    });

    res.json({ success: true, deleted: result.changes });
});

router.get('/lessons', (req, res) => {
    const db = getDb();
    const groupId = Number.parseInt(req.query.group_id, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Укажите корректный group_id' });
    }

    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    const rows = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ?
        ORDER BY day_of_week, sort_order, time_start
    `).all(groupId);

    res.json(rows);
});

router.post('/lessons', (req, res) => {
    let payload;

    try {
        payload = validateLessonCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(payload.group_id);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    // Only matters for template rows (specific_week IS NULL) — always the real
    // current week, never client-supplied, so a version can never claim to have
    // taken effect in the past and silently rewrite what earlier weeks showed.
    const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
    const templateFromWeek = getWeekMeta(semesterStart, formatLocalDate()).weekNumber;

    // Without this, an "every week" pair could be created into a cell that
    // already holds a чётная/нечётная one (the constructor's template view
    // filters by exact parity, so such a cell looks empty). The result was two
    // lessons rendered in one slot for students and double-counted hours for
    // the teacher — see the slot-collision tests.
    const occupant = payload.specific_week === null
        ? findTemplateSlotOccupant(db, {
            groupId: payload.group_id,
            dayOfWeek: payload.day_of_week,
            timeStart: payload.time_start,
            timeEnd: payload.time_end,
            subgroup: payload.subgroup,
            weekType: payload.week_type,
            targetWeek: templateFromWeek
        })
        : findWeekSlotOccupant(db, {
            groupId: payload.group_id,
            weekNumber: payload.specific_week,
            dayOfWeek: payload.day_of_week,
            timeStart: payload.time_start,
            timeEnd: payload.time_end,
            subgroup: payload.subgroup
        });

    if (occupant && !payload.is_removed) {
        return res.status(409).json({
            error: `В этой ячейке уже есть занятие: ${occupant.subject}. Откройте его, чтобы изменить, или сначала уберите.`
        });
    }

    const result = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, sort_order
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        payload.group_id,
        payload.subgroup,
        payload.day_of_week,
        payload.week_type,
        payload.specific_week,
        templateFromWeek,
        payload.is_removed ? 1 : 0,
        payload.time_start,
        payload.time_end,
        payload.subject,
        payload.room,
        payload.lesson_type,
        payload.teacher,
        payload.sort_order
    );

    const created = db.prepare('SELECT * FROM lessons WHERE id = ?').get(result.lastInsertRowid);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.create',
        entityType: 'lesson',
        entityId: created.id,
        ipAddress: getClientAddress(req),
        details: {
            group_id: payload.group_id,
            subject: created.subject,
            day_of_week: created.day_of_week,
            time_start: created.time_start,
            time_end: created.time_end,
            specific_week: created.specific_week
        }
    });

    res.status(201).json(created);
});

router.put('/lessons/:id', (req, res) => {
    const db = getDb();
    const lessonId = Number(req.params.id);

    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID занятия' });
    }

    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    let updates;

    try {
        updates = validateLessonUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const nextLesson = {
        ...lesson,
        ...updates
    };

    if (nextLesson.time_start >= nextLesson.time_end) {
        return res.status(400).json({ error: 'Время окончания должно быть позже времени начала' });
    }

    db.prepare(`
        UPDATE lessons SET
            subgroup = ?,
            day_of_week = ?,
            week_type = ?,
            specific_week = ?,
            time_start = ?,
            time_end = ?,
            subject = ?,
            room = ?,
            lesson_type = ?,
            teacher = ?,
            sort_order = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        nextLesson.subgroup,
        nextLesson.day_of_week,
        nextLesson.week_type,
        nextLesson.specific_week,
        nextLesson.time_start,
        nextLesson.time_end,
        nextLesson.subject,
        nextLesson.room,
        nextLesson.lesson_type,
        nextLesson.teacher,
        nextLesson.sort_order,
        lessonId
    );

    const updated = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.update',
        entityType: 'lesson',
        entityId: lessonId,
        ipAddress: getClientAddress(req),
        details: {
            before: {
                subgroup: lesson.subgroup,
                day_of_week: lesson.day_of_week,
                week_type: lesson.week_type,
                specific_week: lesson.specific_week,
                time_start: lesson.time_start,
                time_end: lesson.time_end,
                subject: lesson.subject,
                room: lesson.room,
                lesson_type: lesson.lesson_type,
                teacher: lesson.teacher,
                sort_order: lesson.sort_order
            },
            after: {
                subgroup: updated.subgroup,
                day_of_week: updated.day_of_week,
                week_type: updated.week_type,
                specific_week: updated.specific_week,
                time_start: updated.time_start,
                time_end: updated.time_end,
                subject: updated.subject,
                room: updated.room,
                lesson_type: updated.lesson_type,
                teacher: updated.teacher,
                sort_order: updated.sort_order
            }
        }
    });
    res.json(updated);
});

router.delete('/lessons/:id', (req, res) => {
    const db = getDb();
    const lessonId = Number(req.params.id);

    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID занятия' });
    }

    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
    const currentWeek = getWeekMeta(semesterStart, formatLocalDate()).weekNumber;

    // A template row that has already been live in earlier weeks is retired
    // with a tombstone from this week forward, never erased: hard-deleting it
    // would remove it from the PAST too, wiping hours a teacher had already
    // taught. That is the same rule move-lesson uses; delete used to be the
    // one edit path that still rewrote history.
    const isLiveTemplateRow = lesson.specific_week === null
        && lesson.is_removed === 0
        && lesson.template_from_week < currentWeek;

    if (isLiveTemplateRow) {
        db.prepare(`
            INSERT INTO lessons (
                group_id, subgroup, day_of_week, week_type, specific_week,
                template_from_week, is_removed,
                time_start, time_end, subject, room, lesson_type, teacher, sort_order,
                kind, load_plan_id
            )
            VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            lesson.group_id, lesson.subgroup, lesson.day_of_week, lesson.week_type,
            currentWeek,
            lesson.time_start, lesson.time_end, lesson.subject, lesson.room,
            lesson.lesson_type, lesson.teacher, lesson.sort_order,
            lesson.kind, lesson.load_plan_id
        );
    } else {
        // Never been live in a past week (created this week or later), or it is
        // a single week's own row — nothing in the past depends on it.
        db.prepare('DELETE FROM lessons WHERE id = ?').run(lessonId);
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: isLiveTemplateRow ? 'lesson.retire' : 'lesson.delete',
        entityType: 'lesson',
        entityId: lessonId,
        ipAddress: getClientAddress(req),
        details: {
            group_id: lesson.group_id,
            subject: lesson.subject,
            day_of_week: lesson.day_of_week,
            time_start: lesson.time_start,
            time_end: lesson.time_end,
            specific_week: lesson.specific_week,
            retired_from_week: isLiveTemplateRow ? currentWeek : null
        }
    });

    res.json({ success: true, deleted: lessonId, retired_from_week: isLiveTemplateRow ? currentWeek : null });
});

router.get('/settings', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};

    for (const row of rows) {
        settings[row.key] = row.value;
    }

    res.json(settings);
});

router.put('/settings', (req, res) => {
    let settingsPayload;

    try {
        settingsPayload = validateSettingsBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const upsert = db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const updatedKeys = { semester_start_date: settingsPayload.semester_start_date };
    // Writes both places at once — the schedule's week numbering and the
    // active semester the hour counter walks must never disagree.
    syncSemesterStartDate(db, settingsPayload.semester_start_date);

    for (const key of ['director_name', 'director_title', 'academic_year', 'study_form', 'term_parity']) {
        if (settingsPayload[key] !== null && settingsPayload[key] !== undefined) {
            upsert.run(key, settingsPayload[key]);
            updatedKeys[key] = settingsPayload[key];
        }
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'settings.update',
        entityType: 'settings',
        entityId: 'semester_start_date',
        ipAddress: getClientAddress(req),
        details: updatedKeys
    });
    res.json({ success: true });
});

router.get('/audit-logs', (req, res) => {
    try {
        const logs = getAuditLogs(req.query.limit, 200);
        res.json(logs);
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

router.get('/audit-logs/export', (req, res) => {
    let logs;

    try {
        logs = getAuditLogs(req.query.limit === undefined ? 1000 : req.query.limit, 5000);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const csv = buildAuditCsv(logs);
    const stamp = formatTimestampForFileName(new Date());

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.csv"`);
    res.send(csv);
});

router.get('/backups', async (req, res) => {
    try {
        const backups = await listDatabaseBackups();
        res.json(backups);
    } catch (error) {
        console.error('Backup list error:', error);
        res.status(500).json({ error: 'Не удалось получить список резервных копий' });
    }
});

router.post('/backups', async (req, res) => {
    try {
        const backup = await createDatabaseBackup();
        const db = getDb();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'backup.create',
            entityType: 'database_backup',
            entityId: backup.file_name,
            ipAddress: getClientAddress(req),
            details: backup
        });

        res.json({
            success: true,
            backup
        });
    } catch (error) {
        console.error('Backup create error:', error);
        res.status(500).json({ error: 'Не удалось создать резервную копию' });
    }
});

router.get('/backups/:fileName/download', async (req, res) => {
    let filePath;

    try {
        filePath = await getBackupDownloadPath(req.params.fileName);
    } catch {
        return res.status(404).json({ error: 'Резервная копия не найдена' });
    }

    res.download(filePath, req.params.fileName);
});

// ---------------------------------------------------------------------------
// Teaching-load tracking: teachers, disciplines, semesters, and the load plan
// itself. All of this sits behind the same admin auth as everything else in
// this router — there is no separate, unauthenticated write path for
// teachers. The "either the specialist or the teacher can enter the plan"
// flexibility the department asked for is expressed by the entered_by tag
// on each row (who the number came from), not by a second login system;
// teachers only ever get read access, via the public search endpoint in
// routes/api.js.
// ---------------------------------------------------------------------------

router.get('/teachers', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM teachers ORDER BY full_name').all();
    res.json(rows);
});

router.post('/teachers', (req, res) => {
    let payload;

    try {
        payload = validateTeacherCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();

    try {
        const result = db.prepare('INSERT INTO teachers (full_name) VALUES (?)').run(payload.full_name);
        const created = db.prepare('SELECT * FROM teachers WHERE id = ?').get(result.lastInsertRowid);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'teacher.create',
            entityType: 'teacher',
            entityId: created.id,
            ipAddress: getClientAddress(req),
            details: { full_name: created.full_name }
        });

        res.status(201).json(created);
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такой преподаватель уже есть в справочнике' });
        }

        console.error('Teacher create error:', error);
        res.status(500).json({ error: 'Не удалось добавить преподавателя' });
    }
});

// Rename — the fix for "one letter wrong", so a typo doesn't force a
// delete-and-recreate that would also detach every load_plan row already
// entered against the old (mistyped) name.
router.put('/teachers/:id', (req, res) => {
    const teacherId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID преподавателя' });
    }

    let payload;

    try {
        payload = validateTeacherCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);

    if (!existing) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    try {
        db.prepare('UPDATE teachers SET full_name = ? WHERE id = ?').run(payload.full_name, teacherId);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'teacher.update',
            entityType: 'teacher',
            entityId: teacherId,
            ipAddress: getClientAddress(req),
            details: { before: existing.full_name, after: payload.full_name }
        });

        res.json(db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId));
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такой преподаватель уже есть в справочнике' });
        }

        console.error('Teacher update error:', error);
        res.status(500).json({ error: 'Не удалось переименовать преподавателя' });
    }
});

// Blocked while any load_plan row still references this teacher — deleting
// through that would silently cascade-delete those rows (and whatever hours
// were already tracked in them). Reassign or remove those rows first.
router.delete('/teachers/:id', (req, res) => {
    const teacherId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID преподавателя' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);

    if (!existing) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    const planCount = db.prepare('SELECT COUNT(*) c FROM load_plan WHERE teacher_id = ?').get(teacherId).c;

    if (planCount > 0) {
        return res.status(409).json({
            error: `У этого преподавателя ${planCount} ${pluralizePlanRows(planCount)} в плане нагрузки. Удалите или измените их, затем удаляйте преподавателя.`
        });
    }

    db.prepare('DELETE FROM teachers WHERE id = ?').run(teacherId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'teacher.delete',
        entityType: 'teacher',
        entityId: teacherId,
        ipAddress: getClientAddress(req),
        details: { full_name: existing.full_name }
    });

    res.json({ success: true });
});

router.get('/disciplines', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM disciplines ORDER BY name').all();
    res.json(rows);
});

router.post('/disciplines', (req, res) => {
    let payload;

    try {
        payload = validateDisciplineCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();

    try {
        const result = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run(payload.name);
        const created = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(result.lastInsertRowid);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'discipline.create',
            entityType: 'discipline',
            entityId: created.id,
            ipAddress: getClientAddress(req),
            details: { name: created.name }
        });

        res.status(201).json(created);
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такая дисциплина уже есть в справочнике' });
        }

        console.error('Discipline create error:', error);
        res.status(500).json({ error: 'Не удалось добавить дисциплину' });
    }
});

router.put('/disciplines/:id', (req, res) => {
    const disciplineId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(disciplineId) || disciplineId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID дисциплины' });
    }

    let payload;

    try {
        payload = validateDisciplineCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(disciplineId);

    if (!existing) {
        return res.status(404).json({ error: 'Дисциплина не найдена' });
    }

    try {
        db.prepare('UPDATE disciplines SET name = ? WHERE id = ?').run(payload.name, disciplineId);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'discipline.update',
            entityType: 'discipline',
            entityId: disciplineId,
            ipAddress: getClientAddress(req),
            details: { before: existing.name, after: payload.name }
        });

        res.json(db.prepare('SELECT * FROM disciplines WHERE id = ?').get(disciplineId));
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такая дисциплина уже есть в справочнике' });
        }

        console.error('Discipline update error:', error);
        res.status(500).json({ error: 'Не удалось переименовать дисциплину' });
    }
});

router.delete('/disciplines/:id', (req, res) => {
    const disciplineId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(disciplineId) || disciplineId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID дисциплины' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(disciplineId);

    if (!existing) {
        return res.status(404).json({ error: 'Дисциплина не найдена' });
    }

    const planCount = db.prepare('SELECT COUNT(*) c FROM load_plan WHERE discipline_id = ?').get(disciplineId).c;

    if (planCount > 0) {
        return res.status(409).json({
            error: `Эта дисциплина используется в ${planCount} ${pluralizePlanRows(planCount)} плана нагрузки. Удалите или измените их, затем удаляйте дисциплину.`
        });
    }

    db.prepare('DELETE FROM disciplines WHERE id = ?').run(disciplineId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'discipline.delete',
        entityType: 'discipline',
        entityId: disciplineId,
        ipAddress: getClientAddress(req),
        details: { name: existing.name }
    });

    res.json({ success: true });
});

/**
 * Dry run for "what happens to everyone's hours if I change the semester's
 * start date or length". Both settings silently re-derive every teacher's
 * total — start_date moves every lesson date, weeks_count is the ceiling the
 * counter stops at — so the UI asks this first and shows the damage before
 * writing anything. Computes only, never writes.
 */
router.get('/semesters/:id/impact', (req, res) => {
    const semesterId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(semesterId) || semesterId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID семестра' });
    }

    const db = getDb();
    const semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    const nextStartDate = typeof req.query.start_date === 'string' && req.query.start_date
        ? req.query.start_date
        : semester.start_date;
    const nextWeeksCount = req.query.weeks_count ? Number.parseInt(req.query.weeks_count, 10) : semester.weeks_count;

    if (!isValidIsoDate(nextStartDate)) {
        return res.status(400).json({ error: 'Некорректная дата начала' });
    }

    if (!Number.isInteger(nextWeeksCount) || nextWeeksCount < 1 || nextWeeksCount > 52) {
        return res.status(400).json({ error: 'Некорректное число недель' });
    }

    const planRows = db.prepare(`
        SELECT lp.id, lp.group_id, lp.teacher_id, t.full_name AS teacher_name
        FROM load_plan lp JOIN teachers t ON t.id = lp.teacher_id
        WHERE lp.semester_id = ?
    `).all(semesterId);

    const exceptionCache = new Map();
    const exceptionWeeksFor = (groupId, weeksCount) => {
        const key = `${groupId}:${weeksCount}`;
        if (!exceptionCache.has(key)) {
            const overrides = db.prepare(
                'SELECT specific_week FROM lessons WHERE group_id = ? AND specific_week IS NOT NULL'
            ).all(groupId);
            exceptionCache.set(key, computeExceptionWeeks(overrides, weeksCount));
        }
        return exceptionCache.get(key);
    };

    const changedTeachers = new Set();
    let hoursBefore = 0;
    let hoursAfter = 0;
    let changedRows = 0;

    for (const row of planRows) {
        const linkedLessons = db.prepare('SELECT * FROM lessons WHERE load_plan_id = ?').all(row.id);
        const before = computeLoadProgress({
            semesterStartDate: semester.start_date,
            weeksCount: semester.weeks_count,
            linkedLessons,
            exceptionWeeks: exceptionWeeksFor(row.group_id, semester.weeks_count)
        }).occurred_hours;
        const after = computeLoadProgress({
            semesterStartDate: nextStartDate,
            weeksCount: nextWeeksCount,
            linkedLessons,
            exceptionWeeks: exceptionWeeksFor(row.group_id, nextWeeksCount)
        }).occurred_hours;

        hoursBefore += before;
        hoursAfter += after;

        if (before !== after) {
            changedRows += 1;
            changedTeachers.add(row.teacher_name);
        }
    }

    res.json({
        current: { start_date: semester.start_date, weeks_count: semester.weeks_count },
        proposed: { start_date: nextStartDate, weeks_count: nextWeeksCount },
        last_week: {
            current: addDaysToIsoDate(semester.start_date, (semester.weeks_count - 1) * 7),
            proposed: addDaysToIsoDate(nextStartDate, (nextWeeksCount - 1) * 7)
        },
        plan_rows_total: planRows.length,
        plan_rows_changed: changedRows,
        teachers_changed: changedTeachers.size,
        teacher_names: [...changedTeachers].sort((a, b) => a.localeCompare(b, 'ru')).slice(0, 10),
        hours_before: hoursBefore,
        hours_after: hoursAfter
    });
});

router.get('/semesters', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM semesters ORDER BY start_date DESC').all();
    res.json(rows.map(mapSemesterRow));
});

router.post('/semesters', (req, res) => {
    let payload;

    try {
        payload = validateSemesterCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const result = db.prepare(`
        INSERT INTO semesters (label, start_date, weeks_count, is_active)
        VALUES (?, ?, ?, 0)
    `).run(payload.label, payload.start_date, payload.weeks_count);
    const created = db.prepare('SELECT * FROM semesters WHERE id = ?').get(result.lastInsertRowid);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'semester.create',
        entityType: 'semester',
        entityId: created.id,
        ipAddress: getClientAddress(req),
        details: payload
    });

    res.status(201).json(mapSemesterRow(created));
});

router.put('/semesters/:id', (req, res) => {
    const semesterId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(semesterId) || semesterId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID семестра' });
    }

    let payload;

    try {
        payload = validateSemesterUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    if (!existing) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    const next = { ...existing, ...payload };

    const transaction = db.transaction(() => {
        // Only one semester drives "which one am I entering/viewing load for"
        // by default — activating this one deactivates every other.
        if (payload.is_active) {
            db.prepare('UPDATE semesters SET is_active = 0 WHERE id != ?').run(semesterId);
        }

        db.prepare(`
            UPDATE semesters
            SET label = ?, start_date = ?, weeks_count = ?, is_active = ?
            WHERE id = ?
        `).run(next.label, next.start_date, next.weeks_count, next.is_active ? 1 : 0, semesterId);

        // Whichever semester is now the active one dictates the date the
        // schedule numbers its weeks from — see syncSemesterStartDate.
        const active = db.prepare('SELECT start_date FROM semesters WHERE is_active = 1').get();
        if (active) {
            syncSemesterStartDate(db, active.start_date);
        }
    });

    transaction();

    const updated = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'semester.update',
        entityType: 'semester',
        entityId: semesterId,
        ipAddress: getClientAddress(req),
        details: payload
    });

    res.json(mapSemesterRow(updated));
});

router.get('/load-plan', (req, res) => {
    const db = getDb();
    const filters = [];
    const params = [];

    for (const [column, key] of [['semester_id', 'semester_id'], ['teacher_id', 'teacher_id'], ['group_id', 'group_id']]) {
        const raw = req.query[key];

        if (raw === undefined || raw === '') {
            continue;
        }

        const value = Number.parseInt(raw, 10);

        if (!Number.isInteger(value) || value <= 0) {
            return res.status(400).json({ error: `Некорректный ${key}` });
        }

        filters.push(`lp.${column} = ?`);
        params.push(value);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const rows = db.prepare(`
        SELECT
            lp.*,
            t.full_name AS teacher_name,
            d.name AS discipline_name,
            g.name AS group_name
        FROM load_plan lp
        JOIN teachers t ON t.id = lp.teacher_id
        JOIN disciplines d ON d.id = lp.discipline_id
        JOIN groups_ g ON g.id = lp.group_id
        ${whereClause}
        ORDER BY t.full_name, d.name, lp.lesson_type
    `).all(...params);

    // Scoped to this one request only — never cached across requests, since
    // a specialist materializing a week (adding a new exception week) must
    // be reflected on the very next read, not after some cache expires.
    const exceptionWeeksCache = new Map();
    res.json(rows.map((row) => attachLoadProgress(db, row, exceptionWeeksCache)));
});

// Excel report: summary + per-discipline breakdown + per-date ledger. Can be
// pulled at any point in the semester — see buildLoadWorkbook's own comment
// for why the numbers are always an honest snapshot of "as of right now".
router.get('/load-plan/export', async (req, res) => {
    const db = getDb();
    let semester;

    if (req.query.semester_id) {
        const semesterId = Number.parseInt(req.query.semester_id, 10);

        if (!Number.isInteger(semesterId) || semesterId <= 0) {
            return res.status(400).json({ error: 'Некорректный semester_id' });
        }

        semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);
    } else {
        semester = db.prepare('SELECT * FROM semesters WHERE is_active = 1 ORDER BY start_date DESC LIMIT 1').get();
    }

    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    const planRows = db.prepare(`
        SELECT lp.*, t.full_name AS teacher_name, d.name AS discipline_name, g.name AS group_name
        FROM load_plan lp
        JOIN teachers t ON t.id = lp.teacher_id
        JOIN disciplines d ON d.id = lp.discipline_id
        JOIN groups_ g ON g.id = lp.group_id
        WHERE lp.semester_id = ?
        ORDER BY t.full_name, d.name, lp.lesson_type
    `).all(semester.id);

    const exceptionWeeksCache = new Map();

    const rows = planRows.map((row) => {
        const cacheKey = `${row.group_id}:${semester.id}`;
        let exceptionWeeks = exceptionWeeksCache.get(cacheKey);

        if (!exceptionWeeks) {
            const overrideRows = db.prepare(`
                SELECT specific_week FROM lessons
                WHERE group_id = ? AND specific_week IS NOT NULL
            `).all(row.group_id);
            exceptionWeeks = computeExceptionWeeks(overrideRows, semester.weeks_count);
            exceptionWeeksCache.set(cacheKey, exceptionWeeks);
        }

        const linkedLessons = db.prepare('SELECT * FROM lessons WHERE load_plan_id = ?').all(row.id);
        const progress = computeLoadProgress({
            semesterStartDate: semester.start_date,
            weeksCount: semester.weeks_count,
            linkedLessons,
            exceptionWeeks
        });

        return {
            teacher_name: row.teacher_name,
            discipline_name: row.discipline_name,
            lesson_type: row.lesson_type,
            group_name: row.group_name,
            subgroup: row.subgroup,
            planned_hours: row.planned_hours,
            occurred_hours: progress.occurred_hours,
            occurrences: progress.occurrences
        };
    });

    try {
        const workbook = buildLoadWorkbook({ semesterLabel: semester.label, rows });
        const fileName = `nagruzka-${semester.label.replace(/[^\wа-яА-ЯёЁ-]+/gu, '_')}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Load export error:', error);
        res.status(500).json({ error: 'Не удалось сформировать отчёт' });
    }
});

router.post('/load-plan', (req, res) => {
    let payload;

    try {
        payload = validateLoadPlanCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();

    const semester = db.prepare('SELECT id FROM semesters WHERE id = ?').get(payload.semester_id);
    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    const teacher = db.prepare('SELECT id FROM teachers WHERE id = ?').get(payload.teacher_id);
    if (!teacher) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    const discipline = db.prepare('SELECT id FROM disciplines WHERE id = ?').get(payload.discipline_id);
    if (!discipline) {
        return res.status(404).json({ error: 'Дисциплина не найдена' });
    }

    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(payload.group_id);
    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    const result = db.prepare(`
        INSERT INTO load_plan (
            semester_id, teacher_id, discipline_id, lesson_type,
            group_id, subgroup, planned_hours, entered_by, confirmed
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        payload.semester_id,
        payload.teacher_id,
        payload.discipline_id,
        payload.lesson_type,
        payload.group_id,
        payload.subgroup,
        payload.planned_hours,
        payload.entered_by,
        payload.entered_by === 'specialist' ? 1 : 0
    );

    const created = db.prepare(`
        SELECT lp.*, t.full_name AS teacher_name, d.name AS discipline_name, g.name AS group_name
        FROM load_plan lp
        JOIN teachers t ON t.id = lp.teacher_id
        JOIN disciplines d ON d.id = lp.discipline_id
        JOIN groups_ g ON g.id = lp.group_id
        WHERE lp.id = ?
    `).get(result.lastInsertRowid);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'load_plan.create',
        entityType: 'load_plan',
        entityId: created.id,
        ipAddress: getClientAddress(req),
        details: payload
    });

    res.status(201).json(attachLoadProgress(db, created));
});

router.put('/load-plan/:id', (req, res) => {
    const planId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(planId) || planId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID плана' });
    }

    let payload;

    try {
        payload = validateLoadPlanUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM load_plan WHERE id = ?').get(planId);

    if (!existing) {
        return res.status(404).json({ error: 'Строка плана не найдена' });
    }

    if (payload.teacher_id !== undefined && !db.prepare('SELECT id FROM teachers WHERE id = ?').get(payload.teacher_id)) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    if (payload.discipline_id !== undefined && !db.prepare('SELECT id FROM disciplines WHERE id = ?').get(payload.discipline_id)) {
        return res.status(404).json({ error: 'Дисциплина не найдена' });
    }

    if (payload.group_id !== undefined && !db.prepare('SELECT id FROM groups_ WHERE id = ?').get(payload.group_id)) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    // Changing the group out from under linked lessons would leave them
    // pointing at a plan row whose group no longer matches where they
    // actually live — unlink first, then the group is free to change.
    if (payload.group_id !== undefined && payload.group_id !== existing.group_id) {
        const linkedCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE load_plan_id = ?').get(planId).c;
        if (linkedCount > 0) {
            return res.status(409).json({
                error: `К этой строке привязано пар: ${linkedCount}. Сначала отвяжите их («Привязать пару» → снять привязку), потом меняйте группу.`
            });
        }
    }

    const next = { ...existing, ...payload };

    db.prepare(`
        UPDATE load_plan
        SET teacher_id = ?, discipline_id = ?, lesson_type = ?, group_id = ?, subgroup = ?,
            planned_hours = ?, confirmed = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        next.teacher_id, next.discipline_id, next.lesson_type, next.group_id, next.subgroup,
        next.planned_hours, next.confirmed ? 1 : 0, planId
    );

    const updated = db.prepare(`
        SELECT lp.*, t.full_name AS teacher_name, d.name AS discipline_name, g.name AS group_name
        FROM load_plan lp
        JOIN teachers t ON t.id = lp.teacher_id
        JOIN disciplines d ON d.id = lp.discipline_id
        JOIN groups_ g ON g.id = lp.group_id
        WHERE lp.id = ?
    `).get(planId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'load_plan.update',
        entityType: 'load_plan',
        entityId: planId,
        ipAddress: getClientAddress(req),
        details: payload
    });

    res.json(attachLoadProgress(db, updated));
});

router.delete('/load-plan/:id', (req, res) => {
    const planId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(planId) || planId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID плана' });
    }

    const db = getDb();
    const result = db.prepare('DELETE FROM load_plan WHERE id = ?').run(planId);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Строка плана не найдена' });
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'load_plan.delete',
        entityType: 'load_plan',
        entityId: planId,
        ipAddress: getClientAddress(req),
        details: null
    });

    res.json({ success: true });
});

// Links (or unlinks, with load_plan_id: null) one schedule entry to a plan
// row — this is what tells the calculator which recurring slot in the
// schedule counts toward that plan's hours.
router.put('/lessons/:id/load-plan', (req, res) => {
    const lessonId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID занятия' });
    }

    let payload;

    try {
        payload = validateLessonLoadPlanLinkBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const lesson = db.prepare('SELECT id, group_id FROM lessons WHERE id = ?').get(lessonId);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    if (payload.load_plan_id !== null) {
        const plan = db.prepare('SELECT id, group_id FROM load_plan WHERE id = ?').get(payload.load_plan_id);

        if (!plan) {
            return res.status(404).json({ error: 'Строка плана не найдена' });
        }

        // Otherwise a pair from one group could feed hours into another
        // group's plan row — the hours would be real, just billed to the
        // wrong line. The UI only ever offers same-group pairs; this closes
        // the same hole at the API.
        if (plan.group_id !== lesson.group_id) {
            return res.status(409).json({ error: 'Пара и строка плана относятся к разным группам' });
        }
    }

    db.prepare('UPDATE lessons SET load_plan_id = ? WHERE id = ?').run(payload.load_plan_id, lessonId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.link_load_plan',
        entityType: 'lesson',
        entityId: lessonId,
        ipAddress: getClientAddress(req),
        details: { load_plan_id: payload.load_plan_id }
    });

    res.json({ success: true, lesson_id: lessonId, load_plan_id: payload.load_plan_id });
});

function mapSemesterRow(row) {
    return { ...row, is_active: Boolean(row.is_active) };
}

/**
 * "When does the semester start" is asked by two different parts of the app:
 * settings.semester_start_date numbers the weeks the schedule is built on,
 * and semesters.start_date anchors the dates the hour counter walks. They are
 * the same real-world fact, so letting them drift apart means the schedule and
 * the hours silently count by different week numbering — a teacher's total
 * would stop matching the timetable it was derived from. Every write to either
 * one goes through here so they move together.
 */
function syncSemesterStartDate(db, startDate) {
    db.prepare(`
        INSERT INTO settings (key, value) VALUES ('semester_start_date', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(startDate);

    db.prepare('UPDATE semesters SET start_date = ? WHERE is_active = 1').run(startDate);
}

function pluralizePlanRows(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'строка';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'строки';
    return 'строк';
}

// One request can list many load_plan rows that share a group+semester —
// pass a shared Map so a listing doesn't recompute exception weeks once per
// row. Scoped to a single request by the caller (never module-level — the
// schedule can change between requests, and a stale cache would silently
// miscount hours until the process restarts).
function attachLoadProgress(db, planRow, exceptionWeeksCache = new Map()) {
    const semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(planRow.semester_id);

    if (!semester) {
        return { ...planRow, confirmed: Boolean(planRow.confirmed), progress: null };
    }

    const cacheKey = `${planRow.group_id}:${semester.id}`;
    let exceptionWeeks = exceptionWeeksCache.get(cacheKey);

    if (!exceptionWeeks) {
        const overrideRows = db.prepare(`
            SELECT specific_week FROM lessons
            WHERE group_id = ? AND specific_week IS NOT NULL
        `).all(planRow.group_id);
        exceptionWeeks = computeExceptionWeeks(overrideRows, semester.weeks_count);
        exceptionWeeksCache.set(cacheKey, exceptionWeeks);
    }

    const linkedLessons = db.prepare('SELECT * FROM lessons WHERE load_plan_id = ?').all(planRow.id);

    const progress = computeLoadProgress({
        semesterStartDate: semester.start_date,
        weeksCount: semester.weeks_count,
        linkedLessons,
        exceptionWeeks
    });

    return {
        ...planRow,
        confirmed: Boolean(planRow.confirmed),
        progress: {
            occurred_hours: progress.occurred_hours,
            occurred_count: progress.occurred_count,
            planned_hours: planRow.planned_hours,
            remaining_hours: planRow.planned_hours === null ? null : Math.max(0, planRow.planned_hours - progress.occurred_hours)
        }
    };
}

function getClientAddress(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function mapAuditLogRow(row) {
    return {
        id: row.id,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        ip_address: row.ip_address,
        created_at: row.created_at,
        admin_username: row.admin_username,
        details: parseAuditDetails(row.details)
    };
}

function parseAuditDetails(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function getAuditLogs(limitValue, maxLimit) {
    const db = getDb();
    const limit = parsePositiveInteger(limitValue, 'Параметр limit', 1, maxLimit);
    const rows = db.prepare(`
        SELECT al.id, al.action, al.entity_type, al.entity_id, al.ip_address, al.details, al.created_at,
               a.username AS admin_username
        FROM audit_logs al
        LEFT JOIN admins a ON a.id = al.admin_id
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ?
    `).all(limit);

    return rows.map(mapAuditLogRow);
}

function parsePositiveInteger(value, label, min, max) {
    const normalized = value === undefined ? min : Number.parseInt(value, 10);

    if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
        const error = new Error(`${label} должен быть числом от ${min} до ${max}`);
        error.statusCode = 400;
        throw error;
    }

    return normalized;
}

function buildAuditCsv(logs) {
    const header = ['id', 'created_at', 'admin_username', 'action', 'entity_type', 'entity_id', 'ip_address', 'details'];
    const rows = logs.map((log) => ([
        log.id,
        log.created_at || '',
        log.admin_username || '',
        log.action || '',
        log.entity_type || '',
        log.entity_id || '',
        log.ip_address || '',
        log.details ? JSON.stringify(log.details) : ''
    ]));

    return [header, ...rows]
        .map((row) => row.map(escapeCsvCell).join(','))
        .join('\n');
}

function escapeCsvCell(value) {
    const normalized = String(value ?? '');
    const escaped = normalized.replaceAll('"', '""');
    return `"${escaped}"`;
}

function formatTimestampForFileName(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

module.exports = router;
