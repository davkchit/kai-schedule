const express = require('express');
const { getDb } = require('../db');
const { addDaysToIsoDate, formatLocalDate, getSemesterWeekMeta, resolveFirstWeekParity } = require('../utils/date');
const { computePlanRowProgress } = require('../utils/planProgress');
const { getActiveSemester, getSemesterById, getSemesterForDate, getSemestersOverlapping } = require('../utils/semesters');

const router = express.Router();
const DEFAULT_SCHEDULE_RANGE_DAYS = 28;
const MAX_SCHEDULE_RANGE_DAYS = 60;

router.get('/universities', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT id, name, short_name FROM universities ORDER BY short_name').all();
    res.json(rows);
});

router.get('/universities/:id/groups', (req, res) => {
    const db = getDb();
    const uniId = Number(req.params.id);

    if (!Number.isInteger(uniId) || uniId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID университета' });
    }

    const university = db.prepare('SELECT id FROM universities WHERE id = ?').get(uniId);

    if (!university) {
        return res.status(404).json({ error: 'Университет не найден' });
    }

    const rows = db.prepare(
        'SELECT id, name FROM groups_ WHERE university_id = ? ORDER BY name'
    ).all(uniId);

    res.json(rows);
});

router.get('/schedule/:groupId', (req, res) => {
    const db = getDb();
    const groupId = Number(req.params.groupId);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID группы' });
    }

    const group = db.prepare('SELECT id, name, university_id FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    let subgroup;

    try {
        subgroup = parseSubgroupQuery(req.query.subgroup);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    let rangeDays;

    try {
        rangeDays = parseScheduleRangeDays(req.query.days);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const dateStr = typeof req.query.date === 'string' ? req.query.date : formatLocalDate();
    let rangeEndDate;

    try {
        rangeEndDate = addDaysToIsoDate(dateStr, rangeDays - 1);
    } catch {
        return res.status(400).json({ error: 'Некорректная дата. Ожидается формат YYYY-MM-DD' });
    }

    // Every day is resolved against the semester in effect ON THAT DAY, not
    // against whichever semester the admin has open. A view that crosses the
    // February rollover gets both semesters, and each lesson is tagged with its
    // own, so the page never reads an autumn row's "week 1" as spring's week 1.
    const semesters = getSemestersOverlapping(db, dateStr, rangeEndDate);
    const primary = semesters.find((semester) => semester.start_date <= dateStr) || semesters[0] || null;

    let sql = `
        SELECT id, semester_id, subgroup, day_of_week, week_type, specific_week,
               template_from_week, is_removed,
               time_start, time_end, subject, room, lesson_type, teacher, sort_order, kind
        FROM lessons
        WHERE group_id = ? AND semester_id = ?
          AND (specific_week IS NULL OR specific_week BETWEEN ? AND ?)
    `;

    if (subgroup === 1 || subgroup === 2) {
        sql += ' AND (subgroup = 0 OR subgroup = ?)';
    }

    sql += ' ORDER BY day_of_week, sort_order, time_start';
    const statement = db.prepare(sql);

    const lessons = [];
    semesters.forEach((semester, index) => {
        // Only the part of the requested range this semester actually covers:
        // from the later of (range start, semester start) to the day before the
        // next semester begins, or the range end. Its per-week rows outside
        // that window are someone else's calendar weeks and are left out.
        const portionStart = semester.start_date > dateStr ? semester.start_date : dateStr;
        const next = semesters[index + 1];
        const portionEnd = next && addDaysToIsoDate(next.start_date, -1) < rangeEndDate
            ? addDaysToIsoDate(next.start_date, -1)
            : rangeEndDate;
        const weekFrom = getSemesterWeekMeta(semester, portionStart).weekNumber;
        const weekTo = getSemesterWeekMeta(semester, portionEnd).weekNumber;

        const params = [groupId, semester.id, weekFrom, weekTo];
        if (subgroup === 1 || subgroup === 2) {
            params.push(subgroup);
        }
        lessons.push(...statement.all(...params));
    });

    const byDay = {};
    for (const lesson of lessons) {
        (byDay[lesson.day_of_week] ||= []).push(lesson);
    }

    // Legacy fields, describing the requested date within its own semester —
    // kept so an already-cached older copy of the page still renders.
    const primaryMeta = primary && primary.start_date <= dateStr ? getSemesterWeekMeta(primary, dateStr) : null;
    const primaryExceptionWeeks = primary
        ? [...new Set(lessons
            .filter((lesson) => lesson.semester_id === primary.id && lesson.specific_week != null)
            .map((lesson) => lesson.specific_week))].sort((left, right) => left - right)
        : [];

    res.json({
        group: { id: group.id, name: group.name },
        semesters: semesters.map((semester) => ({
            id: semester.id,
            label: semester.label,
            start_date: semester.start_date,
            weeks_count: semester.weeks_count,
            first_week_parity: resolveFirstWeekParity(semester)
        })),
        week_number: primaryMeta ? primaryMeta.weekNumber : null,
        week_type: primaryMeta ? primaryMeta.weekType : null,
        week_type_label: primaryMeta ? primaryMeta.weekTypeLabel : null,
        semester_start: primary ? primary.start_date : null,
        requested_date: dateStr,
        range_days: rangeDays,
        range_end: rangeEndDate,
        exception_weeks: primaryExceptionWeeks,
        lessons,
        by_day: byDay
    });
});

// Public, read-only — mirrors the group search on the welcome page.
// Teachers get no login/role: this is how they find themselves.
router.get('/teachers/search', (req, res) => {
    const db = getDb();
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (!query) {
        return res.json([]);
    }

    // Filtered in JS, not SQL: SQLite's LIKE/LOWER() only case-fold ASCII —
    // "Хамидуллин" would never match "хамидул" under COLLATE NOCASE. The
    // teachers table is small (a department's worth of names), so a full
    // scan with a proper Unicode-aware toLowerCase() is simpler and correct,
    // rather than reaching for an ICU-enabled SQLite build.
    const normalizedQuery = query.toLowerCase();
    const rows = db.prepare('SELECT id, full_name FROM teachers ORDER BY full_name')
        .all()
        .filter((row) => row.full_name.toLowerCase().includes(normalizedQuery))
        .slice(0, 20);

    res.json(rows);
});

// Public, read-only list of semesters, newest first — lets a teacher switch
// back to a finished semester and still show its totals.
router.get('/semesters', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT id, label, start_date, weeks_count FROM semesters ORDER BY start_date DESC').all();
    res.json(rows);
});

// Public, read-only. Returns the given teacher's load plan for the semester in
// effect today (or a specific one via ?semester_id=), each row with computed
// progress — this is the "4/36" view a teacher checks themselves.
router.get('/teachers/:id/load', (req, res) => {
    const db = getDb();
    const teacherId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID преподавателя' });
    }

    const teacher = db.prepare('SELECT id, full_name FROM teachers WHERE id = ?').get(teacherId);

    if (!teacher) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    let semester;

    if (req.query.semester_id) {
        const semesterId = Number.parseInt(req.query.semester_id, 10);

        if (!Number.isInteger(semesterId) || semesterId <= 0) {
            return res.status(400).json({ error: 'Некорректный semester_id' });
        }

        semester = getSemesterById(db, semesterId);

        if (!semester) {
            return res.status(404).json({ error: 'Семестр не найден' });
        }
    } else {
        // The semester in effect today — never the one the specialist happens to
        // have open. Building spring's plan in January must not make a teacher's
        // autumn totals vanish from this page while autumn is still running.
        semester = getSemesterForDate(db, formatLocalDate()) || getActiveSemester(db);
    }

    if (!semester) {
        return res.json({ teacher, semester: null, plan: [] });
    }

    const planRows = db.prepare(`
        SELECT lp.*, d.name AS discipline_name, g.name AS group_name
        FROM load_plan lp
        JOIN disciplines d ON d.id = lp.discipline_id
        JOIN groups_ g ON g.id = lp.group_id
        WHERE lp.teacher_id = ? AND lp.semester_id = ?
        ORDER BY d.name, lp.lesson_type, g.name
    `).all(teacherId, semester.id);

    const progressCache = new Map();

    const plan = planRows.map((row) => {
        const progress = computePlanRowProgress(db, row, semester, { cache: progressCache });

        return {
            id: row.id,
            discipline_name: row.discipline_name,
            lesson_type: row.lesson_type,
            group_name: row.group_name,
            subgroup: row.subgroup,
            confirmed: Boolean(row.confirmed),
            planned_hours: row.planned_hours,
            occurred_hours: progress.occurred_hours,
            remaining_hours: row.planned_hours === null ? null : Math.max(0, row.planned_hours - progress.occurred_hours),
            occurrences: progress.occurrences
        };
    });

    res.json({
        teacher,
        semester: { id: semester.id, label: semester.label },
        plan
    });
});

function parseSubgroupQuery(value) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }

    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed) || ![0, 1, 2].includes(parsed)) {
        const error = new Error('Параметр subgroup должен быть 0, 1 или 2');
        error.statusCode = 400;
        throw error;
    }

    return parsed;
}

function parseScheduleRangeDays(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_SCHEDULE_RANGE_DAYS;
    }

    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SCHEDULE_RANGE_DAYS) {
        const error = new Error(`Параметр days должен быть числом от 1 до ${MAX_SCHEDULE_RANGE_DAYS}`);
        error.statusCode = 400;
        throw error;
    }

    return parsed;
}

module.exports = router;
