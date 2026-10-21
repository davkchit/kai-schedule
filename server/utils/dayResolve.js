// What a group has on one calendar date, resolved on the server exactly the
// way the student page resolves it (src/lib/scheduleResolve.js): the semester
// in effect that day, a week with its own rows replaces the template entirely,
// nothing past the semester's last teaching week, template versions by
// template_from_week. tests/dayResolve.parity.test.js holds the two together
// for every group and every day of a semester.
//
// Callers: the Alice skill (routes/alice.js) and the session clash checks
// (utils/attestationConflicts.js).

const { getSemesterForDate } = require('./semesters');
const { getSemesterWeekMeta } = require('./date');
const { resolveTemplateLessons } = require('./templateResolve');

function weekdayOf(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

/**
 * The teaching rows of the group's own schedule (pass the schedule owner — a
 * joined group's leader, see scheduleGroupId) shown on isoDate.
 * `lessonsOf(groupId, semesterId)` may be given to share one query per group
 * across many dates.
 */
function resolveGroupLessons(db, groupId, isoDate, { lessonsOf = null, semesterFor = null } = {}) {
    const semester = semesterFor ? semesterFor(isoDate) : getSemesterForDate(db, isoDate);

    if (!semester) {
        return { semester: null, lessons: [] };
    }

    const all = lessonsOf
        ? lessonsOf(groupId, semester.id)
        : db.prepare('SELECT * FROM lessons WHERE group_id = ? AND semester_id = ?').all(groupId, semester.id);
    const { weekNumber, weekTypeNumber } = getSemesterWeekMeta(semester, isoDate);
    const weekday = weekdayOf(isoDate);
    const onDay = all.filter((lesson) => lesson.day_of_week === weekday);
    let lessons;

    if (all.some((lesson) => lesson.specific_week === weekNumber)) {
        lessons = onDay.filter((lesson) => lesson.specific_week === weekNumber && !lesson.is_removed);
    } else if (Number.isInteger(semester.weeks_count) && weekNumber > semester.weeks_count) {
        lessons = [];
    } else {
        lessons = resolveTemplateLessons(onDay.filter((lesson) => lesson.specific_week == null
            && (lesson.week_type === 0 || lesson.week_type === weekTypeNumber)), weekNumber);
    }

    return { semester, weekNumber, lessons: sortByTime(lessons) };
}

function sortByTime(items) {
    return [...items].sort((left, right) => (left.time_start || '').localeCompare(right.time_start || '')
        || (left.sort_order ?? 0) - (right.sort_order ?? 0));
}

module.exports = { resolveGroupLessons, sortByTime, weekdayOf };
