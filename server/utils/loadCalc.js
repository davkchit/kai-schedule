const { addDaysToIsoDate } = require('./date');
const clock = require('./clock');

// 1 pair = 2 academic hours (2 × 45 min = 1.5 astronomical hours) — confirmed
// against the department's own planning figures (32 planned hours = 16 pairs).
const HOURS_PER_LESSON = 2;

/**
 * Which weeks (1..weeksCount) have ANY specific-week row for this group —
 * the weeks entered as their own, whichever plan rows (if any) their pairs
 * belong to. Only these weeks are shown to students and only they count.
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
 * For one load_plan row, walk every week of the semester and collect the
 * occurrences of its pairs — in weeks entered as their own only. The template
 * is the specialist's draft (the constructor copies it into a week when the
 * week is entered); a week never entered was never shown to a student, so it
 * counts nothing. Returns per-week detail (for the "show your work" breakdown
 * teachers can point to) plus the resulting hour total.
 *
 * @param {string} semesterStartDate - ISO date, the semester's week 1 Monday
 * @param {number} weeksCount - how many weeks the semester spans
 * @param {Array} linkedLessons - all lessons rows matching this plan's teacher/discipline/type/group/subgroup
 * @param {Set<number>} exceptionWeeks - from computeExceptionWeeks, scoped to the group
 * @param {Date} [now] - injectable for tests; defaults to the server clock
 */
function computeLoadProgress({ semesterStartDate, weeksCount, linkedLessons, exceptionWeeks, now = clock.now() }) {
    const occurrences = [];

    for (let weekNumber = 1; weekNumber <= weeksCount; weekNumber += 1) {
        if (!exceptionWeeks.has(weekNumber)) {
            continue;
        }

        const weekMonday = addDaysToIsoDate(semesterStartDate, (weekNumber - 1) * 7);
        // is_removed is checked here too: such a row is invisible in the
        // schedule, so counting it would bill hours for a pair nobody was shown.
        // One plan row routinely owns SEVERAL slots in the same week — a lecture
        // block is two consecutive pairs, a language practical runs Mon and Wed.
        const resolvedLessons = linkedLessons.filter((lesson) => lesson.specific_week === weekNumber && !lesson.is_removed);

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
