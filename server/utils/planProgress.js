const { HOURS_PER_LESSON, computeExceptionWeeks, computeLoadProgress } = require('./loadCalc');
const { scheduleGroupId } = require('./groupJoin');
const { getPlanGroupIds } = require('./planGroups');
const { resolveFirstWeekParity } = require('./date');

/**
 * Hours for one load_plan row, computed strictly inside that row's semester.
 *
 * `planRow` must carry id, teacher_id, discipline_id, lesson_type, group_id
 * and subgroup — every caller selects load_plan.* (or joins in the same). The
 * row's other stream groups are read here, so no caller has to know about them.
 *
 * This is the only place hours are computed from the database, on purpose.
 * The four callers (teacher page, admin plan list, Excel report, the impact
 * preview) each used to query "weeks with their own rows" themselves, keyed
 * their cache as group:semester — which looked semester-scoped — while the
 * query itself was not filtered by semester at all. After a rollover, one
 * semester's explicit weeks would have silently overridden another's.
 *
 * `overrides` lets the impact preview ask what a different start date or
 * length would do, without writing anything.
 */
function computePlanRowProgress(db, planRow, semester, { cache = new Map(), overrides = {} } = {}) {
    const effective = { ...semester, ...overrides };
    // A joined group (23313 → 23303) has no pairs of its own: read its leader's.
    const groupIds = [...new Set(getPlanGroupIds(db, planRow).map((groupId) => scheduleGroupId(db, groupId)))];
    const occurrencesBySlot = new Map();

    // A stream row covers several groups. Each group's schedule is resolved
    // on its own (its own explicit weeks), then the pairs are joined by date
    // and time: the teacher held ONE pair for 23303 and 23313 together, so it
    // counts once — and still counts if it was entered for only one of them.
    for (const groupId of groupIds) {
        for (const occurrence of computeGroupOccurrences(db, planRow, groupId, semester, effective, cache)) {
            const slot = `${occurrence.date}|${occurrence.time_start}`;

            if (!occurrencesBySlot.has(slot)) {
                occurrencesBySlot.set(slot, occurrence);
            }
        }
    }

    const occurrences = [...occurrencesBySlot.values()].sort((left, right) => (
        left.date === right.date
            ? left.time_start.localeCompare(right.time_start)
            : left.date.localeCompare(right.date)
    ));
    const occurredCount = occurrences.filter((occurrence) => occurrence.has_occurred).length;
    const progress = {
        occurrences,
        occurred_count: occurredCount,
        occurred_hours: occurredCount * HOURS_PER_LESSON
    };

    // A closed semester keeps reporting the total it reported on the day it
    // was closed. The per-date breakdown is still computed (nothing in a
    // closed semester can change, so it matches), but the number that goes
    // into reports comes from the stored snapshot.
    if (semester.closed_at && Number.isInteger(planRow.final_hours)) {
        return { ...progress, occurred_hours: planRow.final_hours, frozen: true };
    }

    return progress;
}

/** One group's pairs for a plan row, resolved the way that group's schedule shows them. */
function computeGroupOccurrences(db, planRow, groupId, semester, effective, cache) {
    const cacheKey = `${groupId}:${semester.id}:${effective.weeks_count}`;
    let exceptionWeeks = cache.get(cacheKey);

    if (!exceptionWeeks) {
        const overrideRows = db.prepare(`
            SELECT specific_week FROM lessons
            WHERE group_id = ? AND semester_id = ? AND specific_week IS NOT NULL
        `).all(groupId, semester.id);
        exceptionWeeks = computeExceptionWeeks(overrideRows, effective.weeks_count);
        cache.set(cacheKey, exceptionWeeks);
    }

    // No explicit link: a lesson counts toward this row the moment its own
    // teacher_id/discipline_id/lesson_type/group/subgroup match the row's —
    // the same identity, not text that happened to be typed the same way
    // twice. Scoped to this semester so a lesson from another semester can
    // never feed this row's hours.
    const linkedLessons = db.prepare(`
        SELECT * FROM lessons
        WHERE teacher_id = ? AND discipline_id = ? AND lesson_type = ? AND group_id = ? AND subgroup = ?
          AND semester_id = ?
    `).all(planRow.teacher_id, planRow.discipline_id, planRow.lesson_type, groupId, planRow.subgroup, semester.id);

    return computeLoadProgress({
        semesterStartDate: effective.start_date,
        weeksCount: effective.weeks_count,
        linkedLessons,
        exceptionWeeks,
        firstWeekParity: resolveFirstWeekParity(effective)
    }).occurrences;
}

module.exports = { computePlanRowProgress };
