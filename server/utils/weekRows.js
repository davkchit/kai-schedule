const { getSemesterWeekMeta } = require('./date');
const { resolveTemplateLessons } = require('./templateResolve');

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
 * or that week's own rows) of the group's schedule owner `groupId`.
 */
function hidePairsOnDate(db, semester, groupId, isoDate, pairs) {
    if (pairs.length === 0) {
        return 0;
    }

    const { weekNumber, weekTypeNumber } = getSemesterWeekMeta(semester, isoDate);
    const ids = new Set(pairs.map((pair) => pair.id));
    const ownWeek = db.prepare('SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1')
        .get(semester.id, groupId, weekNumber);

    if (ownWeek) {
        const hide = db.prepare('UPDATE lessons SET is_removed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND specific_week = ?');
        return pairs.reduce((count, pair) => count + hide.run(pair.id, weekNumber).changes, 0);
    }

    const templateRows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
    `).all(semester.id, groupId, weekTypeNumber);
    const insert = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order, kind, semester_id
        ) VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let hidden = 0;

    resolveTemplateLessons(templateRows, weekNumber).forEach((row, index) => {
        const removed = ids.has(row.id) ? 1 : 0;
        hidden += removed;
        insert.run(
            groupId, row.subgroup, row.day_of_week, weekNumber, removed,
            row.time_start, row.time_end, row.subject, row.room, row.lesson_type, row.teacher,
            row.teacher_id, row.discipline_id, index, row.kind || 'lesson', semester.id
        );
    });

    return hidden;
}

module.exports = { hidePairsOnDate };
