// Schedule: the Excel export. Week-by-week edits are in scheduleWeek.js.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { getDb } = require('../../db');
const { buildScheduleWorkbook } = require('../../exportSchedule');
const { addDaysToIsoDate, getSemesterWeekMeta, isValidIsoDate } = require('../../utils/date');
const { getCourseFromGroupName, getSemesterLabel } = require('../../utils/course');
const { joinedLabels } = require('../../utils/groupJoin');
const { resolveGroupLessons } = require('../../utils/dayResolve');
const { getSemesterForDate } = require('../../utils/semesters');

const router = express.Router();

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

module.exports = router;
