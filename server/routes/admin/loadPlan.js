// Load plan: plan rows and their hours, Excel report. Hours are matched live
// against the schedule by teacher/discipline/type/group/subgroup — see
// utils/planProgress.js — there is no separate linking step any more.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { buildLoadWorkbook } = require('../../exportLoad');
const { computePlanRowProgress } = require('../../utils/planProgress');
const { formatLocalDate, getSemesterWeekMeta } = require('../../utils/date');
const { getActiveSemester, getSemesterById } = require('../../utils/semesters');
const { resolveTemplateLessons } = require('../../utils/templateResolve');
const { validateLoadPlanCreateBody, validateLoadPlanUpdateBody } = require('../../validation');
const { SEMESTER_CLOSED, findClosedSemester, getClientAddress } = require('./shared');

const router = express.Router();

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

const identityKey = (row) => [row.teacher_id, row.discipline_id, row.lesson_type, row.group_id, row.subgroup].join('|');

/**
 * Pairs whose hours go nowhere. Matching is exact on all five identity
 * fields, so one wrong type or subgroup — or a teacher typed by hand instead
 * of picked from the dictionary — is enough for a pair to stop counting, and
 * nothing else in the app would say a word about it: the plan row just sits
 * at fewer hours than it should. This is the one place that names them.
 *
 * Only what the schedule actually shows counts as a problem: retired template
 * versions and removed pairs are nobody's hours. Events never count by design.
 */
router.get('/load-plan/unmatched', (req, res) => {
    const db = getDb();
    const raw = req.query.semester_id;
    let semester;

    if (raw === undefined || raw === '') {
        semester = getActiveSemester(db);
    } else {
        const semesterId = Number.parseInt(raw, 10);

        if (!Number.isInteger(semesterId) || semesterId <= 0) {
            return res.status(400).json({ error: 'Некорректный semester_id' });
        }

        semester = getSemesterById(db, semesterId);

        if (!semester) {
            return res.status(404).json({ error: 'Семестр не найден' });
        }
    }

    if (!semester) {
        return res.json({ semester_id: null, current_week: null, items: [] });
    }

    const currentWeek = Math.max(getSemesterWeekMeta(semester, formatLocalDate()).weekNumber, 1);
    // Removal markers are kept here: for a template pair, being retired IS a
    // row (a tombstone from some week), and resolving the versions without it
    // would show a pair the specialist has already taken out. Only a week's
    // own removed rows are left out below.
    const lessons = db.prepare(`
        SELECT l.*, g.name AS group_name
        FROM lessons l
        JOIN groups_ g ON g.id = l.group_id
        WHERE l.semester_id = ? AND l.kind = 'lesson'
    `).all(semester.id);

    const templatesByGroup = new Map();
    const shown = [];

    for (const lesson of lessons) {
        if (lesson.specific_week === null) {
            const candidates = templatesByGroup.get(lesson.group_id) || [];
            candidates.push(lesson);
            templatesByGroup.set(lesson.group_id, candidates);
        } else if (!lesson.is_removed) {
            shown.push(lesson);
        }
    }

    for (const candidates of templatesByGroup.values()) {
        shown.push(...resolveTemplateLessons(candidates, currentWeek));
    }

    const planned = new Set(db.prepare(`
        SELECT teacher_id, discipline_id, lesson_type, group_id, subgroup FROM load_plan WHERE semester_id = ?
    `).all(semester.id).map(identityKey));

    const byIdentity = new Map();

    for (const lesson of shown) {
        const untracked = !lesson.teacher_id || !lesson.discipline_id || !lesson.lesson_type;

        if (!untracked && planned.has(identityKey(lesson))) {
            continue;
        }

        const key = untracked
            ? `text|${lesson.group_id}|${lesson.subject}|${lesson.teacher}|${lesson.lesson_type}|${lesson.subgroup}`
            : identityKey(lesson);
        const entry = byIdentity.get(key);

        if (entry) {
            entry.lessons_count += 1;
            continue;
        }

        byIdentity.set(key, {
            group_id: lesson.group_id,
            group_name: lesson.group_name,
            subject: lesson.subject,
            teacher: lesson.teacher,
            lesson_type: lesson.lesson_type,
            subgroup: lesson.subgroup,
            // "Picked from the dictionary but no plan row" and "typed by hand"
            // are different mistakes: the first needs a plan row, the second
            // needs the pair re-picked from the list.
            reason: untracked ? 'not_in_dictionary' : 'no_plan_row',
            day_of_week: lesson.day_of_week,
            time_start: lesson.time_start,
            lessons_count: 1
        });
    }

    const items = [...byIdentity.values()].sort((a, b) =>
        a.group_name.localeCompare(b.group_name, 'ru')
        || (a.subject || '').localeCompare(b.subject || '', 'ru')
        || (a.lesson_type || '').localeCompare(b.lesson_type || '', 'ru'));

    res.json({ semester_id: semester.id, current_week: currentWeek, items });
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

    const progressCache = new Map();

    const rows = planRows.map((row) => {
        const progress = computePlanRowProgress(db, row, semester, { cache: progressCache });

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

    if (findClosedSemester(db, payload.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    const duplicate = findDuplicatePlanRow(db, payload);
    if (duplicate) {
        return res.status(409).json({ error: duplicatePlanRowError(duplicate) });
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

    if (findClosedSemester(db, existing.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
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

    // Nothing to detach any more: changing a row's group (or teacher,
    // discipline, type, subgroup) just makes it match a different set of
    // lessons on the next read — there is no stored link that could point
    // at the wrong group. The duplicate check right below is what actually
    // guards this write.
    const next = { ...existing, ...payload };

    const duplicate = findDuplicatePlanRow(db, next, planId);
    if (duplicate) {
        return res.status(409).json({ error: duplicatePlanRowError(duplicate) });
    }

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
    const existingPlan = db.prepare('SELECT id, semester_id FROM load_plan WHERE id = ?').get(planId);

    if (!existingPlan) {
        return res.status(404).json({ error: 'Строка плана не найдена' });
    }

    if (findClosedSemester(db, existingPlan.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    db.prepare('DELETE FROM load_plan WHERE id = ?').run(planId);

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

/**
 * The same teacher, discipline, type, group and subgroup twice in one semester
 * is always a slip: pairs get linked to one of the two rows, the other sits at
 * 0 hours forever and its planned hours inflate the totals in the report.
 */
function findDuplicatePlanRow(db, row, excludeId = null) {
    return db.prepare(`
        SELECT lp.id, t.full_name AS teacher_name, d.name AS discipline_name, g.name AS group_name
        FROM load_plan lp
        JOIN teachers t ON t.id = lp.teacher_id
        JOIN disciplines d ON d.id = lp.discipline_id
        JOIN groups_ g ON g.id = lp.group_id
        WHERE lp.semester_id = ? AND lp.teacher_id = ? AND lp.discipline_id = ? AND lp.lesson_type = ?
          AND lp.group_id = ? AND lp.subgroup = ? AND lp.id != ?
        LIMIT 1
    `).get(
        row.semester_id, row.teacher_id, row.discipline_id, row.lesson_type,
        row.group_id, row.subgroup ?? 0, excludeId ?? 0
    );
}

function duplicatePlanRowError(duplicate) {
    return `Такая строка уже есть в плане: ${duplicate.teacher_name} — ${duplicate.discipline_name}, группа ${duplicate.group_name}. Измените часы в ней.`;
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

    const progress = computePlanRowProgress(db, planRow, semester, { cache: exceptionWeeksCache });

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

module.exports = router;
