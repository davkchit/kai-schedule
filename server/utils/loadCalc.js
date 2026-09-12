const { addDaysToIsoDate, getWeekTypeNumber } = require('./date');
const { resolveTemplateLessons } = require('./templateResolve');

// 1 pair = 2 academic hours (2 × 45 min = 1.5 astronomical hours) — confirmed
// against the department's own planning figures (32 planned hours = 16 pairs).
const HOURS_PER_LESSON = 2;

/**
 * Which weeks (1..weeksCount) have ANY specific-week row for this group,
 * regardless of which load_plan (if any) those rows belong to. Mirrors the
 * "no merge" rule already used by the public schedule: once a week has its
 * own materialized rows, the template is ignored for that week entirely —
 * see resolveVisibleLessons in tests/server.test.js and buildScheduleDays in
 * SchedulePage.jsx for the same rule applied to what students see.
 */
function computeExceptionWeeks(groupLessons, weeksCount) {
    const exceptionWeeks = new Set();

    for (const lesson of groupLessons) {
        if (
            lesson.specific_week !== null &&
            lesson.specific_week !== undefined &&
            lesson.specific_week >= 1 &&
            lesson.specific_week <= weeksCount
        ) {
            exceptionWeeks.add(lesson.specific_week);
        }
    }

    return exceptionWeeks;
}

/**
 * For one load_plan row, walk every week of the semester and decide whether
 * that week's occurrence of the linked lesson happened, using the exact same
 * "override replaces the template, no merge" rule the public schedule uses.
 * Returns per-week detail (for the "show your work" breakdown teachers can
 * point to) plus the resulting hour total.
 *
 * @param {string} semesterStartDate - ISO date, the semester's week 1 Monday
 * @param {number} weeksCount - how many weeks the semester spans
 * @param {Array} linkedLessons - all lessons rows with load_plan_id === this plan's id
 *   (any mix of template versions and specific-week rows for this exact slot)
 * @param {Set<number>} exceptionWeeks - from computeExceptionWeeks, scoped to the group
 * @param {Date} [now] - injectable for tests; defaults to the real current time
 */
function computeLoadProgress({ semesterStartDate, weeksCount, linkedLessons, exceptionWeeks, now = new Date() }) {
    const occurrences = [];

    for (let weekNumber = 1; weekNumber <= weeksCount; weekNumber += 1) {
        const weekMonday = addDaysToIsoDate(semesterStartDate, (weekNumber - 1) * 7);
        const weekType = getWeekTypeNumber(weekMonday);
        let resolvedLessons;

        if (exceptionWeeks.has(weekNumber)) {
            // This plan's slots only occur this week if THEY were among the rows
            // materialized/kept for this specific week — an exception week with
            // no matching row for this plan means that lesson was removed (or
            // never carried into) that week's override set. is_removed is
            // checked here too: such a row is invisible in the schedule, so
            // counting it would bill hours for a pair nobody was shown.
            resolvedLessons = linkedLessons.filter(
                (lesson) => lesson.specific_week === weekNumber && !lesson.is_removed
            );
        } else {
            const templateCandidates = linkedLessons.filter(
                (lesson) => lesson.specific_week == null && (lesson.week_type === 0 || lesson.week_type === weekType)
            );
            resolvedLessons = resolveTemplateLessons(templateCandidates, weekNumber);
        }

        // One plan row routinely owns SEVERAL slots in the same week — a lecture
        // block is two consecutive pairs, and a language practical runs Mon and
        // Wed. Counting only the first would halve those rows' hours.
        for (const lesson of resolvedLessons) {
            const occurrenceDate = addDaysToIsoDate(weekMonday, lesson.day_of_week - 1);
            const occurrenceEndsAt = new Date(`${occurrenceDate}T${lesson.time_end}:00`);

            occurrences.push({
                week_number: weekNumber,
                date: occurrenceDate,
                lesson_id: lesson.id,
                time_start: lesson.time_start,
                time_end: lesson.time_end,
                has_occurred: occurrenceEndsAt.getTime() <= now.getTime()
            });
        }
    }

    occurrences.sort((left, right) => (
        left.date === right.date
            ? left.time_start.localeCompare(right.time_start)
            : left.date.localeCompare(right.date)
    ));

    const occurredCount = occurrences.filter((occurrence) => occurrence.has_occurred).length;

    return {
        occurrences,
        occurred_count: occurredCount,
        occurred_hours: occurredCount * HOURS_PER_LESSON
    };
}

module.exports = {
    HOURS_PER_LESSON,
    computeExceptionWeeks,
    computeLoadProgress
};
