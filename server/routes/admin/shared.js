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
 * would stop matching the timetable it was derived from. The semester is the
 * only place the date is edited (Settings no longer offers it: there it moved
 * every week with no preview, closed semesters included); the setting follows.
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

/**
 * An event (линейка, кураторский час) is shown but is nobody's teaching: it
 * keeps only its title, never a teacher, discipline or type, whatever the
 * client sent — so it can never match a plan row and count.
 */
function forKind(kind, identity, lessonType, title) {
    return kind === 'event'
        ? { identity: { teacherId: null, teacher: null, disciplineId: null, discipline: title }, lessonType: null }
        : { identity, lessonType };
}

/**
 * Refusal body for a pair placed in a week after the semester's last one, or
 * null. Students would see such a pair while the hour counter (weeks 1 to
 * weeks_count) silently skipped it; the constructor answers this by offering
 * to extend the semester to that week, after which the pair counts.
 */
function weekBeyondSemesterError(semester, weekNumber) {
    if (weekNumber === null || weekNumber === undefined || !Number.isInteger(semester.weeks_count) || weekNumber <= semester.weeks_count) {
        return null;
    }

    return {
        error: `Это ${weekNumber}-я неделя, а семестр «${semester.label}» — до ${semester.weeks_count}-й. Пара после последней недели не засчитывалась бы в часы: сначала продлите семестр.`,
        needs_extension: true,
        semester_id: semester.id,
        weeks_count: semester.weeks_count,
        weeks_needed: weekNumber
    };
}

const NO_WORKING_SEMESTER = 'Сначала создайте семестр в разделе «Нагрузка» — расписание ведётся внутри семестра';

function getClientAddress(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function referenceError(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

/**
 * The single place a schedule pair's teacher/discipline get resolved.
 *
 * Given optional teacher_id/discipline_id, looks each one up and returns the
 * dictionary's OWN current text alongside it — the app never trusts text sent
 * by the client once an id is given, so the schedule and the load plan can
 * never show the same person under two different spellings. No id at all is
 * a valid, ordinary case (kind='event', or a one-off nobody wants to track):
 * the row keeps whatever text was typed and simply never matches any plan
 * row's hours.
 *
 * Throws (404) if an id is given but doesn't resolve — a deleted or
 * mistyped id must never silently fall back to free text.
 */
function resolveTeacherDiscipline(db, { teacherId, teacherText, disciplineId, disciplineText }) {
    let teacher = teacherText ?? null;

    if (teacherId != null) {
        const row = db.prepare('SELECT full_name FROM teachers WHERE id = ?').get(teacherId);
        if (!row) throw referenceError('Преподаватель не найден');
        teacher = row.full_name;
    }

    let discipline = disciplineText ?? null;

    if (disciplineId != null) {
        const row = db.prepare('SELECT name FROM disciplines WHERE id = ?').get(disciplineId);
        if (!row) throw referenceError('Дисциплина не найдена');
        discipline = row.name;
    }

    return { teacherId: teacherId ?? null, teacher, disciplineId: disciplineId ?? null, discipline };
}

module.exports = {
    mapSemesterRow,
    syncSemesterStartDate,
    SEMESTER_CLOSED,
    findClosedSemester,
    forKind,
    NO_WORKING_SEMESTER,
    getClientAddress,
    resolveTeacherDiscipline,
    weekBeyondSemesterError
};
