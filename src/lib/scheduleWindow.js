import { formatLocalDateForApi } from './date.js';

/**
 * The window of consecutive days the schedule page shows around the chosen day.
 *
 * The page loads one request: two weeks before the chosen day and two weeks
 * after it; going further means picking a date in the calendar.
 *
 * planExtension and mergeScheduleData are not used by the page for now. They
 * grow the window at whichever edge the reader nears — always by whole
 * requests to the same endpoint, so the server needs no change — and are kept,
 * with their test, for bringing endless scrolling back once it has been tried
 * on real phones and trackpads (mouse dragging across the moment days are added
 * on the left needs its scroll compensation handled first).
 *
 * Kept out of SchedulePage so it can be tested against the real API: a run
 * assembled from several windows has to resolve every day exactly as a request
 * for that day alone would.
 */

export const INITIAL_DAYS_BEFORE = 14;
export const INITIAL_DAYS_AFTER = 14;
export const EXTEND_DAYS = 14;

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

/**
 * The next request when the reader nears an edge, or null at the limit. The
 * new window is contiguous with the run — it starts the day after `to`, or
 * ends the day before `from` — so the run stays one unbroken stretch of days.
 */
export function planExtension({ from, to }, direction, { earliest, latest }) {
    if (direction === 'after') {
        if (to >= latest) {
            return null;
        }

        return { from: shiftIsoDate(to, 1), to: minIso(shiftIsoDate(to, EXTEND_DAYS), latest) };
    }

    if (from <= earliest) {
        return null;
    }

    return { from: maxIso(shiftIsoDate(from, -EXTEND_DAYS), earliest), to: shiftIsoDate(from, -1) };
}

/**
 * Responses from before semester scoping (an old copy the service worker kept
 * for offline use) carry no `semesters` and are read through a legacy path
 * that only understands a single window, so they are never combined.
 */
export function isMergeable(current, incoming) {
    return Array.isArray(current?.semesters) && Array.isArray(incoming?.semesters);
}

/**
 * Two responses for neighbouring windows, as one. Every response carries the
 * whole template of each semester it touches plus the own-week rows of the
 * weeks it covers, so the union by id has exactly what the days of both
 * windows need — and the later response wins where a row appears in both.
 */
export function mergeScheduleData(current, incoming) {
    const semesters = new Map();
    const lessons = new Map();

    for (const semester of [...current.semesters, ...incoming.semesters]) {
        semesters.set(semester.id, semester);
    }

    for (const lesson of [...(current.lessons || []), ...(incoming.lessons || [])]) {
        lessons.set(lesson.id, lesson);
    }

    return {
        ...current,
        semesters: [...semesters.values()],
        lessons: [...lessons.values()]
    };
}
