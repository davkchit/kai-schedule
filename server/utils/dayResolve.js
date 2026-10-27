// What a group has on one calendar date, resolved on the server exactly the
// way the student page resolves it (src/lib/scheduleResolve.js): the semester
// in effect that day, and only a week entered as its own — the template is the
// specialist's draft in the constructor, never shown and never counted.
// tests/dayResolve.parity.test.js holds the two together for every group and
// every day of a semester.
//
// Callers: the Alice skill (routes/alice.js), the session clash checks
// (utils/attestationConflicts.js) and the Excel export.

const { getSemesterForDate } = require('./semesters');
const { getSemesterWeekMeta } = require('./date');

function weekdayOf(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

/**
 * The teaching rows of the group's own schedule (pass the schedule owner — a
 * joined group's leader, see scheduleGroupId) shown on isoDate.
 * `lessonsOf(groupId, semesterId)` may be given to share one query per group
 * across many dates.
 *
 * `status`: 'entered' — the week has rows of its own; 'not_entered' — a
 * teaching week nobody has entered yet (shown as «Расписание не внесено»);
 * 'none' — outside the teaching weeks (session, holidays) or any semester.
 */
function resolveGroupLessons(db, groupId, isoDate, { lessonsOf = null, semesterFor = null } = {}) {
    const semester = semesterFor ? semesterFor(isoDate) : getSemesterForDate(db, isoDate);

    if (!semester) {
        return { semester: null, lessons: [], status: 'none' };
    }

    const all = lessonsOf
        ? lessonsOf(groupId, semester.id)
        : db.prepare('SELECT * FROM lessons WHERE group_id = ? AND semester_id = ?').all(groupId, semester.id);
    const { weekNumber } = getSemesterWeekMeta(semester, isoDate);
    const weekday = weekdayOf(isoDate);

    if (all.some((lesson) => lesson.specific_week === weekNumber)) {
        const lessons = all.filter((lesson) => lesson.specific_week === weekNumber && lesson.day_of_week === weekday && !lesson.is_removed);
        return { semester, weekNumber, lessons: sortByTime(lessons), status: 'entered' };
    }

    const teaching = weekNumber >= 1 && (!Number.isInteger(semester.weeks_count) || weekNumber <= semester.weeks_count);
    return { semester, weekNumber, lessons: [], status: teaching ? 'not_entered' : 'none' };
}

function sortByTime(items) {
    return [...items].sort((left, right) => (left.time_start || '').localeCompare(right.time_start || '')
        || (left.sort_order ?? 0) - (right.sort_order ?? 0));
}

module.exports = { resolveGroupLessons, sortByTime, weekdayOf };
