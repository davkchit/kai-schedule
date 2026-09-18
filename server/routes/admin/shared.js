// Helpers used by more than one admin route file. Each is used exactly as it
// was before the split; single-use helpers live next to their only caller.

const { resolveFirstWeekParity } = require('../../utils/date');
const { getActiveSemester } = require('../../utils/semesters');

function mapSemesterRow(row) {
    // Never hands out the 0 "not stated" marker — callers always see the parity
    // week 1 actually resolves to.
    return {
        ...row,
        is_active: Boolean(row.is_active),
        first_week_parity: resolveFirstWeekParity(row),
        closed: Boolean(row.closed_at)
    };
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

    // Exactly one row: the working semester. (The database allows at most one
    // active semester, but updating by id keeps this correct regardless.)
    const working = getActiveSemester(db);
    if (working) {
        db.prepare('UPDATE semesters SET start_date = ? WHERE id = ?').run(startDate, working.id);
    }
}

const SEMESTER_CLOSED = 'Семестр закрыт — его расписание и часы зафиксированы. Чтобы вносить изменения, откройте его заново в разделе «Нагрузка».';

/**
 * Returns the semester if it is closed, so the caller can refuse the write.
 * Every path that can change a lesson, a plan row or the semester's own dates
 * goes through this: after closing, the reported hours are a stored snapshot,
 * and letting the underlying data drift away from them is exactly the silent
 * inconsistency closing exists to prevent.
 */
function findClosedSemester(db, semesterId) {
    if (!semesterId) {
        return null;
    }

    const semester = db.prepare('SELECT id, label, closed_at FROM semesters WHERE id = ?').get(semesterId);

    return semester && semester.closed_at ? semester : null;
}

const NO_WORKING_SEMESTER = 'Сначала создайте семестр в разделе «Нагрузка» — расписание ведётся внутри семестра';

function getClientAddress(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

module.exports = {
    mapSemesterRow,
    syncSemesterStartDate,
    SEMESTER_CLOSED,
    findClosedSemester,
    NO_WORKING_SEMESTER,
    getClientAddress
};
