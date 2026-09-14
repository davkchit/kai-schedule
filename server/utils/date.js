const clock = require('./clock');
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

function isValidIsoDate(value) {
    if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function isValidTime(value) {
    return typeof value === 'string' && TIME_RE.test(value);
}

function toUtcMsFromIsoDate(value) {
    if (!isValidIsoDate(value)) {
        throw new Error(`Invalid ISO date: ${value}`);
    }

    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
}

function addDaysToIsoDate(value, days) {
    const nextDate = new Date(toUtcMsFromIsoDate(value) + (days * 24 * 60 * 60 * 1000));
    const year = nextDate.getUTCFullYear();
    const month = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(nextDate.getUTCDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

function formatLocalDate(date = clock.now()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

/**
 * Monday of the calendar week containing the date. A semester's weeks are
 * Monday–Sunday no matter which weekday classes actually begin on: with a
 * Tuesday start date, "week 2" would otherwise begin on a Tuesday and every
 * Monday pair would be read as the previous week's — the wrong parity in the
 * student schedule, and the hour counter dating day_of_week 1 to a Tuesday.
 */
function mondayOfWeek(isoDate) {
    const dayOfWeek = new Date(toUtcMsFromIsoDate(isoDate)).getUTCDay() || 7;
    return addDaysToIsoDate(isoDate, 1 - dayOfWeek);
}

function getSemesterWeekNumber(semesterStartDate, targetDate) {
    const semesterStartUtc = toUtcMsFromIsoDate(mondayOfWeek(semesterStartDate));
    const targetDateUtc = toUtcMsFromIsoDate(targetDate);
    const rawWeekNumber = Math.floor((targetDateUtc - semesterStartUtc) / WEEK_IN_MS) + 1;

    // Dates before the semester start should not produce negative week numbers.
    return Math.max(1, rawWeekNumber);
}

/**
 * ISO-8601 week number of the calendar year (weeks start Monday; week 1 is the
 * one containing the first Thursday).
 */
function getIsoWeekNumber(isoDate) {
    const date = new Date(toUtcMsFromIsoDate(isoDate));
    const dayOfWeek = date.getUTCDay() || 7; // Sunday is 7, not 0

    date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek); // move to that week's Thursday
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

/**
 * Parity by the ISO calendar week of the year. Matches both published autumn
 * 2026 sheets (1–5 Sept is ISO 36, labelled ЧЁТНАЯ; 7–12 Sept is ISO 37,
 * НЕЧЁТНАЯ) — but so does "alternate continuously from September", and the two
 * split apart after a 53-week year. So this is only used as the DEFAULT for a
 * new semester's first-week parity (see defaultFirstWeekParity); the semester
 * row's stored first_week_parity is what actually decides every week.
 */
function getWeekTypeNumber(isoDate) {
    return getIsoWeekNumber(isoDate) % 2 === 0 ? 2 : 1;
}

/**
 * Parity of week N of a semester, given the parity of its week 1.
 *
 * The semester records its first week's parity explicitly (taken from the
 * header of the published schedule sheet) and then strictly alternates. That
 * is deliberate rather than deriving parity from the calendar: the ISO-week
 * rule and "alternate continuously from September" agree for all of autumn
 * 2026 but disagree for the whole of spring 2027, because 2026 has 53 ISO
 * weeks. Which one the department uses is a fact on a document, not something
 * to guess — so it is stored, and the calendar rule is only the default.
 */
function getWeekTypeForSemesterWeek(firstWeekParity, weekNumber) {
    const first = firstWeekParity === 1 ? 1 : 2;
    return weekNumber % 2 === 1 ? first : (first === 1 ? 2 : 1);
}

/** Calendar-based guess for a new semester's first-week parity — only a default. */
function defaultFirstWeekParity(semesterStartDate) {
    return getWeekTypeNumber(semesterStartDate);
}

function weekMetaFromNumber(weekNumber, weekTypeNumber) {
    return {
        weekNumber,
        weekTypeNumber,
        weekType: weekTypeNumber === 1 ? 'odd' : 'even',
        weekTypeLabel: weekTypeNumber === 1 ? 'Нечётная неделя' : 'Чётная неделя'
    };
}

/**
 * A semester's first-week parity, falling back to the calendar rule when the
 * row does not state one (0 / missing — e.g. a row inserted before the column
 * existed or by a script that did not set it). Falling back rather than
 * treating "unset" as a fixed value keeps such rows on exactly the parity they
 * always had, instead of silently flipping every week.
 */
function resolveFirstWeekParity(semester) {
    return semester.first_week_parity === 1 || semester.first_week_parity === 2
        ? semester.first_week_parity
        : defaultFirstWeekParity(semester.start_date);
}

/** Parity of week N of a given semester row. */
function getSemesterWeekType(semester, weekNumber) {
    return getWeekTypeForSemesterWeek(resolveFirstWeekParity(semester), weekNumber);
}

/** Week number and parity of a date within a given semester row. */
function getSemesterWeekMeta(semester, targetDate) {
    const weekNumber = getSemesterWeekNumber(semester.start_date, targetDate);
    return weekMetaFromNumber(weekNumber, getSemesterWeekType(semester, weekNumber));
}

/**
 * Legacy shape kept for callers that only know a start date (no semester row):
 * parity defaults to the calendar rule for that start date.
 */
function getWeekMeta(semesterStartDate, targetDate) {
    return getSemesterWeekMeta(
        { start_date: semesterStartDate, first_week_parity: defaultFirstWeekParity(semesterStartDate) },
        targetDate
    );
}

module.exports = {
    mondayOfWeek,
    addDaysToIsoDate,
    formatLocalDate,
    getIsoWeekNumber,
    defaultFirstWeekParity,
    getSemesterWeekMeta,
    getSemesterWeekNumber,
    getSemesterWeekType,
    resolveFirstWeekParity,
    getWeekMeta,
    getWeekTypeForSemesterWeek,
    getWeekTypeNumber,
    isValidIsoDate,
    isValidTime
};
