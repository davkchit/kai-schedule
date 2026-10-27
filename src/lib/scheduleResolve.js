import { formatLocalDateForApi, getSemesterWeekNumber, getWeekTypeNumber } from './date.js';
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
 * Only weeks entered as their own are shown: the template is the specialist's
 * draft, never sent here. Pairs are open up to `visible_until` (the end of this
 * week, or of the next once it is entered); after it a day shows only its
 * exams, credits and consultations, which are published in advance.
 *
 * @param {object} scheduleData - the /api/schedule/:groupId response
 * @param {Date} date - a local calendar date
 */
export function resolveLessonsForDay(scheduleData, date) {
    if (!scheduleData) {
        return [];
    }

    const attestations = attestationsForDay(scheduleData, date);
    const lessons = dayStatus(scheduleData, date) === 'closed' ? [] : resolveTeachingForDay(scheduleData, date);

    return attestations.length ? sortLessons([...lessons, ...attestations]) : lessons;
}

/**
 * What the day's pairs are, for the page to say so:
 * 'open' — shown (no pairs then means a day off);
 * 'not_entered' — a teaching week nobody has entered yet («Расписание не внесено»);
 * 'closed' — after the open weeks: nothing but session records shows.
 */
export function dayStatus(scheduleData, date) {
    if (!scheduleData || !Array.isArray(scheduleData.semesters)) {
        return 'open';
    }

    const isoDate = formatLocalDateForApi(date);

    if (scheduleData.visible_until && isoDate > scheduleData.visible_until) {
        return 'closed';
    }

    const semester = semesterOn(scheduleData, isoDate);

    if (!semester) {
        return 'open';
    }

    const weekNumber = getSemesterWeekNumber(semester.start_date, date);

    if (weekIsOwn(scheduleData, semester, weekNumber)) {
        return 'open';
    }

    // Past the last teaching week (сессия, каникулы) there are no pairs to enter.
    const teaching = weekNumber >= 1 && (!Number.isInteger(semester.weeks_count) || weekNumber <= semester.weeks_count);
    return teaching ? 'not_entered' : 'open';
}

/** The semester in effect on a date: the latest one starting on or before it. */
function semesterOn(scheduleData, isoDate) {
    return [...scheduleData.semesters]
        .filter((candidate) => candidate.start_date <= isoDate)
        .sort((left, right) => (left.start_date < right.start_date ? -1 : 1))
        .pop() || null;
}

/** own_weeks counts the whole group (a week with only the other subgroup's rows is still its own); an older saved answer lacks it. */
function weekIsOwn(scheduleData, semester, weekNumber) {
    return Array.isArray(semester.own_weeks)
        ? semester.own_weeks.includes(weekNumber)
        : (scheduleData.lessons || []).some((lesson) => lesson.semester_id === semester.id && lesson.specific_week === weekNumber);
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
    const semester = semesterOn(scheduleData, isoDate);

    if (!semester) {
        // Before any semester has started there is no timetable to show.
        return [];
    }

    const weekNumber = getSemesterWeekNumber(semester.start_date, date);

    if (!weekIsOwn(scheduleData, semester, weekNumber)) {
        // Not entered (or past the teaching weeks): nothing to show — the
        // template is only the constructor's draft.
        return [];
    }

    return sortLessons((scheduleData.lessons || []).filter((lesson) => lesson.semester_id === semester.id
        && lesson.day_of_week === isoDayOfWeek && lesson.specific_week === weekNumber && !lesson.is_removed));
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
