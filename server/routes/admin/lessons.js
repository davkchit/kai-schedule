// Lessons: the constructor's create / edit / delete, versioned so the past never changes.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { formatLocalDate, getSemesterWeekMeta, getSemesterWeekType } = require('../../utils/date');
const { resolveTemplateLessons } = require('../../utils/templateResolve');
const { joinedMemberError, scheduleGroupId } = require('../../utils/groupJoin');
const { findTemplateSlotOccupant, findWeekSlotOccupant } = require('../../utils/slots');
const { templateWeekForSlot } = require('../../utils/templateWeek');
const { findAttestationsUnderLesson } = require('../../utils/attestationConflicts');
const { getActiveSemester, getSemesterById } = require('../../utils/semesters');
const { validateLessonCreateBody, validateLessonUpdateBody } = require('../../validation');
const {
    SEMESTER_CLOSED,
    findClosedSemester,
    NO_WORKING_SEMESTER,
    forKind,
    getClientAddress,
    resolveTeacherDiscipline,
    weekBeyondSemesterError
} = require('./shared');

const router = express.Router();

router.get('/lessons', (req, res) => {
    const db = getDb();
    const groupId = Number.parseInt(req.query.group_id, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Укажите корректный group_id' });
    }

    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    // The constructor shows one semester at a time — the working one unless a
    // specific semester is asked for. Mixing semesters here would put autumn's
    // pairs into spring's grid, where editing them rewrites autumn.
    let semester;

    if (req.query.semester_id) {
        semester = getSemesterById(db, Number.parseInt(req.query.semester_id, 10));

        if (!semester) {
            return res.status(404).json({ error: 'Семестр не найден' });
        }
    } else {
        semester = getActiveSemester(db);
    }

    if (!semester) {
        return res.json([]);
    }

    const rows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ?
        ORDER BY day_of_week, sort_order, time_start
    `).all(semester.id, scheduleGroupId(db, groupId));

    res.json(rows);
});

router.post('/lessons', (req, res) => {
    let payload;

    try {
        payload = validateLessonCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(payload.group_id);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    const joinedError = joinedMemberError(db, payload.group_id);

    if (joinedError) {
        return res.status(409).json({ error: joinedError });
    }

    // Only matters for template rows (specific_week IS NULL) — always the real
    // current week, never client-supplied, so a version can never claim to have
    // taken effect in the past and silently rewrite what earlier weeks showed.
    // New pairs go into the working semester, and "now" is measured in its weeks.
    const semester = getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    const beyond = payload.is_removed ? null : weekBeyondSemesterError(semester, payload.specific_week);

    if (beyond) {
        return res.status(409).json(beyond);
    }

    const currentWeek = getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;

    // teacher_id/discipline_id chosen from the dropdown are resolved to the
    // dictionary's OWN current text — the app never trusts text sent
    // alongside an id, so the schedule and the load plan can never show the
    // same person under two spellings. No id at all stays valid (kind=
    // 'event', or a one-off nobody wants tracked): the row keeps whatever
    // text was given and simply matches no plan row's hours.
    let identity;

    try {
        identity = resolveTeacherDiscipline(db, {
            teacherId: payload.teacher_id, teacherText: payload.teacher,
            disciplineId: payload.discipline_id, disciplineText: payload.subject
        });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    ({ identity, lessonType: payload.lesson_type } = forKind(payload.kind, identity, payload.lesson_type, payload.subject));

    // An edit in the template view is a new version of an existing row. It
    // must be allowed into the cell that row occupies. Nothing here needs to
    // "inherit" whether it counts toward anyone's hours any more — that is
    // decided live, by whether THIS version's own teacher_id/discipline_id
    // match a plan row, every time hours are asked for. A substitute or a
    // swapped-in discipline simply carries different ids and stops matching
    // the old plan row on its own, with no separate step.
    let replaced = null;

    if (payload.replaces_lesson_id !== null) {
        replaced = db.prepare('SELECT * FROM lessons WHERE id = ?').get(payload.replaces_lesson_id);

        if (
            !replaced || replaced.group_id !== payload.group_id || replaced.semester_id !== semester.id
            || replaced.specific_week !== null || payload.specific_week !== null
        ) {
            return res.status(409).json({ error: 'Изменяемая пара не найдена в шаблоне этой группы — обновите страницу' });
        }
    } else if (payload.is_removed && payload.specific_week === null) {
        // A removal sent without naming its row still needs to find it, to
        // retire the right slot rather than insert a stray tombstone.
        replaced = resolveTemplateLessons(db.prepare(`
            SELECT * FROM lessons
            WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL
              AND day_of_week = ? AND time_start = ? AND time_end = ? AND subgroup = ? AND week_type = ?
        `).all(
            semester.id, payload.group_id, payload.day_of_week, payload.time_start, payload.time_end,
            payload.subgroup, payload.week_type
        ), currentWeek)[0] || null;
    }

    // From which week a template change applies — see templateWeekForSlot.
    // A pair moved to another cell keeps ONE occurrence in the current week:
    // both halves start in the later of the two cells' weeks, so a Monday
    // pair already taught is not also held on Friday, and a Friday pair moved
    // to an already-past Monday is not lost this week.
    let templateFromWeek = currentWeek;

    if (payload.specific_week === null) {
        const newCellWeek = templateWeekForSlot(semester, payload.day_of_week, payload.time_end);
        const oldCellWeek = replaced ? templateWeekForSlot(semester, replaced.day_of_week, replaced.time_end) : null;

        if (replaced && payload.is_removed) {
            templateFromWeek = oldCellWeek;
        } else {
            templateFromWeek = Math.max(newCellWeek, oldCellWeek ?? newCellWeek);
        }
    }

    // Without this, an "every week" pair could be created into a cell that
    // already holds a чётная/нечётная one (the constructor's template view
    // filters by exact parity, so such a cell looks empty). The result was two
    // lessons rendered in one slot for students and double-counted hours for
    // the teacher — see the slot-collision tests.
    const occupant = payload.specific_week === null
        ? findTemplateSlotOccupant(db, {
            semesterId: semester.id,
            groupId: payload.group_id,
            dayOfWeek: payload.day_of_week,
            timeStart: payload.time_start,
            timeEnd: payload.time_end,
            subgroup: payload.subgroup,
            weekType: payload.week_type,
            targetWeek: templateFromWeek,
            ignoreLessonId: replaced ? replaced.id : null
        })
        : findWeekSlotOccupant(db, {
            semesterId: semester.id,
            groupId: payload.group_id,
            weekNumber: payload.specific_week,
            dayOfWeek: payload.day_of_week,
            timeStart: payload.time_start,
            timeEnd: payload.time_end,
            subgroup: payload.subgroup
        });

    if (occupant && !payload.is_removed) {
        return res.status(409).json({
            error: `В этой ячейке уже есть занятие: ${occupant.subject}. Откройте его, чтобы изменить, или сначала уберите.`
        });
    }

    const insertLesson = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order,
            kind, semester_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const slotKey = (row) => [row.day_of_week, row.time_start, row.time_end, row.subgroup, row.week_type].join('|');

    // A version that has not shown in any week yet (made this week for a
    // day still ahead, or for next week): nothing in the past depends on it.
    const notYetLive = Boolean(replaced) && !replaced.is_removed && replaced.template_from_week >= templateFromWeek;

    const createdId = db.transaction(() => {
        if (notYetLive && payload.is_removed) {
            // Removed before it ever showed: the row goes, and the older
            // version it covered must not come back — the cell is retired.
            db.prepare('DELETE FROM lessons WHERE id = ?').run(replaced.id);
            return retireTemplateCell(db, semester.id, replaced, templateFromWeek);
        }

        if (notYetLive && slotKey(replaced) !== slotKey(payload)) {
            // Moved to another cell before it ever showed: corrected in place,
            // the older version under it reappeared in the old cell. The row
            // goes, the old cell is retired from this week, and the new cell
            // gets the pair below.
            db.prepare('DELETE FROM lessons WHERE id = ?').run(replaced.id);
            retireTemplateCell(db, semester.id, replaced, templateFromWeek);
        } else if (notYetLive && !payload.is_removed) {
            // Same cell, not live yet: the row itself is corrected instead of
            // stacking versions (the older one stays covered by it).
            db.prepare(`
                UPDATE lessons SET
                    subgroup = ?, day_of_week = ?, week_type = ?, time_start = ?, time_end = ?,
                    subject = ?, room = ?, lesson_type = ?, teacher = ?, teacher_id = ?, discipline_id = ?,
                    kind = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                payload.subgroup, payload.day_of_week, payload.week_type, payload.time_start, payload.time_end,
                identity.discipline, payload.room, payload.lesson_type, identity.teacher, identity.teacherId, identity.disciplineId,
                payload.kind, replaced.id
            );
            return replaced.id;
        } else if (replaced && !payload.is_removed && slotKey(replaced) !== slotKey(payload)) {
            // Moving to another cell or parity: the old cell is retired from
            // this week, as move-lesson does, keeping its own identity — it
            // is a tombstone of what WAS there, not of the new version.
            insertLesson.run(
                replaced.group_id, replaced.subgroup, replaced.day_of_week, replaced.week_type, null,
                templateFromWeek, 1,
                replaced.time_start, replaced.time_end, replaced.subject, replaced.room,
                replaced.lesson_type, replaced.teacher, replaced.teacher_id, replaced.discipline_id, replaced.sort_order,
                replaced.kind, semester.id
            );
        }

        if (replaced && payload.is_removed) {
            // Hide exactly the row being removed, even if the form's fields were
            // touched before pressing "убрать".
            return insertLesson.run(
                replaced.group_id, replaced.subgroup, replaced.day_of_week, replaced.week_type, null,
                templateFromWeek, 1,
                replaced.time_start, replaced.time_end, replaced.subject, replaced.room,
                replaced.lesson_type, replaced.teacher, replaced.teacher_id, replaced.discipline_id, replaced.sort_order,
                replaced.kind, semester.id
            ).lastInsertRowid;
        }

        return insertLesson.run(
            payload.group_id,
            payload.subgroup,
            payload.day_of_week,
            payload.week_type,
            payload.specific_week,
            templateFromWeek,
            payload.is_removed ? 1 : 0,
            payload.time_start,
            payload.time_end,
            identity.discipline,
            payload.room,
            payload.lesson_type,
            identity.teacher,
            identity.teacherId,
            identity.disciplineId,
            payload.sort_order,
            payload.kind,
            semester.id
        ).lastInsertRowid;
    })();

    const created = db.prepare('SELECT * FROM lessons WHERE id = ?').get(createdId);

    // Weeks from now on that already have their own rows ignore the template
    // (no merging) — so this change will not show up in them. Said out loud,
    // otherwise "I changed the room" silently doesn't apply to week 12.
    const ownWeeksAhead = payload.specific_week === null
        ? db.prepare(`
            SELECT DISTINCT specific_week FROM lessons
            WHERE semester_id = ? AND group_id = ? AND specific_week >= ?
            ORDER BY specific_week
        `).all(semester.id, payload.group_id, templateFromWeek).map((row) => row.specific_week)
        : [];

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.create',
        entityType: 'lesson',
        entityId: created.id,
        ipAddress: getClientAddress(req),
        details: {
            group_id: payload.group_id,
            subject: created.subject,
            day_of_week: created.day_of_week,
            time_start: created.time_start,
            time_end: created.time_end,
            specific_week: created.specific_week
        }
    });

    res.status(201).json({
        ...created,
        own_weeks_ahead: ownWeeksAhead,
        attestation_warnings: findAttestationsUnderLesson(db, semester, created)
    });
});

/**
 * The same new pair for other groups too — a lecture the whole stream
 * attends. The constructor saves the pair for its own group the usual way and
 * sends the other groups here: first with dry_run, before saving anything, so
 * a taken cell in 23404 stops the whole thing instead of leaving the lecture
 * in 23403 only; then for real, all groups in one transaction.
 *
 * A week that is still the template's for a group is refused when that
 * template has pairs this week: one row of its own would make the week "its
 * own" and hide the rest (the constructor materializes such a week first —
 * the specialist does that from the group itself). With an empty template
 * there is nothing to hide, and the pair is just added.
 */
router.post('/lessons/for-groups', (req, res) => {
    const rawIds = Array.isArray(req.body?.group_ids) ? req.body.group_ids : [];
    const groupIds = [...new Set(rawIds.map(Number))];

    if (groupIds.length === 0 || groupIds.length > 8 || groupIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        return res.status(400).json({ error: 'Укажите от 1 до 8 групп' });
    }

    let payload;

    try {
        payload = validateLessonCreateBody({ ...req.body, group_id: groupIds[0] });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    if (payload.is_removed) {
        return res.status(400).json({ error: 'Убрать пару сразу у нескольких групп нельзя' });
    }

    const db = getDb();
    const semester = getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    const beyond = weekBeyondSemesterError(semester, payload.specific_week);

    if (beyond) {
        return res.status(409).json(beyond);
    }

    let identity;

    try {
        identity = resolveTeacherDiscipline(db, {
            teacherId: payload.teacher_id, teacherText: payload.teacher,
            disciplineId: payload.discipline_id, disciplineText: payload.subject
        });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    ({ identity, lessonType: payload.lesson_type } = forKind(payload.kind, identity, payload.lesson_type, payload.subject));

    // A new template pair starts next week if its day this week is already over.
    const templateFromWeek = payload.specific_week === null
        ? templateWeekForSlot(semester, payload.day_of_week, payload.time_end)
        : getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;
    const problems = [];

    for (const groupId of groupIds) {
        const group = db.prepare('SELECT id, name FROM groups_ WHERE id = ?').get(groupId);

        if (!group) {
            return res.status(404).json({ error: 'Группа не найдена' });
        }

        const joinedError = joinedMemberError(db, groupId);

        if (joinedError) {
            problems.push(joinedError.replace(/\.$/, ''));
            continue;
        }

        const occupant = payload.specific_week === null
            ? findTemplateSlotOccupant(db, {
                semesterId: semester.id, groupId, dayOfWeek: payload.day_of_week,
                timeStart: payload.time_start, timeEnd: payload.time_end, subgroup: payload.subgroup,
                weekType: payload.week_type, targetWeek: templateFromWeek, ignoreLessonId: null
            })
            : findWeekSlotOccupant(db, {
                semesterId: semester.id, groupId, weekNumber: payload.specific_week, dayOfWeek: payload.day_of_week,
                timeStart: payload.time_start, timeEnd: payload.time_end, subgroup: payload.subgroup
            });

        if (occupant) {
            problems.push(`у ${group.name} в это время уже стоит ${occupant.subject}`);
            continue;
        }

        if (payload.specific_week !== null && templateHasPairsThisWeek(db, semester, groupId, payload.specific_week)) {
            problems.push(`у ${group.name} эта неделя ещё идёт по шаблону — добавьте пару в ней отдельно`);
        }
    }

    if (problems.length > 0) {
        return res.status(409).json({ error: `Не добавлено ни в одну группу: ${problems.join('; ')}.` });
    }

    if (req.body.dry_run) {
        return res.json({ ok: true });
    }

    const insertLesson = db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order,
            kind, semester_id
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const createdIds = db.transaction(() => groupIds.map((groupId) => insertLesson.run(
        groupId, payload.subgroup, payload.day_of_week, payload.week_type, payload.specific_week,
        templateFromWeek, payload.time_start, payload.time_end,
        identity.discipline, payload.room, payload.lesson_type, identity.teacher, identity.teacherId, identity.disciplineId,
        payload.sort_order, payload.kind, semester.id
    ).lastInsertRowid))();

    groupIds.forEach((groupId, index) => writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.create',
        entityType: 'lesson',
        entityId: createdIds[index],
        ipAddress: getClientAddress(req),
        details: {
            group_id: groupId,
            subject: identity.discipline,
            day_of_week: payload.day_of_week,
            time_start: payload.time_start,
            time_end: payload.time_end,
            specific_week: payload.specific_week,
            together_with_groups: groupIds.length
        }
    }));

    res.status(201).json({ created: createdIds.length });
});

/**
 * Empties one template cell (the cell of `row`: day, times, subgroup, parity)
 * from `week` on, with a removed marker. It copies whatever version the cell
 * shows at that week — so that version's identity, and the hours tied to it,
 * stop there — or `row` itself when nothing shows. Returns the marker's id.
 */
function retireTemplateCell(db, semesterId, row, week) {
    const cellRows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL
          AND day_of_week = ? AND time_start = ? AND time_end = ? AND subgroup = ? AND week_type = ?
    `).all(semesterId, row.group_id, row.day_of_week, row.time_start, row.time_end, row.subgroup, row.week_type);
    const source = resolveTemplateLessons(cellRows, week)[0] || row;

    return db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order, kind, semester_id
        ) VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        source.group_id, source.subgroup, source.day_of_week, source.week_type, week,
        source.time_start, source.time_end, source.subject, source.room, source.lesson_type, source.teacher,
        source.teacher_id, source.discipline_id, source.sort_order, source.kind, semesterId
    ).lastInsertRowid;
}

function templateHasPairsThisWeek(db, semester, groupId, weekNumber) {
    const ownRows = db.prepare('SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1')
        .get(semester.id, groupId, weekNumber);

    if (ownRows) {
        return false;
    }

    const weekType = getSemesterWeekType(semester, weekNumber);
    const templateRows = db.prepare(`
        SELECT * FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
    `).all(semester.id, groupId, weekType);

    return resolveTemplateLessons(templateRows, weekNumber).length > 0;
}

router.put('/lessons/:id', (req, res) => {
    const db = getDb();
    const lessonId = Number(req.params.id);

    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID занятия' });
    }

    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    if (findClosedSemester(db, lesson.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    // This endpoint is for a week's own row (specific_week set) — an in-place
    // UPDATE on a live template row (specific_week IS NULL) would rewrite what
    // every week shows, past ones included, since resolveTemplateLessons picks
    // by template_from_week and this endpoint never advances it. Editing a
    // template pair has to go through POST /lessons with replaces_lesson_id,
    // which forks a new version "from now forward" instead of mutating in place.
    if (lesson.specific_week === null) {
        return res.status(409).json({ error: 'Это пара из шаблона — редактируйте через версию (POST /lessons с replaces_lesson_id), не напрямую' });
    }

    let updates;

    try {
        updates = validateLessonUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    // The week a row belongs to is what makes that week "its own": moving the
    // row to another week (or to null — the template) would empty one week
    // back onto the template and hide the template of the other. Edits here
    // stay inside the row's week; another week means a pair entered there.
    if (updates.specific_week !== undefined && updates.specific_week !== lesson.specific_week) {
        return res.status(409).json({ error: 'Неделю пары так менять нельзя — добавьте пару в нужной неделе, а здесь уберите' });
    }

    let identity;

    try {
        identity = resolveTeacherDiscipline(db, {
            teacherId: updates.teacher_id !== undefined ? updates.teacher_id : lesson.teacher_id,
            teacherText: updates.teacher !== undefined ? updates.teacher : lesson.teacher,
            disciplineId: updates.discipline_id !== undefined ? updates.discipline_id : lesson.discipline_id,
            disciplineText: updates.subject !== undefined ? updates.subject : lesson.subject
        });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const nextKind = updates.kind ?? lesson.kind;
    const shaped = forKind(nextKind, identity, updates.lesson_type !== undefined ? updates.lesson_type : lesson.lesson_type, updates.subject !== undefined ? updates.subject : lesson.subject);
    identity = shaped.identity;

    const nextLesson = {
        ...lesson,
        ...updates,
        kind: nextKind,
        lesson_type: shaped.lessonType,
        teacher: identity.teacher,
        teacher_id: identity.teacherId,
        subject: identity.discipline,
        discipline_id: identity.disciplineId
    };

    if (nextLesson.time_start >= nextLesson.time_end) {
        return res.status(400).json({ error: 'Время окончания должно быть позже времени начала' });
    }

    // In-place edits are for one week's own rows; moving such a row onto a
    // cell another pair of that week already holds would show two at once.
    if (nextLesson.specific_week !== null) {
        const occupant = findWeekSlotOccupant(db, {
            semesterId: lesson.semester_id,
            groupId: lesson.group_id,
            weekNumber: nextLesson.specific_week,
            dayOfWeek: nextLesson.day_of_week,
            timeStart: nextLesson.time_start,
            timeEnd: nextLesson.time_end,
            subgroup: nextLesson.subgroup,
            ignoreLessonId: lessonId
        });

        if (occupant && !lesson.is_removed) {
            return res.status(409).json({ error: `В этой ячейке уже есть занятие: ${occupant.subject}` });
        }
    }

    db.prepare(`
        UPDATE lessons SET
            subgroup = ?,
            day_of_week = ?,
            week_type = ?,
            specific_week = ?,
            time_start = ?,
            time_end = ?,
            subject = ?,
            room = ?,
            lesson_type = ?,
            teacher = ?,
            teacher_id = ?,
            discipline_id = ?,
            sort_order = ?,
            kind = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        nextLesson.subgroup,
        nextLesson.day_of_week,
        nextLesson.week_type,
        nextLesson.specific_week,
        nextLesson.time_start,
        nextLesson.time_end,
        nextLesson.subject,
        nextLesson.room,
        nextLesson.lesson_type,
        nextLesson.teacher,
        nextLesson.teacher_id,
        nextLesson.discipline_id,
        nextLesson.sort_order,
        nextLesson.kind,
        lessonId
    );

    const updated = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.update',
        entityType: 'lesson',
        entityId: lessonId,
        ipAddress: getClientAddress(req),
        details: {
            before: {
                subgroup: lesson.subgroup,
                day_of_week: lesson.day_of_week,
                week_type: lesson.week_type,
                specific_week: lesson.specific_week,
                time_start: lesson.time_start,
                time_end: lesson.time_end,
                subject: lesson.subject,
                room: lesson.room,
                lesson_type: lesson.lesson_type,
                teacher: lesson.teacher,
                sort_order: lesson.sort_order
            },
            after: {
                subgroup: updated.subgroup,
                day_of_week: updated.day_of_week,
                week_type: updated.week_type,
                specific_week: updated.specific_week,
                time_start: updated.time_start,
                time_end: updated.time_end,
                subject: updated.subject,
                room: updated.room,
                lesson_type: updated.lesson_type,
                teacher: updated.teacher,
                sort_order: updated.sort_order
            }
        }
    });
    const lessonSemester = getSemesterById(db, updated.semester_id);
    res.json({ ...updated, attestation_warnings: lessonSemester ? findAttestationsUnderLesson(db, lessonSemester, updated) : [] });
});

router.delete('/lessons/:id', (req, res) => {
    const db = getDb();
    const lessonId = Number(req.params.id);

    if (!Number.isInteger(lessonId) || lessonId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID занятия' });
    }

    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    if (findClosedSemester(db, lesson.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    // "Has this row already been live?" is asked in the row's OWN semester.
    // Measured against another semester's calendar, an autumn pair deleted in
    // February looked brand new (spring week 1) and was hard-deleted — taking
    // every autumn week it had run in, and those hours, with it.
    const semester = getSemesterById(db, lesson.semester_id) || getActiveSemester(db);
    // For a template row: if its pair this week has already been held, it is
    // retired from next week, so that pair (and its hours) stays.
    const currentWeek = !semester ? 1 : lesson.specific_week === null
        ? templateWeekForSlot(semester, lesson.day_of_week, lesson.time_end)
        : getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;

    // A template row that has already been live in earlier weeks is retired
    // with a tombstone from this week forward, never erased: hard-deleting it
    // would remove it from the PAST too, wiping hours a teacher had already
    // taught. That is the same rule move-lesson uses; delete used to be the
    // one edit path that still rewrote history.
    const isLiveTemplateRow = lesson.specific_week === null
        && lesson.is_removed === 0
        && lesson.template_from_week < currentWeek;

    if (isLiveTemplateRow) {
        db.prepare(`
            INSERT INTO lessons (
                group_id, subgroup, day_of_week, week_type, specific_week,
                template_from_week, is_removed,
                time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order,
                kind, semester_id
            )
            VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            lesson.group_id, lesson.subgroup, lesson.day_of_week, lesson.week_type,
            currentWeek,
            lesson.time_start, lesson.time_end, lesson.subject, lesson.room,
            lesson.lesson_type, lesson.teacher, lesson.teacher_id, lesson.discipline_id, lesson.sort_order,
            lesson.kind, lesson.semester_id
        );
    } else if (isLastVisibleWeekRow(db, lesson)) {
        // Deleting a week's last pair must still leave the week "its own" —
        // with no rows left, the template would take the week back and the
        // pair just cancelled would reappear (and be counted again).
        db.prepare('UPDATE lessons SET is_removed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(lessonId);
    } else if (lesson.specific_week === null && !lesson.is_removed) {
        // A template version that has not shown yet: erased, and its cell is
        // retired from this week, or the older version it covered would come
        // back as if nothing had been deleted.
        db.transaction(() => {
            db.prepare('DELETE FROM lessons WHERE id = ?').run(lessonId);
            retireTemplateCell(db, lesson.semester_id, lesson, currentWeek);
        })();
    } else {
        // Never been live in a past week (created this week or later), or it is
        // one of several rows of a single week — nothing else depends on it.
        db.prepare('DELETE FROM lessons WHERE id = ?').run(lessonId);
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: isLiveTemplateRow ? 'lesson.retire' : 'lesson.delete',
        entityType: 'lesson',
        entityId: lessonId,
        ipAddress: getClientAddress(req),
        details: {
            group_id: lesson.group_id,
            subject: lesson.subject,
            day_of_week: lesson.day_of_week,
            time_start: lesson.time_start,
            time_end: lesson.time_end,
            specific_week: lesson.specific_week,
            retired_from_week: isLiveTemplateRow ? currentWeek : null
        }
    });

    res.json({ success: true, deleted: lessonId, retired_from_week: isLiveTemplateRow ? currentWeek : null });
});

function isLastVisibleWeekRow(db, lesson) {
    if (lesson.specific_week === null || lesson.is_removed) {
        return false;
    }

    const others = db.prepare(`
        SELECT COUNT(*) AS count FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week = ? AND is_removed = 0 AND id != ?
    `).get(lesson.semester_id, lesson.group_id, lesson.specific_week, lesson.id).count;

    return others === 0;
}

module.exports = router;
