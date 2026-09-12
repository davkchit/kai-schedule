export function normalizeDate(date) {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    return normalized;
}

export function formatLocalDateForApi(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

export function capitalize(text) {
    if (!text) {
        return '';
    }

    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function getSemesterWeekNumber(semesterStartDate, targetDate) {
    const [startYear, startMonth, startDay] = semesterStartDate.split('-').map(Number);
    const semesterStartUtc = Date.UTC(startYear, startMonth - 1, startDay);
    const targetUtc = Date.UTC(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const rawWeekNumber = Math.floor((targetUtc - semesterStartUtc) / (7 * 24 * 60 * 60 * 1000)) + 1;

    return Math.max(1, rawWeekNumber);
}

/** ISO-8601 week number of the calendar year. Mirrors server/utils/date.js. */
export function getIsoWeekNumber(targetDate) {
    const date = new Date(Date.UTC(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate()));
    const dayOfWeek = date.getUTCDay() || 7;

    date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

    return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

/**
 * Odd/even parity follows the ISO calendar week, not the semester week number —
 * that is how the department labels its published чётная/нечётная sheets.
 * Kept in parity with getWeekTypeNumber in server/utils/date.js.
 */
export function getWeekTypeNumber(targetDate) {
    return getIsoWeekNumber(targetDate) % 2 === 0 ? 2 : 1;
}
