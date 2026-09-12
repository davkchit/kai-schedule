const express = require('express');
const { getDb } = require('../db');
const { addDaysToIsoDate, formatLocalDate, getWeekMeta } = require('../utils/date');
const { computeExceptionWeeks, computeLoadProgress } = require('../utils/loadCalc');

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
    const semesterStartRow = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    const semesterStart = semesterStartRow ? semesterStartRow.value : '2026-02-09';
    let weekMeta;
    let rangeEndDate;
    let rangeEndWeekMeta;

    try {
        weekMeta = getWeekMeta(semesterStart, dateStr);
        rangeEndDate = addDaysToIsoDate(dateStr, rangeDays - 1);
        rangeEndWeekMeta = getWeekMeta(semesterStart, rangeEndDate);
    } catch {
        return res.status(400).json({ error: 'Некорректная дата. Ожидается формат YYYY-MM-DD' });
    }

    let sql = `
        SELECT id, subgroup, day_of_week, week_type, specific_week,
               template_from_week, is_removed,
               time_start, time_end, subject, room, lesson_type, teacher, sort_order
        FROM lessons
        WHERE group_id = ?
    `;
    const params = [groupId];

    if (subgroup === 1 || subgroup === 2) {
        sql += ' AND (subgroup = 0 OR subgroup = ?)';
        params.push(subgroup);
    }

    sql += ' AND (specific_week IS NULL OR (specific_week BETWEEN ? AND ?))';
    params.push(weekMeta.weekNumber, rangeEndWeekMeta.weekNumber);

    sql += ' ORDER BY day_of_week, sort_order, time_start';

    const lessons = db.prepare(sql).all(...params);
    const byDay = {};
    const exceptionWeeks = new Set();

    for (const lesson of lessons) {
        if (!byDay[lesson.day_of_week]) {
            byDay[lesson.day_of_week] = [];
        }

        if (lesson.specific_week !== null && lesson.specific_week !== undefined) {
            exceptionWeeks.add(lesson.specific_week);
        }

        byDay[lesson.day_of_week].push(lesson);
    }

    res.json({
        group: { id: group.id, name: group.name },
        week_number: weekMeta.weekNumber,
        week_type: weekMeta.weekType,
        week_type_label: weekMeta.weekTypeLabel,
        semester_start: semesterStart,
        requested_date: dateStr,
        range_days: rangeDays,
        range_end: rangeEndDate,
        exception_weeks: Array.from(exceptionWeeks).sort((left, right) => left - right),
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

// Public, read-only. Returns the given teacher's load plan for the active
// semester (or a specific one via ?semester_id=), each row with computed
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

        semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);
    } else {
        semester = db.prepare('SELECT * FROM semesters WHERE is_active = 1 ORDER BY start_date DESC LIMIT 1').get();
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

    const exceptionWeeksCache = new Map();

    const plan = planRows.map((row) => {
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
