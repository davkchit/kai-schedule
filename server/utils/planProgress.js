const { computeExceptionWeeks, computeLoadProgress } = require('./loadCalc');
const { resolveFirstWeekParity } = require('./date');

/**
 * Hours for one load_plan row, computed strictly inside that row's semester.
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
    const cacheKey = `${planRow.group_id}:${semester.id}:${effective.weeks_count}`;
    let exceptionWeeks = cache.get(cacheKey);

    if (!exceptionWeeks) {
        const overrideRows = db.prepare(`
            SELECT specific_week FROM lessons
            WHERE group_id = ? AND semester_id = ? AND specific_week IS NOT NULL
        `).all(planRow.group_id, semester.id);
        exceptionWeeks = computeExceptionWeeks(overrideRows, effective.weeks_count);
        cache.set(cacheKey, exceptionWeeks);
    }

    // Linking already refuses cross-semester pairs; filtering here too means a
    // lesson from another semester can never feed this row's hours even if one
    // slipped in some other way.
    const linkedLessons = db.prepare('SELECT * FROM lessons WHERE load_plan_id = ? AND semester_id = ?')
        .all(planRow.id, semester.id);

    const progress = computeLoadProgress({
        semesterStartDate: effective.start_date,
        weeksCount: effective.weeks_count,
        linkedLessons,
        exceptionWeeks,
        firstWeekParity: resolveFirstWeekParity(effective)
    });

    // A closed semester keeps reporting the total it reported on the day it
    // was closed. The per-date breakdown is still computed (nothing in a
    // closed semester can change, so it matches), but the number that goes
    // into reports comes from the stored snapshot.
    if (semester.closed_at && Number.isInteger(planRow.final_hours)) {
        return { ...progress, occurred_hours: planRow.final_hours, frozen: true };
    }

    return progress;
}

module.exports = { computePlanRowProgress };
