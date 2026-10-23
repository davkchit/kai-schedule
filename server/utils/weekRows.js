const { getSemesterWeekMeta } = require('./date');
const { resolveTemplateLessons } = require('./templateResolve');
const { findWeekSlotOccupant } = require('./slots');
const { timedAttestationError } = require('./attestationConflicts');
const { getSemesterById } = require('./semesters');

/**
 * Takes pairs out of ONE date — an exam or a credit held in their place — so
 * students no longer see them that day and they stop counting toward hours.
 *
 * A week with its own rows: the pairs get the removed marker. A week still
 * run by the template: it first becomes its own (the template's pairs of that
 * week copied, exactly as the constructor's materialize-week does), with these
 * pairs copied as removed — so the rest of the week is unchanged and the
 * template itself, and every other week, is untouched.
 *
 * `pairs` are lesson rows as the day resolution returns them (template rows
 * or that week's own rows) of the group's schedule owner `groupId`. Hidden
 * rows carry `attestationId`, so restorePairsHiddenBy can bring them back.
 */
function hidePairsOnDate(db, semester, groupId, isoDate, pairs, attestationId = null) {
    if (pairs.length === 0) {
        return 0;
    }

    const { weekNumber, weekTypeNumber } = getSemesterWeekMeta(semester, isoDate);
    const ids = new Set(pairs.map((pair) => pair.id));
    const ownWeek = db.prepare('SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1')
        .get(semester.id, groupId, weekNumber);

    if (ownWeek) {
        const hide = db.prepare('UPDATE lessons SET is_removed = 1, hidden_by_attestation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND specific_week = ? AND is_removed = 0');
        return pairs.reduce((count, pair) => count + hide.run(attestationId, pair.id, weekNumber).changes, 0);
    }

    const templateRows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
    `).all(semester.id, groupId, weekTypeNumber);
    const insert = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order, kind, semester_id,
            hidden_by_attestation
        ) VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let hidden = 0;

    resolveTemplateLessons(templateRows, weekNumber).forEach((row, index) => {
        const removed = ids.has(row.id) ? 1 : 0;
        hidden += removed;
        insert.run(
            groupId, row.subgroup, row.day_of_week, weekNumber, removed,
            row.time_start, row.time_end, row.subject, row.room, row.lesson_type, row.teacher,
            row.teacher_id, row.discipline_id, index, row.kind || 'lesson', semester.id,
            removed ? attestationId : null
        );
    });

    return hidden;
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

module.exports = { hidePairsOnDate, restorePairsHiddenBy };
