import { formatLocalDateForApi } from './date.js';

/**
 * The window of consecutive days the schedule page shows around the chosen day.
 *
 * The page loads one request: two weeks before the chosen day and two weeks
 * after it; going further means picking a date in the calendar.
 *
 * Kept out of SchedulePage so it can be tested against the real API: a run
 * assembled from several windows has to resolve every day exactly as a request
 * for that day alone would.
 */

export const INITIAL_DAYS_BEFORE = 14;
export const INITIAL_DAYS_AFTER = 14;

export function parseIsoDate(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day);
}

export function shiftIsoDate(iso, days) {
    const date = parseIsoDate(iso);
    date.setDate(date.getDate() + days);
    return formatLocalDateForApi(date);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetweenIso(fromIso, toIso) {
    // Rounded: a daylight-saving change makes one of these days 23 or 25 hours.
    return Math.round((parseIsoDate(toIso) - parseIsoDate(fromIso)) / 86400000);
}

export function maxIso(left, right) {
    return left > right ? left : right;
}

export function minIso(left, right) {
    return left < right ? left : right;
}

/** How many days a request for [from, to] has to ask for. */
export function requestDays(from, to) {
    return daysBetweenIso(from, to) + 1;
}

/**
 * The first request for a chosen day: a week before it, four weeks after,
 * inside [earliest, latest]. A day outside those limits (reached through the
 * calendar) still gets its own window rather than being clamped away.
 */
export function planInitialWindow(wantedIso, { earliest, latest }) {
    const floor = wantedIso < earliest ? wantedIso : earliest;
    const ceiling = wantedIso > latest ? wantedIso : latest;

    return {
        from: maxIso(shiftIsoDate(wantedIso, -INITIAL_DAYS_BEFORE), floor),
        to: minIso(shiftIsoDate(wantedIso, INITIAL_DAYS_AFTER), ceiling)
    };
}
