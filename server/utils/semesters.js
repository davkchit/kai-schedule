const { addDaysToIsoDate } = require('./date');

/**
 * Every lesson belongs to exactly one semester, and its week numbers
 * (specific_week, template_from_week) only mean something relative to THAT
 * semester's start date. These helpers answer "which semester" for the three
 * different questions the app asks, which must not be confused with each other:
 *
 *   getActiveSemester   — the one the specialist is currently editing in the
 *                         constructor. An admin working choice; it never
 *                         decides what students or teachers see.
 *   getSemesterForDate  — the one in effect on a calendar date. What a student
 *                         opening the schedule for that date, or a teacher
 *                         checking hours "as of today", is actually looking at.
 *   getSemestersOverlapping — every semester a date range touches, so a view
 *                         spanning the February rollover resolves each day
 *                         against its own semester.
 */

function getActiveSemester(db) {
    return db.prepare('SELECT * FROM semesters WHERE is_active = 1 ORDER BY start_date DESC LIMIT 1').get()
        || db.prepare('SELECT * FROM semesters ORDER BY start_date DESC LIMIT 1').get()
        || null;
}

function getSemesterForDate(db, isoDate) {
    return db.prepare('SELECT * FROM semesters WHERE start_date <= ? ORDER BY start_date DESC, id DESC LIMIT 1').get(isoDate)
        || null;
}

function getSemestersOverlapping(db, fromIsoDate, toIsoDate) {
    const inEffectAtStart = getSemesterForDate(db, fromIsoDate);
    const startingInside = db.prepare(`
        SELECT * FROM semesters WHERE start_date > ? AND start_date <= ? ORDER BY start_date ASC, id ASC
    `).all(fromIsoDate, toIsoDate);

    return [inEffectAtStart, ...startingInside].filter(Boolean);
}

function getSemesterById(db, semesterId) {
    return db.prepare('SELECT * FROM semesters WHERE id = ?').get(semesterId) || null;
}

/**
 * Another semester whose teaching weeks share a day with these, or null.
 *
 * A semester's days run until the next one starts (getSemesterForDate), so a
 * second semester starting inside the first one's weeks silently takes those
 * weeks over: a spring typed with an October date emptied autumn for students
 * and the teacher page the moment it was saved, while autumn's hours still
 * counted. Each semester has to start after the other's last teaching week;
 * the gap between them (сессия, каникулы) stays with the earlier one.
 */
function findOverlappingSemester(db, { id = null, start_date: startDate, weeks_count: weeksCount }) {
    const end = addDaysToIsoDate(startDate, weeksCount * 7);

    return db.prepare('SELECT * FROM semesters WHERE id != ? ORDER BY start_date').all(id ?? 0)
        .find((other) => startDate < addDaysToIsoDate(other.start_date, other.weeks_count * 7) && other.start_date < end)
        || null;
}

/** Refusal text for findOverlappingSemester's result. */
function overlappingSemesterError(other) {
    const format = (iso) => iso.split('-').reverse().join('.');
    const lastDay = addDaysToIsoDate(other.start_date, other.weeks_count * 7 - 1);

    return `Даты пересекаются с семестром «${other.label}» (${format(other.start_date)} – ${format(lastDay)}, ${other.weeks_count} нед.). `
        + 'Семестр должен начинаться после последней учебной недели другого — проверьте дату начала и число недель.';
}

/** The Monday of week N of a semester. */
function semesterWeekMonday(semester, weekNumber) {
    return addDaysToIsoDate(semester.start_date, (weekNumber - 1) * 7);
}

module.exports = {
    findOverlappingSemester,
    getActiveSemester,
    overlappingSemesterError,
    getSemesterById,
    getSemesterForDate,
    getSemestersOverlapping,
    semesterWeekMonday
};
