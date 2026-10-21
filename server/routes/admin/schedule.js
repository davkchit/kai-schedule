// Schedule: JSON uploads and the Excel export. Week-by-week edits are in scheduleWeek.js.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { buildScheduleWorkbook } = require('../../exportSchedule');
const {
    addDaysToIsoDate,
    formatLocalDate,
    getSemesterWeekMeta,
    isValidIsoDate
} = require('../../utils/date');
const { getCourseFromGroupName, getSemesterLabel } = require('../../utils/course');
const { joinedLabels, joinedMemberError } = require('../../utils/groupJoin');
const { resolveGroupLessons } = require('../../utils/dayResolve');
const { getActiveSemester, getSemesterForDate } = require('../../utils/semesters');
const {
    validateBulkScheduleUploadBody,
    validateScheduleUploadBody
} = require('../../validation');
const {
    SEMESTER_CLOSED,
    findClosedSemester,
    NO_WORKING_SEMESTER,
    getClientAddress,
    weekBeyondSemesterError
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

    const beyond = lessons.length > 0 ? weekBeyondSemesterError(semester, specificWeek) : null;

    if (beyond) {
        return res.status(409).json(beyond);
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

    const beyond = groupPayloads.some((entry) => entry.lessons.length > 0) ? weekBeyondSemesterError(semester, specificWeek) : null;

    if (beyond) {
        return res.status(409).json(beyond);
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

        // Day by day, the very resolution the student page uses
        // (utils/dayResolve.js): the sheet never shows a pair students don't
        // see, or misses one they do.
        const groupRows = db.prepare('SELECT * FROM lessons WHERE semester_id = ? AND group_id = ?').all(semester.id, group.id);
        const lessonsForWeek = [];

        for (let offset = 0; offset < 7; offset += 1) {
            lessonsForWeek.push(...resolveGroupLessons(db, group.id, addDaysToIsoDate(weekStart, offset), {
                lessonsOf: () => groupRows,
                semesterFor: () => semester
            }).lessons);
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
