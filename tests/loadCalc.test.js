const test = require('node:test');
const assert = require('node:assert/strict');

const { HOURS_PER_LESSON, computeExceptionWeeks, computeLoadProgress } = require('../server/utils/loadCalc');

function lesson({ id, day_of_week, time_start, time_end, week_type = 0, specific_week = null, template_from_week = 1, is_removed = 0 }) {
    return { id, day_of_week, time_start, time_end, week_type, specific_week, template_from_week, is_removed };
}

// A Monday semester start, matching the rest of the app's fixtures.
const SEMESTER_START = '2026-02-09';
const LATER = new Date('2026-12-31T00:00:00');

test('1 lesson = 2 academic hours', () => {
    assert.equal(HOURS_PER_LESSON, 2);
});

test('entered weeks count, one occurrence per pair, none after "now"', () => {
    const linkedLessons = [1, 2, 3, 4].map((week) => lesson({ id: week, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: week }));

    // Week 2 Monday = 2026-02-16; "now" sits right after week 2's pair, before week 3's.
    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set([1, 2, 3, 4]),
        now: new Date('2026-02-16T12:00:00')
    });

    assert.equal(result.occurred_count, 2);
    assert.equal(result.occurred_hours, 4);
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 2, 3, 4]);
    assert.deepEqual(result.occurrences.map((o) => o.has_occurred), [true, true, false, false]);
});

test('the template counts nothing: a week never entered was never shown', () => {
    const linkedLessons = [
        // The draft: a pair every week from week 1.
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10' }),
        // Only week 2 was entered, with that pair copied in.
        lesson({ id: 2, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: 2 })
    ];

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set([2]),
        now: LATER
    });

    assert.deepEqual(result.occurrences.map((o) => o.week_number), [2]);
    assert.equal(result.occurred_hours, 2);
});

test('an entered week that took this pair out does not count it', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: 1 }),
        lesson({ id: 2, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: 2, is_removed: 1 }),
        lesson({ id: 3, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: 3 })
    ];

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 3,
        linkedLessons,
        exceptionWeeks: new Set([1, 2, 3]),
        now: LATER
    });

    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 3]);
    assert.equal(result.occurred_count, 2);
});

test('an entered week whose pairs are all someone else\'s counts nothing for this row', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: 1 })
    ];

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 3,
        linkedLessons,
        exceptionWeeks: new Set([1, 2]), // week 2 was entered with other pairs
        now: LATER
    });

    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1]);
});

test('a plan row with two pairs in the same week (lecture block, or Mon+Wed practicals) counts both, not just the first', () => {
    // Real timetables routinely put one load_plan row on two slots a week —
    // a double lecture block, or a language practical that meets Mon and Wed.
    const linkedLessons = [1, 2].flatMap((week) => [
        lesson({ id: week * 10 + 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: week }),
        lesson({ id: week * 10 + 3, day_of_week: 3, time_start: '09:40', time_end: '11:10', specific_week: week })
    ]);

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set([1, 2]),
        now: LATER
    });

    assert.equal(result.occurred_count, 4);
    assert.equal(result.occurred_hours, 8);
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 1, 2, 2]);
});

test('computeExceptionWeeks collects specific_week values within range and ignores out-of-range ones', () => {
    const groupLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10' }),
        lesson({ id: 2, day_of_week: 2, time_start: '09:40', time_end: '11:10', specific_week: 3 }),
        lesson({ id: 3, day_of_week: 3, time_start: '09:40', time_end: '11:10', specific_week: 3 }),
        lesson({ id: 4, day_of_week: 4, time_start: '09:40', time_end: '11:10', specific_week: 20 }) // beyond weeksCount
    ];

    const exceptionWeeks = computeExceptionWeeks(groupLessons, 10);

    assert.deepEqual([...exceptionWeeks].sort(), [3]);
});
