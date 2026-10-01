// Schedule: JSON uploads, Excel export, drag-and-drop moves and editing a single week.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { buildScheduleWorkbook } = require('../../exportSchedule');
const {
    addDaysToIsoDate,
    formatLocalDate,
    getSemesterWeekMeta,
    getSemesterWeekType,
    isValidIsoDate
} = require('../../utils/date');
const { getCourseFromGroupName, getSemesterLabel } = require('../../utils/course');
const { resolveTemplateLessons } = require('../../utils/templateResolve');
const { joinedLabels, joinedMemberError } = require('../../utils/groupJoin');
const { findTemplateSlotOccupant, findWeekSlotOccupant } = require('../../utils/slots');
const { getActiveSemester, getSemesterById, getSemesterForDate } = require('../../utils/semesters');
const {
    validateBulkScheduleUploadBody,
    validateMaterializeWeekBody,
    validateMoveLessonBody,
    validateScheduleUploadBody
} = require('../../validation');
const {
    SEMESTER_CLOSED,
    findClosedSemester,
    NO_WORKING_SEMESTER,
    getClientAddress,
    resolveTeacherDiscipline
} = require('./shared');

const router = express.Router();

router.post('/schedule/upload', (req, res) => {
    let payload;

    try {
        payload = validateScheduleUploadBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const { university, group, lessons, target_week: targetWeek, reference_date: referenceDate } = payload;
    const db = getDb();

    let groupRow;

    if (university) {
        groupRow = db.prepare(`
            SELECT g.id, u.short_name AS university_short_name FROM groups_ g
            JOIN universities u ON u.id = g.university_id
            WHERE u.short_name = ? AND g.name = ?
        `).get(university, group);
    } else {
        const groupCandidates = db.prepare(`
            SELECT g.id, u.short_name AS university_short_name
            FROM groups_ g
            JOIN universities u ON u.id = g.university_id
            WHERE g.name = ?
            ORDER BY u.short_name, g.id
        `).all(group);

        if (groupCandidates.length > 1) {
            return res.status(409).json({
                error: `Группа "${group}" найдена в нескольких вузах. Укажите поле university в JSON.`
            });
        }

        groupRow = groupCandidates[0];
    }

    if (!groupRow) {
        return res.status(404).json({ error: `Группа "${group}" не найдена` });
    }

    if (joinedMemberError(db, groupRow.id)) {
        return res.status(409).json({ error: joinedMemberError(db, groupRow.id) });
    }

    const weekTypeMap = { all: 0, odd: 1, even: 2 };
    let specificWeek = null;

    const semester = getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    if (targetWeek === 'current') {
        specificWeek = getSemesterWeekMeta(semester, referenceDate || formatLocalDate()).weekNumber;
    } else if (typeof targetWeek === 'number') {
        specificWeek = targetWeek;
    }

    const linkedToReplace = countLinkedLessonsToReplace(db, semester.id, groupRow.id, specificWeek);

    if (linkedToReplace > 0) {
        return res.status(409).json({ error: replacingLinkedLessonsError(linkedToReplace) });
    }

    const transaction = db.transaction(() => {
        // Only this semester's rows are replaced — the same group's schedule
        // in any other semester (and the hours counted from it) is untouched.
        if (specificWeek === null) {
            db.prepare('DELETE FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL')
                .run(semester.id, groupRow.id);
        } else {
            db.prepare('DELETE FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ?')
                .run(semester.id, groupRow.id, specificWeek);
        }

        const insert = db.prepare(`
            INSERT INTO lessons (
                semester_id, group_id, subgroup, day_of_week, week_type, specific_week,
                time_start, time_end, subject, room, lesson_type, teacher, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let count = 0;

        for (const lesson of lessons) {
            insert.run(
                semester.id,
                groupRow.id,
                lesson.subgroup,
                lesson.day,
                weekTypeMap[lesson.week_type],
                specificWeek,
                lesson.time_start,
                lesson.time_end,
                lesson.subject,
                lesson.room,
                lesson.type,
                lesson.teacher,
                lesson.sort_order ?? count
            );

            count += 1;
        }

        return count;
    });

    try {
        const imported = transaction();
        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'schedule.upload',
            entityType: 'group_schedule',
            entityId: groupRow.id,
            ipAddress: getClientAddress(req),
            details: {
                group,
                university: groupRow.university_short_name || university || null,
                imported,
                lesson_count: lessons.length,
                target_week: targetWeek,
                specific_week: specificWeek
            }
        });
        res.json({
            success: true,
            imported,
            group,
            applied_to: specificWeek === null ? 'template' : 'specific_week',
            specific_week: specificWeek
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: `Ошибка при загрузке расписания: ${error.message}` });
    }
});

router.post('/schedule/upload-bulk', (req, res) => {
    let payload;

    try {
        payload = validateBulkScheduleUploadBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const { groups: groupPayloads, target_week: targetWeek, reference_date: referenceDate } = payload;
    const db = getDb();
    const weekTypeMap = { all: 0, odd: 1, even: 2 };

    let specificWeek = null;

    const semester = getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    if (targetWeek === 'current') {
        specificWeek = getSemesterWeekMeta(semester, referenceDate || formatLocalDate()).weekNumber;
    } else if (typeof targetWeek === 'number') {
        specificWeek = targetWeek;
    }

    // Pre-resolve all groups before any writes — fail fast if any group is missing
    const resolvedGroups = [];

    for (const entry of groupPayloads) {
        const { university, group, lessons } = entry;
        let groupRow;

        if (university) {
            groupRow = db.prepare(`
                SELECT g.id, u.short_name AS university_short_name FROM groups_ g
                JOIN universities u ON u.id = g.university_id
                WHERE u.short_name = ? AND g.name = ?
            `).get(university, group);
        } else {
            const candidates = db.prepare(`
                SELECT g.id, u.short_name AS university_short_name
                FROM groups_ g
                JOIN universities u ON u.id = g.university_id
                WHERE g.name = ?
                ORDER BY u.short_name, g.id
            `).all(group);

            if (candidates.length > 1) {
                return res.status(409).json({
                    error: `Группа "${group}" найдена в нескольких вузах. Укажите поле university.`
                });
            }

            groupRow = candidates[0];
        }

        if (!groupRow) {
            return res.status(404).json({ error: `Группа "${group}" не найдена` });
        }

        if (joinedMemberError(db, groupRow.id)) {
            return res.status(409).json({ error: joinedMemberError(db, groupRow.id) });
        }

        resolvedGroups.push({ groupRow, group, lessons });
    }

    // Checked for every group before writing any of them — the upload is
    // all-or-nothing, so one refused group must refuse the whole file.
    for (const { groupRow, group } of resolvedGroups) {
        const linkedToReplace = countLinkedLessonsToReplace(db, semester.id, groupRow.id, specificWeek);

        if (linkedToReplace > 0) {
            return res.status(409).json({ error: `Группа «${group}»: ${replacingLinkedLessonsError(linkedToReplace)}` });
        }
    }

    const transaction = db.transaction(() => {
        const insert = db.prepare(`
            INSERT INTO lessons (
                semester_id, group_id, subgroup, day_of_week, week_type, specific_week,
                time_start, time_end, subject, room, lesson_type, teacher, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const results = [];

        for (const { groupRow, group, lessons } of resolvedGroups) {
            // Only the working semester's rows are replaced.
            if (specificWeek === null) {
                db.prepare('DELETE FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL')
                    .run(semester.id, groupRow.id);
            } else {
                db.prepare('DELETE FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ?')
                    .run(semester.id, groupRow.id, specificWeek);
            }

            let count = 0;

            for (const lesson of lessons) {
                insert.run(
                    semester.id,
                    groupRow.id,
                    lesson.subgroup,
                    lesson.day,
                    weekTypeMap[lesson.week_type],
                    specificWeek,
                    lesson.time_start,
                    lesson.time_end,
                    lesson.subject,
                    lesson.room,
                    lesson.type,
                    lesson.teacher,
                    lesson.sort_order ?? count
                );
                count += 1;
            }

            results.push({ group, imported: count });
        }

        return results;
    });

    try {
        const results = transaction();
        const totalImported = results.reduce((sum, r) => sum + r.imported, 0);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'schedule.upload',
            entityType: 'bulk_schedule',
            entityId: null,
            ipAddress: getClientAddress(req),
            details: {
                groups: results.map(r => r.group),
                total_imported: totalImported,
                group_count: results.length,
                target_week: targetWeek,
                specific_week: specificWeek
            }
        });

        res.json({
            success: true,
            total_imported: totalImported,
            groups: results,
            applied_to: specificWeek === null ? 'template' : 'specific_week',
            specific_week: specificWeek
        });
    } catch (error) {
        console.error('Bulk upload error:', error);
        res.status(500).json({ error: `Ошибка при загрузке расписания: ${error.message}` });
    }
});

router.get('/schedule/export', async (req, res) => {
    const db = getDb();
    const weekStart = typeof req.query.week_start === 'string' ? req.query.week_start : '';

    if (!isValidIsoDate(weekStart)) {
        return res.status(400).json({ error: 'Укажите week_start в формате YYYY-MM-DD' });
    }

    // The week being exported belongs to whichever semester was in effect on
    // that date — exporting a December week in March must show December's
    // timetable, not re-read December's dates against the spring semester.
    const semester = getSemesterForDate(db, weekStart);

    if (!semester) {
        return res.status(400).json({ error: 'На эту дату нет семестра — создайте его в разделе «Нагрузка»' });
    }

    const weekMeta = getSemesterWeekMeta(semester, weekStart);
    // A joined group has no pairs of its own: it is printed inside its
    // leader's block, which is named after both ("23303 / 23313").
    const labels = joinedLabels(db);
    const groups = db.prepare('SELECT id, name, direction FROM groups_ WHERE joined_to IS NULL ORDER BY name').all()
        .map((group) => ({ ...group, label: labels.get(group.id) || group.name }));

    const courseMap = new Map();

    for (const group of groups) {
        const course = getCourseFromGroupName(group.name);

        if (course === null) {
            continue;
        }

        const allLessons = db.prepare(`
            SELECT id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
                   time_start, time_end, subject, room, lesson_type, teacher, kind
            FROM lessons
            WHERE semester_id = ? AND group_id = ?
        `).all(semester.id, group.id);

        const hasExceptionWeek = allLessons.some((lesson) => lesson.specific_week === weekMeta.weekNumber);
        let lessonsForWeek;

        if (hasExceptionWeek) {
            // Removed markers only keep the week its own — they are not pairs.
            lessonsForWeek = allLessons.filter((lesson) => lesson.specific_week === weekMeta.weekNumber && !lesson.is_removed);
        } else {
            const candidates = allLessons.filter((lesson) =>
                lesson.specific_week === null &&
                (lesson.week_type === 0 || lesson.week_type === weekMeta.weekTypeNumber)
            );
            lessonsForWeek = resolveTemplateLessons(candidates, weekMeta.weekNumber);
        }

        if (!courseMap.has(course)) {
            courseMap.set(course, []);
        }

        courseMap.get(course).push({
            name: group.label,
            direction: group.direction,
            lessons: lessonsForWeek
        });
    }

    if (courseMap.size === 0) {
        return res.status(404).json({ error: 'Нет ни одной группы с корректным номером (23XYZ) для формирования расписания' });
    }

    const dayDates = {};

    for (let offset = 0; offset < 6; offset += 1) {
        const isoDate = addDaysToIsoDate(weekStart, offset);
        const [year, month, day] = isoDate.split('-');
        // The sheet writes the day without a leading zero: «ВТОРНИК 1.09.2026».
        dayDates[offset + 1] = `${Number(day)}.${month}.${year}`;
    }

    const settingsRows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};

    for (const row of settingsRows) {
        settings[row.key] = row.value;
    }

    // Autumn or spring, the academic year and the approval year all follow from
    // the semester's own start date — a stale setting can't put «VIII семестр,
    // 2025/2026» on an autumn 2026 sheet.
    const [startYear, startMonth] = semester.start_date.split('-').map(Number);
    const isAutumn = startMonth >= 7;
    const termParity = isAutumn ? 'fall' : 'spring';
    const academicYear = isAutumn ? `${startYear}/${startYear + 1}` : `${startYear - 1}/${startYear}`;
    const courseSheets = Array.from(courseMap.entries())
        .sort(([a], [b]) => a - b)
        .map(([course, courseGroups]) => ({ course, groups: courseGroups }));

    try {
        const workbook = buildScheduleWorkbook({
            courseSheets,
            dayDates,
            weekTypeLabel: weekMeta.weekTypeLabel.toUpperCase().replace(/Ё/g, 'Е'),
            semesterLabelForCourse: (course) => getSemesterLabel(course, termParity),
            studyForm: settings.study_form || 'очная форма обучения',
            academicYear,
            approvalYear: startYear,
            directorName: settings.director_name || 'ФИО директора',
            directorTitle: settings.director_title || 'Директор филиала'
        });

        const fileName = `raspisanie_${weekStart}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Schedule export error:', error);
        res.status(500).json({ error: 'Не удалось сформировать файл расписания' });
    }
});

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

    const currentWeek = getSemesterWeekMeta(semester, formatLocalDate()).weekNumber;

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

    res.json({ success: true, moved: true });
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
                    kind: lesson.kind
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
            kind: 'lesson'
        });
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

        res.status(201).json({ success: true, count });
    } catch (error) {
        console.error('Materialize week error:', error);
        res.status(500).json({ error: 'Не удалось сохранить неделю' });
    }
});

router.delete('/schedule/week', (req, res) => {
    const db = getDb();
    const groupId = Number.parseInt(req.query.group_id, 10);
    const weekNumber = Number.parseInt(req.query.week_number, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Укажите корректный group_id' });
    }

    if (!Number.isInteger(weekNumber) || weekNumber <= 0) {
        return res.status(400).json({ error: 'Укажите корректный week_number' });
    }

    const semester = getActiveSemester(db);

    if (!semester) {
        return res.status(400).json({ error: NO_WORKING_SEMESTER });
    }

    if (findClosedSemester(db, semester.id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
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
        details: { group_id: groupId, week_number: weekNumber, deleted: result.changes }
    });

    res.json({ success: true, deleted: result.changes });
});

/**
 * How many of the rows an upload is about to replace are tied to a
 * teacher/discipline (and so, potentially, to a load_plan row's hours).
 * Uploaded rows arrive as plain text with no ids — replacing tracked pairs
 * this way would silently untrack them and erase hours already counted.
 */
function countLinkedLessonsToReplace(db, semesterId, groupId, specificWeek) {
    return specificWeek === null
        ? db.prepare(`
            SELECT COUNT(*) c FROM lessons
            WHERE semester_id = ? AND group_id = ? AND specific_week IS NULL AND teacher_id IS NOT NULL AND discipline_id IS NOT NULL
        `).get(semesterId, groupId).c
        : db.prepare(`
            SELECT COUNT(*) c FROM lessons
            WHERE semester_id = ? AND group_id = ? AND specific_week = ? AND teacher_id IS NOT NULL AND discipline_id IS NOT NULL
        `).get(semesterId, groupId, specificWeek).c;
}

function replacingLinkedLessonsError(count) {
    return `${count} пар(ы) из заменяемого расписания уже привязаны к преподавателю и дисциплине из справочника. `
        + 'Загрузка файлом заменила бы их обычным текстом и стёрла бы уже посчитанные часы. '
        + 'Правьте такое расписание в конструкторе.';
}

module.exports = router;
