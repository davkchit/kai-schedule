const test = require('node:test');
const assert = require('node:assert/strict');

const { HOURS_PER_LESSON, computeExceptionWeeks, computeLoadProgress } = require('../server/utils/loadCalc');

function lesson({ id, day_of_week, time_start, time_end, week_type = 0, specific_week = null, template_from_week = 1, is_removed = 0 }) {
    return { id, day_of_week, time_start, time_end, week_type, specific_week, template_from_week, is_removed };
}

// A Monday semester start, matching the rest of the app's fixtures.
const SEMESTER_START = '2026-02-09';

test('1 lesson = 2 academic hours', () => {
    assert.equal(HOURS_PER_LESSON, 2);
});

test('every-week lesson: counts one occurrence per elapsed week, none after "now"', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', week_type: 0 })
    ];

    // Week 1 Monday = 2026-02-09, week 2 Monday = 2026-02-16, week 3 Monday = 2026-02-23.
    // "now" sits right after week 2's lesson ended, before week 3's.
    const now = new Date('2026-02-16T12:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set(),
        now
    });

    assert.equal(result.occurred_count, 2);
    assert.equal(result.occurred_hours, 4);
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 2, 3, 4]);
    assert.deepEqual(result.occurrences.map((o) => o.has_occurred), [true, true, false, false]);
});

test('odd-week lesson only occurs on odd weeks', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 2, time_start: '11:30', time_end: '13:00', week_type: 1 })
    ];

    // Far enough in the future that every week in range has already happened.
    const now = new Date('2026-12-31T00:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set(),
        now
    });

    // Only weeks 1 and 3 are odd.
    assert.equal(result.occurrences.length, 2);
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 3]);
    assert.equal(result.occurred_count, 2);
    assert.equal(result.occurred_hours, 4);
});

test('a mid-semester template edit (same slot) does not rewrite which hours already counted', () => {
    // Same day/time/week_type — i.e. the same recurring slot, just a new
    // version of it (e.g. the discipline's card was corrected). This is the
    // versioning the schedule itself already guarantees: history is what it
    // was, edits only ever take effect from their from_week forward.
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', template_from_week: 1 }),
        lesson({ id: 2, day_of_week: 1, time_start: '09:40', time_end: '11:10', template_from_week: 3 })
    ];

    const now = new Date('2026-12-31T00:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set(),
        now
    });

    assert.equal(result.occurred_count, 4);
    assert.equal(result.occurred_hours, 8);
    // Weeks 1-2 resolve to the pre-edit version, weeks 3-4 to the edited one —
    // the hour count doesn't care, but this proves it's really resolving
    // versions per week rather than just taking whichever row it sees first.
    assert.deepEqual(result.occurrences.map((o) => o.lesson_id), [1, 1, 2, 2]);
});

test('a materialized week that removed this lesson does not count, even though the group has other overrides that week', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', week_type: 0 })
        // No specific_week: 2 row for THIS load_plan — the specialist removed
        // just this slot when materializing week 2 (holiday, cancellation, ...).
    ];

    const now = new Date('2026-12-31T00:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 3,
        linkedLessons,
        exceptionWeeks: new Set([2]), // some other slot in the group was materialized for week 2
        now
    });

    // Week 2 must be skipped entirely (no merge with the template), weeks 1 and 3 still count.
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 3]);
    assert.equal(result.occurred_count, 2);
});

test('a materialized week that KEPT this lesson (as its own row) still counts', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', week_type: 0 }),
        // The specialist materialized week 2 and kept this exact slot as its own row.
        lesson({ id: 2, day_of_week: 1, time_start: '09:40', time_end: '11:10', specific_week: 2, week_type: 0 })
    ];

    const now = new Date('2026-12-31T00:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 3,
        linkedLessons,
        exceptionWeeks: new Set([2]),
        now
    });

    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 2, 3]);
    assert.equal(result.occurred_count, 3);
});

test('a tombstoned template version removes future occurrences without touching past ones', () => {
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', template_from_week: 1 }),
        lesson({ id: 2, day_of_week: 1, time_start: '09:40', time_end: '11:10', template_from_week: 3, is_removed: 1 })
    ];

    const now = new Date('2026-12-31T00:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set(),
        now
    });

    // Weeks 1-2 still resolve (pre-tombstone version); weeks 3-4 resolve to nothing.
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 2]);
    assert.equal(result.occurred_count, 2);
});

test('a plan row with two slots in the same week (lecture block, or Mon+Wed practicals) counts both, not just the first', () => {
    // Real timetables routinely put one load_plan row on two slots a week —
    // a double lecture block, or a language practical that meets Mon and Wed.
    // The engine used to take resolved[0] and silently drop the second slot,
    // halving that row's hours.
    const linkedLessons = [
        lesson({ id: 1, day_of_week: 1, time_start: '09:40', time_end: '11:10', week_type: 0 }),
        lesson({ id: 2, day_of_week: 3, time_start: '09:40', time_end: '11:10', week_type: 0 })
    ];

    const now = new Date('2026-12-31T00:00:00');

    const result = computeLoadProgress({
        semesterStartDate: SEMESTER_START,
        weeksCount: 4,
        linkedLessons,
        exceptionWeeks: new Set(),
        now
    });

    // 4 weeks × 2 slots per week = 8 occurrences = 16 hours.
    assert.equal(result.occurred_count, 8);
    assert.equal(result.occurred_hours, 16);
    assert.deepEqual(result.occurrences.map((o) => o.week_number), [1, 1, 2, 2, 3, 3, 4, 4]);
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
