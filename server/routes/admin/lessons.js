// Lessons: the constructor's create / edit / delete, versioned so the past never changes.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { formatLocalDate, getSemesterWeekMeta } = require('../../utils/date');
const { resolveTemplateLessons } = require('../../utils/templateResolve');
const { findTemplateSlotOccupant, findWeekSlotOccupant } = require('../../utils/slots');
const { getActiveSemester, getSemesterById } = require('../../utils/semesters');
const { validateLessonCreateBody, validateLessonUpdateBody } = require('../../validation');
const {
    SEMESTER_CLOSED,
    findClosedSemester,
    NO_WORKING_SEMESTER,
    getClientAddress
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
    `).all(semester.id, groupId);

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

    const templateFromWeek = getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;

    // An edit in the template view is a new version of an existing row. It
    // must be allowed into the cell that row occupies, and it inherits the
    // row's load-plan link — a version without it would leave the teacher's
    // hours counting the old version while students see the new one.
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
        // A removal sent without naming its row still has to carry the link of
        // the pair it hides: the hour counter selects rows by load_plan_id, so an
        // unlinked tombstone is invisible to it and the pair keeps counting.
        replaced = resolveTemplateLessons(db.prepare(`
            SELECT * FROM lessons
            WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL
              AND day_of_week = ? AND time_start = ? AND time_end = ? AND subgroup = ? AND week_type = ?
        `).all(
            semester.id, payload.group_id, payload.day_of_week, payload.time_start, payload.time_end,
            payload.subgroup, payload.week_type
        ), templateFromWeek)[0] || null;
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
            time_start, time_end, subject, room, lesson_type, teacher, sort_order,
            kind, load_plan_id, semester_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const slotKey = (row) => [row.day_of_week, row.time_start, row.time_end, row.subgroup, row.week_type].join('|');

    const createdId = db.transaction(() => {
        if (replaced && !payload.is_removed && replaced.template_from_week >= templateFromWeek && !replaced.is_removed) {
            // Not live in any earlier week yet: nothing in the past depends on
            // it, so the row itself is corrected instead of stacking versions.
            db.prepare(`
                UPDATE lessons SET
                    subgroup = ?, day_of_week = ?, week_type = ?, time_start = ?, time_end = ?,
                    subject = ?, room = ?, lesson_type = ?, teacher = ?, kind = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                payload.subgroup, payload.day_of_week, payload.week_type, payload.time_start, payload.time_end,
                payload.subject, payload.room, payload.lesson_type, payload.teacher, payload.kind, replaced.id
            );
            return replaced.id;
        }

        if (replaced && !payload.is_removed && slotKey(replaced) !== slotKey(payload)) {
            // Moving to another cell or parity: the old cell is retired from
            // this week, as move-lesson does, carrying the same link.
            insertLesson.run(
                replaced.group_id, replaced.subgroup, replaced.day_of_week, replaced.week_type, null,
                templateFromWeek, 1,
                replaced.time_start, replaced.time_end, replaced.subject, replaced.room,
                replaced.lesson_type, replaced.teacher, replaced.sort_order,
                replaced.kind, replaced.load_plan_id, semester.id
            );
        }

        if (replaced && payload.is_removed) {
            // Hide exactly the row being removed, even if the form's fields were
            // touched before pressing "убрать".
            return insertLesson.run(
                replaced.group_id, replaced.subgroup, replaced.day_of_week, replaced.week_type, null,
                templateFromWeek, 1,
                replaced.time_start, replaced.time_end, replaced.subject, replaced.room,
                replaced.lesson_type, replaced.teacher, replaced.sort_order,
                replaced.kind, replaced.load_plan_id, semester.id
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
            payload.subject,
            payload.room,
            payload.lesson_type,
            payload.teacher,
            payload.sort_order,
            replaced ? replaced.kind : payload.kind,
            replaced ? replaced.load_plan_id : null,
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

    res.status(201).json({ ...created, own_weeks_ahead: ownWeeksAhead });
});

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

    let updates;

    try {
        updates = validateLessonUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    if (findClosedSemester(db, lesson.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    const nextLesson = {
        ...lesson,
        ...updates
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
            sort_order = ?,
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
        nextLesson.sort_order,
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
    res.json(updated);
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
    const currentWeek = semester ? getSemesterWeekMeta(semester, formatLocalDate()).weekNumber : 1;

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
                time_start, time_end, subject, room, lesson_type, teacher, sort_order,
                kind, load_plan_id, semester_id
            )
            VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            lesson.group_id, lesson.subgroup, lesson.day_of_week, lesson.week_type,
            currentWeek,
            lesson.time_start, lesson.time_end, lesson.subject, lesson.room,
            lesson.lesson_type, lesson.teacher, lesson.sort_order,
            lesson.kind, lesson.load_plan_id, lesson.semester_id
        );
    } else if (isLastVisibleWeekRow(db, lesson)) {
        // Deleting a week's last pair must still leave the week "its own" —
        // with no rows left, the template would take the week back and the
        // pair just cancelled would reappear (and be counted again).
        db.prepare('UPDATE lessons SET is_removed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(lessonId);
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
