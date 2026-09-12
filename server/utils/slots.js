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
 * The live lesson occupying a template cell as of targetWeek, or null.
 *
 * Resolves through the version/tombstone chain instead of just looking for any
 * row with is_removed = 0 — otherwise a cell that was emptied (an old row plus
 * a newer tombstone) would still read as taken and block ever refilling it.
 */
function findTemplateSlotOccupant(db, {
    groupId, dayOfWeek, timeStart, timeEnd, subgroup, weekType, targetWeek, ignoreLessonId = null
}) {
    const candidates = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ? AND specific_week IS NULL
          AND day_of_week = ? AND time_start = ? AND time_end = ? AND subgroup = ?
    `).all(groupId, dayOfWeek, timeStart, timeEnd, subgroup);

    const overlapping = candidates.filter((lesson) => weekTypesOverlap(lesson.week_type, weekType));
    const live = resolveTemplateLessons(overlapping, targetWeek);

    return live.find((lesson) => lesson.id !== ignoreLessonId) || null;
}

/** Same question for one concrete week's own rows, where versioning doesn't apply. */
function findWeekSlotOccupant(db, {
    groupId, weekNumber, dayOfWeek, timeStart, timeEnd, subgroup, ignoreLessonId = null
}) {
    const rows = db.prepare(`
        SELECT * FROM lessons
        WHERE group_id = ? AND specific_week = ?
          AND day_of_week = ? AND time_start = ? AND time_end = ? AND subgroup = ?
          AND is_removed = 0
    `).all(groupId, weekNumber, dayOfWeek, timeStart, timeEnd, subgroup);

    return rows.find((lesson) => lesson.id !== ignoreLessonId) || null;
}

module.exports = { weekTypesOverlap, findTemplateSlotOccupant, findWeekSlotOccupant };
