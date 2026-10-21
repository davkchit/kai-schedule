// Schedule, one week at a time: drag-and-drop moves, the first edit of a week (materialize), clearing a week.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const {
    formatLocalDate,
    getSemesterWeekMeta,
    getSemesterWeekType
} = require('../../utils/date');
const { resolveTemplateLessons } = require('../../utils/templateResolve');
const { joinedMemberError, scheduleGroupId } = require('../../utils/groupJoin');
const { attachPlanGroups } = require('../../utils/planGroups');
const { computePlanRowProgress } = require('../../utils/planProgress');
const { findTemplateSlotOccupant, findWeekSlotOccupant, lessonsClash } = require('../../utils/slots');
const { templateWeekForSlot } = require('../../utils/templateWeek');
const { findAttestationsUnderLesson } = require('../../utils/attestationConflicts');
const { getActiveSemester, getSemesterById } = require('../../utils/semesters');
const {
    validateMaterializeWeekBody,
    validateMoveLessonBody
} = require('../../validation');
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

/**
 * Moves one lesson to a different day/time slot — what a drag-and-drop in the
 * builder ends up calling. Deliberately built on the same primitives the
 * normal edit flows already use rather than new logic:
 *
 * - template mode: append a tombstone at the old slot + a new row at the new
 *   one, both stamped from the current week, so past weeks keep resolving to
 *   where the lesson actually was (the same "edits never rewrite history"
 *   guarantee every other template edit has).
 * - week mode, already materialized: the row is real, so just move it.
 * - week mode, not yet materialized: clone the week's resolved template into
 *   real rows exactly like materialize-week does, but drop the moved lesson
 *   at its new slot instead of the old one.
 *
 * Every branch runs inside a single transaction: a move can't half-apply and
 * leave the lesson both gone from the old slot and missing from the new one.
 */
router.post('/schedule/move-lesson', (req, res) => {
    let payload;

    try {
        payload = validateMoveLessonBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(payload.lesson_id);

    if (!lesson) {
        return res.status(404).json({ error: 'Занятие не найдено' });
    }

    const isSameSlot =
        lesson.day_of_week === payload.day_of_week &&
        lesson.time_start === payload.time_start &&
        lesson.time_end === payload.time_end;

    if (isSameSlot) {
        return res.json({ success: true, moved: false });
    }

    // Week numbers only mean something within the lesson's own semester —
    // moving an autumn pair must never be measured against spring's calendar.
    const semester = getSemesterById(db, lesson.semester_id) || getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    // The page may be stale — another tab may have changed that week since.
    // The pair must be what the view shows: a template row in the template
    // view; in a week view, a row of that very week once it has rows of its
    // own, a template row while it has none. Otherwise a template row dragged
    // in a stale tab was moved in place, rewriting every past week it ran in.
    const weekIsOwn = payload.mode === 'week' && Boolean(db.prepare(
        'SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1'
    ).get(semester.id, lesson.group_id, payload.week_number));
    const fitsTheView = !lesson.is_removed && (payload.mode === 'template' || !weekIsOwn
        ? lesson.specific_week === null
        : lesson.specific_week === payload.week_number);

    if (!fitsTheView) {
        return res.status(409).json({ error: 'Расписание этой недели уже изменилось — обновите страницу' });
    }

    // Template mode: one week for both halves, the later of the two cells'
    // (templateWeekForSlot) — the pair keeps exactly one occurrence this week.
    const currentWeek = payload.mode === 'template'
        ? Math.max(
            templateWeekForSlot(semester, lesson.day_of_week, lesson.time_end),
            templateWeekForSlot(semester, payload.day_of_week, payload.time_end)
        )
        : getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;

    const insertLesson = () => db.prepare(`
        INSERT INTO lessons (
            group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order,
            kind, semester_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
        if (payload.mode === 'template') {
            // Shared with POST /lessons: resolves through tombstones (so an
            // emptied cell reads as free) and treats "every week" as
            // overlapping both parities (the raw query this replaced did not,
            // so an "every week" pair could be dropped onto a чётная one).
            const occupied = findTemplateSlotOccupant(db, {
                semesterId: semester.id,
                groupId: lesson.group_id,
                dayOfWeek: payload.day_of_week,
                timeStart: payload.time_start,
                timeEnd: payload.time_end,
                subgroup: lesson.subgroup,
                weekType: lesson.week_type,
                targetWeek: currentWeek,
                ignoreLessonId: lesson.id
            });

            if (occupied) {
                return res.status(409).json({ error: `В этой ячейке уже есть занятие: ${occupied.subject}` });
            }

            const transaction = db.transaction(() => {
                const statement = insertLesson();

                // Tombstone at the old slot, effective from this week forward.
                statement.run(
                    lesson.group_id, lesson.subgroup, lesson.day_of_week, lesson.week_type, null,
                    currentWeek, 1,
                    lesson.time_start, lesson.time_end, lesson.subject, lesson.room,
                    lesson.lesson_type, lesson.teacher, lesson.teacher_id, lesson.discipline_id, lesson.sort_order,
                    lesson.kind, semester.id
                );

                // Same lesson, new slot, same effective week.
                statement.run(
                    lesson.group_id, lesson.subgroup, payload.day_of_week, lesson.week_type, null,
                    currentWeek, 0,
                    payload.time_start, payload.time_end, lesson.subject, lesson.room,
                    lesson.lesson_type, lesson.teacher, lesson.teacher_id, lesson.discipline_id, lesson.sort_order,
                    lesson.kind, semester.id
                );
            });

            transaction();
        } else {
            const beyond = weekBeyondSemesterError(semester, payload.week_number);

            if (beyond) {
                return res.status(409).json(beyond);
            }

            const alreadyMaterialized = db.prepare(
                'SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1'
            ).get(semester.id, lesson.group_id, payload.week_number);

            const occupied = findWeekSlotOccupant(db, {
                semesterId: semester.id,
                groupId: lesson.group_id,
                weekNumber: payload.week_number,
                dayOfWeek: payload.day_of_week,
                timeStart: payload.time_start,
                timeEnd: payload.time_end,
                subgroup: lesson.subgroup,
                ignoreLessonId: lesson.id
            });

            if (occupied) {
                return res.status(409).json({ error: `В этой ячейке уже есть занятие: ${occupied.subject}` });
            }

            if (alreadyMaterialized) {
                db.prepare(`
                    UPDATE lessons
                    SET day_of_week = ?, time_start = ?, time_end = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(payload.day_of_week, payload.time_start, payload.time_end, lesson.id);
            } else {
                const weekTypeNumber = getSemesterWeekType(semester, payload.week_number);
                const templateRows = db.prepare(`
                    SELECT id, subgroup, day_of_week, week_type, template_from_week, is_removed,
                           time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order,
                           kind
                    FROM lessons
                    WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
                `).all(semester.id, lesson.group_id, weekTypeNumber);

                const resolved = resolveTemplateLessons(templateRows, payload.week_number);
                const movedKey = `${lesson.day_of_week}|${lesson.time_start}|${lesson.time_end}|${lesson.subgroup}`;

                // The week has no rows of its own yet, so the occupant check
                // above saw nothing: the cell may still be filled by the
                // template. Dropping onto it would put two pairs in one cell.
                const target = { day_of_week: payload.day_of_week, time_start: payload.time_start, time_end: payload.time_end, subgroup: lesson.subgroup };
                const templateOccupant = resolved.find((row) => `${row.day_of_week}|${row.time_start}|${row.time_end}|${row.subgroup}` !== movedKey
                    && row.day_of_week === target.day_of_week && lessonsClash(row, target));

                if (templateOccupant) {
                    return res.status(409).json({ error: `В этой ячейке уже есть занятие: ${templateOccupant.subject}` });
                }

                const transaction = db.transaction(() => {
                    const statement = insertLesson();
                    let sortOrder = 0;

                    for (const row of resolved) {
                        const key = `${row.day_of_week}|${row.time_start}|${row.time_end}|${row.subgroup}`;
                        const isMoved = key === movedKey;

                        statement.run(
                            lesson.group_id,
                            row.subgroup,
                            isMoved ? payload.day_of_week : row.day_of_week,
                            0,
                            payload.week_number,
                            1,
                            0,
                            isMoved ? payload.time_start : row.time_start,
                            isMoved ? payload.time_end : row.time_end,
                            row.subject, row.room, row.lesson_type, row.teacher, row.teacher_id, row.discipline_id,
                            sortOrder, row.kind, semester.id
                        );
                        sortOrder += 1;
                    }
                });

                transaction();
            }
        }
    } catch (error) {
        console.error('Move lesson error:', error);
        return res.status(500).json({ error: 'Не удалось перенести занятие' });
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'lesson.move',
        entityType: 'lesson',
        entityId: lesson.id,
        ipAddress: getClientAddress(req),
        details: {
            mode: payload.mode,
            week_number: payload.week_number ?? null,
            from: { day_of_week: lesson.day_of_week, time_start: lesson.time_start, time_end: lesson.time_end },
            to: { day_of_week: payload.day_of_week, time_start: payload.time_start, time_end: payload.time_end }
        }
    });

    res.json({
        success: true,
        moved: true,
        attestation_warnings: findAttestationsUnderLesson(db, semester, {
            ...lesson,
            specific_week: payload.mode === 'template' ? null : payload.week_number,
            template_from_week: currentWeek,
            day_of_week: payload.day_of_week,
            time_start: payload.time_start,
            time_end: payload.time_end
        })
    });
});

router.post('/schedule/materialize-week', (req, res) => {
    let payload;

    try {
        payload = validateMaterializeWeekBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(payload.group_id);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    if (joinedMemberError(db, payload.group_id)) {
        return res.status(409).json({ error: joinedMemberError(db, payload.group_id) });
    }

    // The constructor edits the working semester; "week N" means week N of it.
    const semester = getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    const beyond = payload.action === 'upsert' ? weekBeyondSemesterError(semester, payload.week_number) : null;

    if (beyond) {
        return res.status(409).json(beyond);
    }

    // This endpoint only makes sense the first time a week is touched — once it has
    // its own rows, edits should go through the normal single-lesson endpoints.
    const alreadyMaterialized = db.prepare(
        'SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1'
    ).get(semester.id, payload.group_id, payload.week_number);

    if (alreadyMaterialized) {
        return res.status(409).json({ error: 'Эта неделя уже содержит собственные записи' });
    }

    // The dropdown's ids resolve to the dictionary's own current text, same
    // as POST /lessons — never trust text sent alongside an id.
    let identity = null;

    if (payload.action === 'upsert') {
        try {
            identity = resolveTeacherDiscipline(db, {
                teacherId: payload.teacher_id, teacherText: payload.teacher,
                disciplineId: payload.discipline_id, disciplineText: payload.subject
            });
        } catch (error) {
            return res.status(error.statusCode || 400).json({ error: error.message });
        }

        ({ identity, lessonType: payload.lesson_type } = forKind(payload.kind, identity, payload.lesson_type, payload.subject));
    }

    const weekTypeNumber = getSemesterWeekType(semester, payload.week_number);
    const templateRows = db.prepare(`
        SELECT id, subgroup, day_of_week, week_type, template_from_week, is_removed,
               time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, kind
        FROM lessons
        WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
    `).all(semester.id, payload.group_id, weekTypeNumber);

    const resolved = resolveTemplateLessons(templateRows, payload.week_number);
    const slotKey = (lesson) => `${lesson.day_of_week}|${lesson.time_start}|${lesson.time_end}|${lesson.subgroup}`;
    const touchedKey = `${payload.day_of_week}|${payload.time_start}|${payload.time_end}|${payload.subgroup}`;

    const finalLessons = [];
    let touchedHandled = false;

    for (const lesson of resolved) {
        if (slotKey(lesson) === touchedKey) {
            touchedHandled = true;

            if (payload.action === 'upsert') {
                // Editing a slot in place — a substitute, a swapped-in subject,
                // a room fix — just writes this week's own teacher_id/
                // discipline_id. Whether it counts toward anyone's hours is
                // decided live from those ids every time hours are asked for;
                // nothing here needs to reason about "is this still the same
                // teaching assignment" any more.
                finalLessons.push({
                    touched: true,
                    day_of_week: payload.day_of_week,
                    time_start: payload.time_start,
                    time_end: payload.time_end,
                    subgroup: payload.subgroup,
                    subject: identity.discipline,
                    room: payload.room,
                    lesson_type: payload.lesson_type,
                    teacher: identity.teacher,
                    teacher_id: identity.teacherId,
                    discipline_id: identity.disciplineId,
                    kind: payload.kind
                });
            } else {
                // action === 'remove': kept as a removed marker, never just left
                // out. If this was the week's only pair, leaving it out would
                // insert nothing — the week would have no rows of its own, and
                // the template (with this very pair) would silently apply again,
                // for students and for the hour counter alike.
                finalLessons.push({
                    day_of_week: lesson.day_of_week,
                    time_start: lesson.time_start,
                    time_end: lesson.time_end,
                    subgroup: lesson.subgroup,
                    subject: lesson.subject,
                    room: lesson.room,
                    lesson_type: lesson.lesson_type,
                    teacher: lesson.teacher,
                    teacher_id: lesson.teacher_id,
                    discipline_id: lesson.discipline_id,
                    kind: lesson.kind,
                    is_removed: 1
                });
            }
        } else {
            finalLessons.push({
                day_of_week: lesson.day_of_week,
                time_start: lesson.time_start,
                time_end: lesson.time_end,
                subgroup: lesson.subgroup,
                subject: lesson.subject,
                room: lesson.room,
                lesson_type: lesson.lesson_type,
                teacher: lesson.teacher,
                teacher_id: lesson.teacher_id,
                discipline_id: lesson.discipline_id,
                kind: lesson.kind
            });
        }
    }

    if (!touchedHandled && payload.action === 'upsert') {
        finalLessons.push({
            touched: true,
            day_of_week: payload.day_of_week,
            time_start: payload.time_start,
            time_end: payload.time_end,
            subgroup: payload.subgroup,
            subject: identity.discipline,
            room: payload.room,
            lesson_type: payload.lesson_type,
            teacher: identity.teacher,
            teacher_id: identity.teacherId,
            discipline_id: identity.disciplineId,
            kind: payload.kind
        });
    }

    // The new pair must not land on another one of that week (a whole-group
    // pair over a subgroup's, or overlapping times). Only clashes with the
    // touched pair are checked: an old one elsewhere in the template must not
    // block every edit of the week.
    const touched = finalLessons.find((lesson) => lesson.touched);
    const clash = touched && finalLessons.find((lesson) => lesson !== touched && !lesson.is_removed
        && lesson.day_of_week === touched.day_of_week && lessonsClash(lesson, touched));

    if (clash) {
        return res.status(409).json({ error: `В это время уже есть занятие: ${clash.subject}${clash.subgroup ? ` (${clash.subgroup} п/г)` : ''}` });
    }

    const transaction = db.transaction(() => {
        const insert = db.prepare(`
            INSERT INTO lessons (
                group_id, subgroup, day_of_week, week_type, specific_week,
                template_from_week, is_removed,
                time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order,
                kind, semester_id
            )
            VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let count = 0;

        for (const lesson of finalLessons) {
            insert.run(
                payload.group_id,
                lesson.subgroup,
                lesson.day_of_week,
                payload.week_number,
                lesson.is_removed ? 1 : 0,
                lesson.time_start,
                lesson.time_end,
                lesson.subject,
                lesson.room,
                lesson.lesson_type,
                lesson.teacher,
                lesson.teacher_id ?? null,
                lesson.discipline_id ?? null,
                count,
                lesson.kind || 'lesson',
                semester.id
            );
            count += 1;
        }

        return count;
    });

    try {
        const count = transaction();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'schedule.materialize_week',
            entityType: 'group_schedule',
            entityId: payload.group_id,
            ipAddress: getClientAddress(req),
            details: { group_id: payload.group_id, week_number: payload.week_number, lesson_count: count }
        });

        res.status(201).json({
            success: true,
            count,
            attestation_warnings: payload.action === 'upsert'
                ? findAttestationsUnderLesson(db, semester, {
                    group_id: payload.group_id, specific_week: payload.week_number, day_of_week: payload.day_of_week,
                    time_start: payload.time_start, time_end: payload.time_end, subgroup: payload.subgroup, kind: 'lesson'
                })
                : []
        });
    } catch (error) {
        console.error('Materialize week error:', error);
        res.status(500).json({ error: 'Не удалось сохранить неделю' });
    }
});

/**
 * What clearing a week's own rows would do, without doing it: how many pairs
 * go, how many the template puts back (on the live site the template is
 * empty, so usually none — the week simply becomes empty), and how many hours
 * already counted to teachers would disappear. Measured by deleting inside a
 * savepoint and rolling back, so it is the very same calculation the plan uses.
 */
function summarizeWeekClear(db, semester, groupId, weekNumber) {
    const pairs = db.prepare(`
        SELECT COUNT(*) c FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? AND is_removed = 0
    `).get(semester.id, groupId, weekNumber).c;

    const templatePairs = Number.isInteger(semester.weeks_count) && weekNumber > semester.weeks_count
        ? 0
        : resolveTemplateLessons(db.prepare(`
            SELECT * FROM lessons
            WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND (week_type = 0 OR week_type = ?)
        `).all(semester.id, groupId, getSemesterWeekType(semester, weekNumber)), weekNumber).length;

    const planRows = attachPlanGroups(db, db.prepare('SELECT * FROM load_plan WHERE semester_id = ?').all(semester.id))
        .filter((row) => row.group_ids.some((id) => scheduleGroupId(db, id) === groupId));
    const countedHours = () => planRows.reduce((sum, row) => sum + computePlanRowProgress(db, row, semester).occurred_hours, 0);

    const before = countedHours();
    db.exec('SAVEPOINT week_clear_preview');
    let after;

    try {
        db.prepare('DELETE FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ?').run(semester.id, groupId, weekNumber);
        after = countedHours();
    } finally {
        db.exec('ROLLBACK TO week_clear_preview');
        db.exec('RELEASE week_clear_preview');
    }

    return { week_number: weekNumber, pairs, template_pairs: templatePairs, hours_lost: Math.max(0, before - after) };
}

function readWeekQuery(req, res) {
    const db = getDb();
    const groupId = Number.parseInt(req.query.group_id, 10);
    const weekNumber = Number.parseInt(req.query.week_number, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        res.status(400).json({ error: 'Укажите корректный group_id' });
        return null;
    }

    if (!Number.isInteger(weekNumber) || weekNumber <= 0) {
        res.status(400).json({ error: 'Укажите корректный week_number' });
        return null;
    }

    const memberError = joinedMemberError(db, groupId);

    if (memberError) {
        res.status(409).json({ error: memberError });
        return null;
    }

    const semester = getActiveSemester(db);

    if (!semester) {
        res.status(400).json({ error: NO_WORKING_SEMESTER });
        return null;
    }

    return { db, groupId, weekNumber, semester };
}

router.get('/schedule/week-summary', (req, res) => {
    const query = readWeekQuery(req, res);

    if (query) {
        res.json(summarizeWeekClear(query.db, query.semester, query.groupId, query.weekNumber));
    }
});

router.delete('/schedule/week', (req, res) => {
    const query = readWeekQuery(req, res);

    if (!query) {
        return undefined;
    }

    const { db, groupId, weekNumber, semester } = query;

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    // Pairs already counted to teachers are not wiped by one stray click:
    // the client asks again, naming the hours, and sends confirm=1.
    const summary = summarizeWeekClear(db, semester, groupId, weekNumber);

    if (summary.hours_lost > 0 && req.query.confirm !== '1') {
        return res.status(409).json({
            error: `Пары этой недели уже засчитаны преподавателям — пропадёт ${summary.hours_lost} ч.`,
            needs_confirm: true,
            ...summary
        });
    }

    // Week N of the working semester only — the same number in another
    // semester is a different calendar week with its own history.
    const result = db.prepare('DELETE FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ?')
        .run(semester.id, groupId, weekNumber);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'schedule.clear_week',
        entityType: 'group_schedule',
        entityId: groupId,
        ipAddress: getClientAddress(req),
        details: { group_id: groupId, week_number: weekNumber, deleted: result.changes, hours_lost: summary.hours_lost }
    });

    res.json({ success: true, deleted: result.changes, hours_lost: summary.hours_lost });
});

module.exports = router;
