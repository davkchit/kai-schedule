const { addDaysToIsoDate, getSemesterWeekMeta } = require('./date');
const { scheduleGroupId } = require('./groupJoin');
const { findWeekSlotOccupant } = require('./slots');
const { timedAttestationError } = require('./attestationConflicts');
const { getSemesterById } = require('./semesters');

/**
 * Takes pairs out of ONE date — an exam or a credit held in their place — so
 * students no longer see them that day and they stop counting toward hours.
 * Only a week entered as its own has pairs to take out (students see nothing
 * of a week still on the template); they get the removed marker, carrying
 * `attestationId`, so restorePairsHiddenBy can bring them back.
 *
 * `pairs` are that week's own rows of the group's schedule owner `groupId`.
 */
function hidePairsOnDate(db, semester, groupId, isoDate, pairs, attestationId = null) {
    if (pairs.length === 0) {
        return 0;
    }

    const { weekNumber } = getSemesterWeekMeta(semester, isoDate);
    const hide = db.prepare('UPDATE lessons SET is_removed = 1, hidden_by_attestation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND specific_week = ? AND is_removed = 0');
    return pairs.reduce((count, pair) => count + hide.run(attestationId, pair.id, weekNumber).changes, 0);
}

/**
 * When the template is copied into a week (the week is entered), a pair of it
 * falling under a session record with an end time on that date is copied as
 * already taken out by that record — the record holds that part of the day.
 * The record's id, or null. Only a record that takes the pair over entirely
 * (the whole group's, or the pair's own subgroup's) does so.
 */
function timedRecordOver(db, semester, groupId, weekNumber, row) {
    if (row.is_removed || row.kind === 'event') {
        return null;
    }

    const date = addDaysToIsoDate(semester.start_date, (weekNumber - 1) * 7 + row.day_of_week - 1);
    const record = db.prepare(`
        SELECT id FROM attestations
        WHERE group_id = ? AND date = ? AND time_end IS NOT NULL AND time_start < ? AND time_end > ?
          AND (subgroup = 0 OR (? != 0 AND subgroup = ?))
        ORDER BY id LIMIT 1
    `).get(scheduleGroupId(db, groupId), date, row.time_end, row.time_start, row.subgroup, row.subgroup);
    return record ? record.id : null;
}

/**
 * Undoes hidePairsOnDate for one record that moved or was deleted: its pairs
 * show again on that date and count again. A pair whose time has since been
 * taken — by another pair, or by another session record with an end time —
 * stays removed; the mark is cleared either way. A week the record made its own stays its own —
 * its rows are the template's of that week, so students see the same thing.
 * Returns how many pairs came back.
 */
function restorePairsHiddenBy(db, attestationId) {
    const hidden = db.prepare('SELECT * FROM lessons WHERE hidden_by_attestation = ? AND is_removed = 1').all(attestationId);
    const show = db.prepare('UPDATE lessons SET is_removed = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    let restored = 0;

    for (const row of hidden) {
        const taken = findWeekSlotOccupant(db, {
            semesterId: row.semester_id, groupId: row.group_id, weekNumber: row.specific_week, dayOfWeek: row.day_of_week,
            timeStart: row.time_start, timeEnd: row.time_end, subgroup: row.subgroup, ignoreLessonId: row.id
        });

        const semester = taken ? null : getSemesterById(db, row.semester_id);
        const underRecord = semester && timedAttestationError(db, semester, { ...row, is_removed: 0 }, attestationId);

        if (!taken && !underRecord) {
            restored += show.run(row.id).changes;
        }
    }

    db.prepare('UPDATE lessons SET hidden_by_attestation = NULL WHERE hidden_by_attestation = ?').run(attestationId);
    return restored;
}

module.exports = { hidePairsOnDate, restorePairsHiddenBy, timedRecordOver };
