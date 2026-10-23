const { resolveTemplateLessons } = require('./templateResolve');

/**
 * Two template rows occupy the same physical cell when their group, day, time
 * and subgroup match AND their week types overlap.
 *
 * The overlap is deliberately NOT plain equality: week_type 0 ("every week")
 * covers both parities, so an "every week" pair and a чётная pair in the same
 * cell both show up on even weeks — two lessons rendered in one slot for
 * students, and two counted occurrences for the teacher's hours. A чётная and
 * a нечётная pair in the same cell, on the other hand, are perfectly normal
 * (different subject depending on the week) and must stay allowed — the real
 * schedule has 90 such slots.
 */
function weekTypesOverlap(left, right) {
    return left === 0 || right === 0 || left === right;
}

/**
 * Who meets at the same time. A whole-group pair (subgroup 0) is attended by
 * both subgroups, so it collides with either subgroup's pair; the two
 * subgroups' own pairs side by side are normal. Without this, «Математика for
 * everyone» and «Английский for п/г 1» in one cell showed п/г 1 two pairs at
 * once, while the constructor drew only the whole-group card — the other pair
 * hidden from the specialist and still counted.
 */
const SUBGROUPS_MEET_SQL = '(subgroup = 0 OR ? = 0 OR subgroup = ?)';

/**
 * Times overlap, not just match: 15:00–16:30 and 15:30–17:00 are one clash.
 * Back to back (09:30 end, 09:30 start) is not.
 */
const TIMES_OVERLAP_SQL = 'time_start < ? AND time_end > ?';

/**
 * The lesson occupying a template cell from targetWeek on, or null.
 *
 * Resolves through the version/tombstone chain instead of just looking for any
 * row with is_removed = 0 — otherwise a cell that was emptied (an old row plus
 * a newer tombstone) would still read as taken and block ever refilling it.
 *
 * Not only at targetWeek: a version waiting for a later week (an edit made
 * «from next week») takes its cell from then on, so the template is resolved
 * again at every week a version of that day starts. Checked at targetWeek
 * alone, a pair put in this week next to one moved there from next week lay
 * on top of it from next week on. `ignore` leaves out rows the caller is
 * replacing anyway.
 */
function findTemplateSlotOccupant(db, {
    semesterId, groupId, dayOfWeek, timeStart, timeEnd, subgroup, weekType, targetWeek, ignoreLessonId = null, ignore = null
}) {
    // Scoped to one semester: autumn's template occupying Tuesday 09:40 says
    // nothing about whether spring's Tuesday 09:40 is free.
    // Versions are resolved per cell over ALL the group's rows that day (a
    // newer tombstone must still retire an older row), then the live ones
    // are checked for a clash.
    const dayRows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND day_of_week = ?
    `).all(semesterId, groupId, dayOfWeek);

    const weeks = [...new Set([targetWeek, ...dayRows.map((row) => row.template_from_week).filter((week) => week > targetWeek)])];

    for (const week of weeks) {
        const occupant = resolveTemplateLessons(dayRows, week).find((lesson) => lesson.id !== ignoreLessonId
            && !(ignore && ignore(lesson))
            && weekTypesOverlap(lesson.week_type, weekType)
            && lessonsClash(lesson, { time_start: timeStart, time_end: timeEnd, subgroup }));

        if (occupant) {
            return occupant;
        }
    }

    return null;
}

/** Same question for one concrete week's own rows, where versioning doesn't apply. */
function findWeekSlotOccupant(db, {
    semesterId, groupId, weekNumber, dayOfWeek, timeStart, timeEnd, subgroup, ignoreLessonId = null
}) {
    const rows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week = ? AND day_of_week = ?
          AND ${TIMES_OVERLAP_SQL} AND ${SUBGROUPS_MEET_SQL}
          AND is_removed = 0
    `).all(semesterId, groupId, weekNumber, dayOfWeek, timeEnd, timeStart, subgroup, subgroup);

    return rows.find((lesson) => lesson.id !== ignoreLessonId) || null;
}

/** Two pairs of one group on one day that cannot both happen: same people, overlapping time. */
function lessonsClash(left, right) {
    return left.time_start < right.time_end && right.time_start < left.time_end
        && (left.subgroup === 0 || right.subgroup === 0 || left.subgroup === right.subgroup);
}

module.exports = { lessonsClash, weekTypesOverlap, findTemplateSlotOccupant, findWeekSlotOccupant };
