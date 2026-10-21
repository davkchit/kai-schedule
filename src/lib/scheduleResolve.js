import { formatLocalDateForApi, getSemesterWeekNumber, getWeekTypeForSemesterWeek, getWeekTypeNumber } from './date.js';
import { resolveTemplateLessons } from './templateResolve.js';

/**
 * Which lessons a student sees on one calendar day.
 *
 * Kept out of SchedulePage on purpose: logic living inline in a page cannot be
 * tested, and that is exactly how the page once kept an old parity formula
 * after the shared one changed. The year-lifecycle test imports this very
 * module, so what it verifies is what the page renders.
 *
 * The day is resolved against the semester in effect on THAT day (the latest
 * one starting on or before it), using only that semester's lessons, its own
 * week numbering and its stored first-week parity. A 28-day view crossing the
 * February rollover therefore shows autumn's timetable up to the last autumn
 * day and spring's from the first spring day — never an autumn row read as a
 * spring week.
 *
 * @param {object} scheduleData - the /api/schedule/:groupId response
 * @param {Date} date - a local calendar date
 */
export function resolveLessonsForDay(scheduleData, date) {
    if (!scheduleData) {
        return [];
    }

    const attestations = attestationsForDay(scheduleData, date);
    const lessons = resolveTeachingForDay(scheduleData, date);

    return attestations.length ? sortLessons([...lessons, ...attestations]) : lessons;
}

const ATTESTATION_LABELS = { exam: 'Экзамен', credit: 'Зачёт', consultation: 'Консультация' };

/**
 * Экзамены, зачёты и консультации fall on real dates, outside the weekly
 * template: shown on their day like a pair (kind 'attestation'), even in a
 * week past the last teaching one, and they never replace that day's pairs.
 */
function attestationsForDay(scheduleData, date) {
    if (!Array.isArray(scheduleData.attestations)) {
        return [];
    }

    const isoDate = formatLocalDateForApi(date);

    return scheduleData.attestations
        .filter((item) => item.date === isoDate)
        .map((item) => ({
            id: `attestation-${item.id}`,
            kind: 'attestation',
            attestation_kind: item.kind,
            lesson_type: ATTESTATION_LABELS[item.kind] || item.kind,
            subgroup: item.subgroup,
            time_start: item.time_start,
            time_end: item.time_end || null,
            subject: item.subject,
            room: item.room,
            teacher: item.teacher
        }));
}

function resolveTeachingForDay(scheduleData, date) {
    const isoDayOfWeek = date.getDay() === 0 ? 7 : date.getDay();

    if (!Array.isArray(scheduleData.semesters)) {
        return resolveLegacyDay(scheduleData, date, isoDayOfWeek);
    }

    const isoDate = formatLocalDateForApi(date);
    const semester = [...scheduleData.semesters]
        .filter((candidate) => candidate.start_date <= isoDate)
        .sort((left, right) => (left.start_date < right.start_date ? -1 : 1))
        .pop();

    if (!semester) {
        // Before any semester has started there is no timetable to show.
        return [];
    }

    const semesterLessons = (scheduleData.lessons || []).filter((lesson) => lesson.semester_id === semester.id);
    const weekNumber = getSemesterWeekNumber(semester.start_date, date);
    const hasOwnRows = semesterLessons.some((lesson) => lesson.specific_week === weekNumber);
    const dayLessons = semesterLessons.filter((lesson) => lesson.day_of_week === isoDayOfWeek);

    if (hasOwnRows) {
        // A week with its own rows ignores the template entirely (no merging).
        return sortLessons(dayLessons.filter((lesson) => lesson.specific_week === weekNumber && !lesson.is_removed));
    }

    if (Number.isInteger(semester.weeks_count) && weekNumber > semester.weeks_count) {
        // Past the last teaching week (сессия, каникулы) the template no longer
        // runs — the hour counter stops at weeks_count too. Only weeks entered
        // explicitly (an exam week, say) show anything.
        return [];
    }

    const weekType = getWeekTypeForSemesterWeek(semester.first_week_parity, weekNumber);
    const candidates = dayLessons.filter(
        (lesson) => lesson.specific_week == null && (lesson.week_type === 0 || lesson.week_type === weekType)
    );

    return sortLessons(resolveTemplateLessons(candidates, weekNumber));
}

/**
 * Responses from before semester scoping (an older copy of the API cached by
 * the service worker) carry one semester_start and untagged lessons.
 */
function resolveLegacyDay(scheduleData, date, isoDayOfWeek) {
    if (!scheduleData.semester_start) {
        return [];
    }

    const weekNumber = getSemesterWeekNumber(scheduleData.semester_start, date);
    const lessonsForDay = (scheduleData.by_day || {})[isoDayOfWeek] || [];
    const exceptionWeeks = new Set(scheduleData.exception_weeks || []);

    if (exceptionWeeks.has(weekNumber)) {
        return sortLessons(lessonsForDay.filter((lesson) => lesson.specific_week === weekNumber));
    }

    // Such a response predates per-semester parity; the page resolved it with
    // the calendar rule for the day, so keep doing exactly that.
    const weekType = getWeekTypeNumber(date);
    const candidates = lessonsForDay.filter(
        (lesson) => lesson.specific_week == null && (lesson.week_type === 0 || lesson.week_type === weekType)
    );

    return sortLessons(resolveTemplateLessons(candidates, weekNumber));
}

function sortLessons(lessons) {
    return [...lessons].sort((left, right) => (
        (left.time_start || '').localeCompare(right.time_start || '') || (left.sort_order ?? 0) - (right.sort_order ?? 0)
    ));
}
