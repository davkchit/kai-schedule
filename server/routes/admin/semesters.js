// Semesters: create, edit dates, activate, close / reopen, impact preview, unconfirmed weeks.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const {
    addDaysToIsoDate,
    defaultFirstWeekParity,
    formatLocalDate,
    getSemesterWeekMeta,
    isValidIsoDate,
    resolveFirstWeekParity
} = require('../../utils/date');
const { computePlanRowProgress } = require('../../utils/planProgress');
const { getActiveSemester } = require('../../utils/semesters');
const { validateSemesterCreateBody, validateSemesterUpdateBody } = require('../../validation');
const {
    mapSemesterRow,
    syncSemesterStartDate,
    SEMESTER_CLOSED,
    getClientAddress
} = require('./shared');

const router = express.Router();

/**
 * Dry run for "what happens to everyone's hours if I change the semester's
 * start date or length". Both settings silently re-derive every teacher's
 * total — start_date moves every lesson date, weeks_count is the ceiling the
 * counter stops at — so the UI asks this first and shows the damage before
 * writing anything. Computes only, never writes.
 */
/**
 * Weeks that have already finished without anyone entering what actually
 * happened in them — the hours for those weeks were taken from the template.
 *
 * The system cannot tell "the week really did go by the template" from "we
 * forgot about that week": both look like a week with no rows of its own. So
 * it says which weeks those are and lets the person who was there decide —
 * especially before closing the semester, where the number becomes final.
 */
function findUnconfirmedWeeks(db, semester) {
    const currentWeek = getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;
    const lastFinishedWeek = Math.min(currentWeek - 1, semester.weeks_count);

    if (lastFinishedWeek < 1) {
        return { current_week: currentWeek, unconfirmed_weeks: [] };
    }

    const weeksWithOwnRows = new Set(
        db.prepare(`
            SELECT DISTINCT specific_week FROM lessons
            WHERE semester_id = ? AND specific_week IS NOT NULL
        `).all(semester.id).map((row) => row.specific_week)
    );

    const unconfirmed = [];

    for (let week = 1; week <= lastFinishedWeek; week += 1) {
        if (!weeksWithOwnRows.has(week)) {
            unconfirmed.push(week);
        }
    }

    return { current_week: currentWeek, unconfirmed_weeks: unconfirmed };
}

router.get('/semesters/:id/week-coverage', (req, res) => {
    const semesterId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(semesterId) || semesterId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID семестра' });
    }

    const db = getDb();
    const semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    const coverage = findUnconfirmedWeeks(db, semester);

    res.json({ ...coverage, weeks_count: semester.weeks_count });
});

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
    // Flipping which week is нечётная swaps every template pair onto the other
    // weeks — as much a re-derivation of past hours as moving the start date.
    const nextParity = req.query.first_week_parity
        ? Number.parseInt(req.query.first_week_parity, 10)
        : resolveFirstWeekParity(semester);

    if (!isValidIsoDate(nextStartDate)) {
        return res.status(400).json({ error: 'Некорректная дата начала' });
    }

    if (!Number.isInteger(nextWeeksCount) || nextWeeksCount < 1 || nextWeeksCount > 52) {
        return res.status(400).json({ error: 'Некорректное число недель' });
    }

    if (nextParity !== 1 && nextParity !== 2) {
        return res.status(400).json({ error: 'Некорректная чётность первой недели' });
    }

    const planRows = db.prepare(`
        SELECT lp.id, lp.group_id, lp.teacher_id, lp.discipline_id, lp.lesson_type, lp.subgroup, t.full_name AS teacher_name
        FROM load_plan lp JOIN teachers t ON t.id = lp.teacher_id
        WHERE lp.semester_id = ?
    `).all(semesterId);

    const progressCache = new Map();
    const changedTeachers = new Set();
    let hoursBefore = 0;
    let hoursAfter = 0;
    let changedRows = 0;

    for (const row of planRows) {
        const before = computePlanRowProgress(db, row, semester, { cache: progressCache }).occurred_hours;
        const after = computePlanRowProgress(db, row, semester, {
            cache: progressCache,
            overrides: { start_date: nextStartDate, weeks_count: nextWeeksCount, first_week_parity: nextParity }
        }).occurred_hours;

        hoursBefore += before;
        hoursAfter += after;

        if (before !== after) {
            changedRows += 1;
            changedTeachers.add(row.teacher_name);
        }
    }

    res.json({
        current: { start_date: semester.start_date, weeks_count: semester.weeks_count, first_week_parity: resolveFirstWeekParity(semester) },
        proposed: { start_date: nextStartDate, weeks_count: nextWeeksCount, first_week_parity: nextParity },
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
        INSERT INTO semesters (label, start_date, weeks_count, is_active, first_week_parity)
        VALUES (?, ?, ?, 0, ?)
    `).run(
        payload.label,
        payload.start_date,
        payload.weeks_count,
        // Read off the header of the semester's first published week sheet;
        // only when not given does the calendar rule stand in for it.
        payload.first_week_parity ?? defaultFirstWeekParity(payload.start_date)
    );
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

    if (existing.closed_at) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
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
            SET label = ?, start_date = ?, weeks_count = ?, is_active = ?, first_week_parity = ?
            WHERE id = ?
        `).run(
            next.label, next.start_date, next.weeks_count, next.is_active ? 1 : 0,
            resolveFirstWeekParity(next), semesterId
        );

        // Whichever semester is now the active one dictates the date the
        // schedule numbers its weeks from — see syncSemesterStartDate.
        const active = getActiveSemester(db);
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

// Closing is what makes a printed report trustworthy: after it, the semester's
// hours are a stored number rather than a live calculation, and nothing in that
// semester can be edited without deliberately reopening it first.
router.post('/semesters/:id/close', (req, res) => {
    const semesterId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(semesterId) || semesterId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID семестра' });
    }

    const db = getDb();
    const semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    if (semester.closed_at) {
        return res.status(409).json({ error: 'Этот семестр уже закрыт' });
    }

    const planRows = db.prepare('SELECT * FROM load_plan WHERE semester_id = ?').all(semesterId);
    const { unconfirmed_weeks: unconfirmedWeeks } = findUnconfirmedWeeks(db, semester);
    const closedAt = formatLocalDate();
    const cache = new Map();
    let totalHours = 0;

    const transaction = db.transaction(() => {
        const storeFinal = db.prepare('UPDATE load_plan SET final_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');

        for (const row of planRows) {
            const hours = computePlanRowProgress(db, row, semester, { cache }).occurred_hours;
            storeFinal.run(hours, row.id);
            totalHours += hours;
        }

        db.prepare('UPDATE semesters SET closed_at = ? WHERE id = ?').run(closedAt, semesterId);
    });

    transaction();

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'semester.close',
        entityType: 'semester',
        entityId: semesterId,
        ipAddress: getClientAddress(req),
        details: {
            closed_at: closedAt,
            plan_rows: planRows.length,
            total_hours: totalHours,
            // Recorded as it was at closing: if a total is questioned later,
            // this says which weeks were counted from the template.
            unconfirmed_weeks: unconfirmedWeeks
        }
    });

    const updated = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    res.json({
        ...mapSemesterRow(updated),
        plan_rows: planRows.length,
        total_hours: totalHours,
        unconfirmed_weeks: unconfirmedWeeks
    });
});

router.post('/semesters/:id/reopen', (req, res) => {
    const semesterId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(semesterId) || semesterId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID семестра' });
    }

    const db = getDb();
    const semester = db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId);

    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    if (!semester.closed_at) {
        return res.status(409).json({ error: 'Этот семестр и так открыт' });
    }

    // Dropping the stored totals is the point: an open semester's hours are
    // always what the schedule currently says, with no stale number hiding
    // behind them.
    db.transaction(() => {
        db.prepare('UPDATE load_plan SET final_hours = NULL WHERE semester_id = ?').run(semesterId);
        db.prepare('UPDATE semesters SET closed_at = NULL WHERE id = ?').run(semesterId);
    })();

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'semester.reopen',
        entityType: 'semester',
        entityId: semesterId,
        ipAddress: getClientAddress(req),
        details: { was_closed_at: semester.closed_at }
    });

    res.json(mapSemesterRow(db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId)));
});

module.exports = router;
