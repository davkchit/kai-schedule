const ExcelJS = require('exceljs');

// The weekly schedule as the branch publishes it: one sheet per course, the
// groups of that course side by side, the same layout, fonts and wording as
// the official printed file the specialist posts to the students' group.
// Sizes below are measured from that file (2026/2027, "1-4_kursy.xlsx").

const DAY_LABELS = {
    1: 'ПОНЕДЕЛЬНИК',
    2: 'ВТОРНИК',
    3: 'СРЕДА',
    4: 'ЧЕТВЕРГ',
    5: 'ПЯТНИЦА',
    6: 'СУББОТА'
};

const EXPORT_DAYS = [1, 2, 3, 4, 5, 6];
const FIRST_BLOCK_COL = 4; // col 1 = hairline spacer, col 2 = day, col 3 = time
const DISCIPLINE_WIDTH_PER_SHEET = 330; // shared by the discipline columns of a sheet
const ROOM_WIDTH = 11.5;

// How the sheet writes the kind of a pair: "Математика (лек.) Николаева Г.А.".
const TYPE_SHORT = { 'Лекция': 'лек.', 'Практика': 'пр.', 'Лаб': 'лаб.', 'Лабораторная': 'лаб.' };

// Time rows every day of the course shows even when empty, as on the sheet:
// the odd courses study in the morning, the even ones from 11:30.
const MORNING_ROWS = [['08:00', '09:30'], ['09:40', '11:10'], ['11:30', '13:00']];
const DAYTIME_ROWS = [['11:30', '13:00'], ['13:10', '14:40'], ['15:00', '16:30'], ['16:40', '18:10']];
const rowsForCourse = (course) => (course % 2 === 1 ? MORNING_ROWS : DAYTIME_ROWS);

// The sheet sizes a few fonts per course (the group number, the direction and the pairs).
const COURSE_FONT_SIZES = {
    1: { group: 35, direction: 22, lesson: 22 },
    2: { group: 26, direction: 18, lesson: 24 },
    3: { group: 36, direction: 22, lesson: 24 },
    4: { group: 36, direction: 22, lesson: 22 }
};

const THIN = { style: 'thin' };
const MEDIUM = { style: 'medium' };
const TNR = 'Times New Roman';
const FONTS = {
    title: { name: TNR, size: 24, bold: true },
    approvalDate: { name: TNR, size: 20, bold: true },
    dayHeader: { name: TNR, size: 16, bold: true },
    label: { name: TNR, size: 14, bold: true },
    groupLabel: { name: TNR, size: 12, bold: true },
    columnHeader: { name: TNR, size: 16 },
    direction: { name: TNR, size: 22 },
    group: { name: TNR, size: 36, bold: true },
    day: { name: TNR, size: 18, bold: true },
    time: { name: TNR, size: 18, bold: true },
    lesson: { name: TNR, size: 22 }
};
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
// A room like «КАМАЗ» shrinks to its narrow column instead of breaking in two.
const ROOM = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };

// Excel/LibreOffice can reinterpret a cell whose text starts with =, +, -, @, tab
// or CR as a formula (CWE-1236), so any string sourced from admin-entered data
// (subject, teacher, room, group name, direction, etc.) is neutralized before
// it reaches a cell value.
const FORMULA_TRIGGER_CHARS = /^[=+\-@\t\r]/;

function sanitizeCellText(value) {
    if (typeof value !== 'string') return value;
    return FORMULA_TRIGGER_CHARS.test(value) ? `'${value}` : value;
}

function stripLeadingZero(time) {
    return time.replace(/^0(\d:)/, '$1');
}

/** "Физическая культура и спорт (элективная дисциплина) Кузнецов Н.П." — the sheet's own wording. */
function formatLessonText(lesson) {
    const subject = sanitizeCellText(lesson.subject || '');

    if (lesson.kind === 'event' || !lesson.lesson_type) {
        return [subject, lesson.teacher].filter(Boolean).join(' ');
    }

    const kind = /^Физическая культура/i.test(lesson.subject) && lesson.lesson_type === 'Практика'
        ? 'элективная дисциплина'
        : TYPE_SHORT[lesson.lesson_type] || lesson.lesson_type.toLowerCase();
    const subgroup = lesson.subgroup > 0 ? ` ${lesson.subgroup} п/г` : '';

    return `${subject} (${kind})${subgroup}${lesson.teacher ? ` ${lesson.teacher}` : ''}`;
}

const lessonKey = (lesson) => [lesson.day_of_week, lesson.time_start, lesson.time_end, lesson.subgroup,
    lesson.subject, lesson.lesson_type, lesson.teacher, lesson.room].join('|');

/**
 * Groups with exactly the same week (e.g. 23303 and 23313, one stream) share
 * one column block headed "23303 / 23313", as on the official sheet.
 */
function buildBlocks(course, groups) {
    const blocks = [];

    for (const group of groups) {
        const signature = group.lessons.map(lessonKey).sort().join('\n');
        const previous = blocks[blocks.length - 1];

        if (previous && group.lessons.length > 0 && previous.signature === signature) {
            previous.names.push(group.name);
            continue;
        }

        blocks.push({ names: [group.name], direction: group.direction || '', lessons: group.lessons, signature });
    }

    for (const block of blocks) {
        // The first course writes each group over three discipline columns; a
        // shared block gets one column per group; everything else one.
        block.disciplineCols = course === 1 ? 3 : Math.max(1, block.names.length);
    }

    let col = FIRST_BLOCK_COL;
    for (const block of blocks) {
        block.firstCol = col;
        block.lastDisciplineCol = col + block.disciplineCols - 1;
        block.roomCol = block.lastDisciplineCol + 1;
        col = block.roomCol + 1;
    }

    return blocks;
}

function computeDaySlots(defaultSlots, lessonsForDay) {
    const seen = new Set(defaultSlots.map(([start, end]) => `${start}|${end}`));
    const slots = [...defaultSlots];

    for (const lesson of lessonsForDay) {
        const key = `${lesson.time_start}|${lesson.time_end}`;

        if (!seen.has(key)) {
            seen.add(key);
            slots.push([lesson.time_start, lesson.time_end]);
        }
    }

    return slots.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function setCell(sheet, row, col, value, font, alignment = CENTER) {
    const cell = sheet.getCell(row, col);
    cell.value = value;
    if (font) cell.font = font;
    if (alignment) cell.alignment = alignment;
    return cell;
}

function merge(sheet, top, left, bottom, right) {
    if (top !== bottom || left !== right) {
        sheet.mergeCells(top, left, bottom, right);
    }
}

/** Thin grid inside the table, medium around the header, each group block and each day. */
function drawBorders(sheet, { lastCol, dayRanges, blocks, lastRow }) {
    const mediumRight = new Set([2, 3, ...blocks.map((block) => block.roomCol)]);
    const dayTops = new Set(dayRanges.map(([top]) => top));

    for (let row = 7; row <= lastRow; row += 1) {
        for (let col = 2; col <= lastCol; col += 1) {
            sheet.getCell(row, col).border = {
                top: row === 7 || dayTops.has(row) ? MEDIUM : THIN,
                bottom: row === 9 || row === lastRow ? MEDIUM : THIN,
                left: col === 2 || mediumRight.has(col - 1) ? MEDIUM : THIN,
                right: mediumRight.has(col) ? MEDIUM : THIN
            };
        }
    }
}

function buildCourseSheet(workbook, {
    course, semesterLabel, groups, dayDates, weekTypeLabel, studyForm, academicYear,
    directorName, directorTitle, approvalYear
}) {
    const sheet = workbook.addWorksheet(`${course} курс`, {
        pageSetup: {
            orientation: 'landscape',
            paperSize: 9,
            // One printed page per course, however many time rows the week needs
            // (the official sheet gets there by deleting empty rows by hand).
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 1,
            margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.2, header: 0.3, footer: 0 }
        },
        views: [{ zoomScale: 50 }]
    });

    const blocks = buildBlocks(course, groups);
    const sizes = COURSE_FONT_SIZES[course] || COURSE_FONT_SIZES[4];
    const groupFont = { ...FONTS.group, size: sizes.group };
    const lessonFont = { ...FONTS.lesson, size: sizes.lesson };
    const directionFont = { ...FONTS.direction, size: sizes.direction };
    const lastCol = blocks[blocks.length - 1].roomCol;
    const disciplineCols = blocks.reduce((sum, block) => sum + block.disciplineCols, 0);

    sheet.getColumn(1).width = 0.14;
    sheet.getColumn(2).width = 10;
    sheet.getColumn(3).width = 21.14;
    for (const block of blocks) {
        for (let col = block.firstCol; col <= block.lastDisciplineCol; col += 1) {
            sheet.getColumn(col).width = DISCIPLINE_WIDTH_PER_SHEET / disciplineCols;
        }
        sheet.getColumn(block.roomCol).width = ROOM_WIDTH;
    }

    // Title block: the schedule on the left, the director's approval on the right.
    const LEFT = { horizontal: 'left', vertical: 'middle' };
    // Over the last group's columns — but never onto the title's own cells on a one-group sheet.
    const approvalCol = Math.max(blocks[blocks.length - 1].firstCol, FIRST_BLOCK_COL + 1);
    const titles = [
        [`РАСПИСАНИЕ ЗАНЯТИЙ на ${semesterLabel}`, 'УТВЕРЖДАЮ', FONTS.title],
        [studyForm, directorTitle, FONTS.title],
        [weekTypeLabel, `____________ ${directorName}`, FONTS.title],
        [`${academicYear} учебный год`, `« ___» ____________ ${approvalYear}г.`, FONTS.approvalDate]
    ];
    sheet.getRow(1).height = 42;
    [45.75, 40.5, 35.1, 35.1].forEach((height, index) => {
        const row = 2 + index;
        sheet.getRow(row).height = height;
        merge(sheet, row, 2, row, approvalCol - 1);
        setCell(sheet, row, 2, sanitizeCellText(titles[index][0]), FONTS.title, LEFT);
        merge(sheet, row, approvalCol, row, lastCol);
        setCell(sheet, row, approvalCol, sanitizeCellText(titles[index][1]), titles[index][2], LEFT);
    });
    sheet.getRow(6).height = 39.75;

    // Header: day / time / per group "Дисциплина | Ауд.", direction, group number.
    sheet.getRow(7).height = 42;
    sheet.getRow(8).height = 51;
    sheet.getRow(9).height = 66;
    merge(sheet, 7, 2, 9, 2);
    setCell(sheet, 7, 2, 'День недели', FONTS.dayHeader, { ...CENTER, textRotation: 90 });
    setCell(sheet, 7, 3, 'Время', FONTS.label);
    setCell(sheet, 8, 3, 'Направление', FONTS.label);
    setCell(sheet, 9, 3, ' Группа', FONTS.groupLabel);

    for (const block of blocks) {
        merge(sheet, 7, block.firstCol, 7, block.lastDisciplineCol);
        setCell(sheet, 7, block.firstCol, 'Дисциплина', FONTS.columnHeader);
        setCell(sheet, 7, block.roomCol, 'Ауд.', FONTS.columnHeader);
        merge(sheet, 8, block.firstCol, 8, block.roomCol);
        setCell(sheet, 8, block.firstCol, sanitizeCellText(block.direction), directionFont);
        merge(sheet, 9, block.firstCol, 9, block.roomCol);
        setCell(sheet, 9, block.firstCol, sanitizeCellText(block.names.join(' / ')), groupFont);
    }

    // Days.
    const defaultSlots = rowsForCourse(course);
    const dayRanges = [];
    let row = 10;

    for (const day of EXPORT_DAYS) {
        const dayStart = row;
        const dayLessons = blocks.flatMap((block) => block.lessons.filter((lesson) => lesson.day_of_week === day));

        for (const [start, end] of computeDaySlots(defaultSlots, dayLessons)) {
            sheet.getRow(row).height = 60;
            setCell(sheet, row, 3, `${stripLeadingZero(start)}-${stripLeadingZero(end)}`, FONTS.time);

            // A lecture several groups attend is written in each group's own cell:
            // the official sheet merges such cells only now and then, by hand,
            // and far more often keeps them separate. Subgroups share the cell,
            // one line each.
            for (const block of blocks) {
                merge(sheet, row, block.firstCol, row, block.lastDisciplineCol);
                const lessons = block.lessons.filter((lesson) =>
                    lesson.day_of_week === day && lesson.time_start === start && lesson.time_end === end);

                if (lessons.length > 0) {
                    setCell(sheet, row, block.firstCol, lessons.map(formatLessonText).join('\n'), lessonFont);
                    const rooms = lessons.map((lesson) => lesson.room || '').filter(Boolean);
                    setCell(sheet, row, block.roomCol, sanitizeCellText([...new Set(rooms)].join(' / ')), lessonFont, ROOM);
                }
            }

            row += 1;
        }

        merge(sheet, dayStart, 2, row - 1, 2);
        const date = dayDates?.[day] ? ` ${dayDates[day]}` : '';
        setCell(sheet, dayStart, 2, `${DAY_LABELS[day]}${date}`, FONTS.day, { ...CENTER, textRotation: 90 });
        dayRanges.push([dayStart, row - 1]);
    }

    drawBorders(sheet, { lastCol, dayRanges, blocks, lastRow: row - 1 });
}

/**
 * Builds one workbook with one sheet per course (1–4), each sheet listing
 * that course's groups side by side — the university's official printed layout.
 */
function buildScheduleWorkbook({
    courseSheets, dayDates, weekTypeLabel, semesterLabelForCourse, studyForm, academicYear,
    directorName, directorTitle, approvalYear
}) {
    const workbook = new ExcelJS.Workbook();

    for (const entry of courseSheets) {
        buildCourseSheet(workbook, {
            course: entry.course,
            semesterLabel: semesterLabelForCourse(entry.course),
            groups: entry.groups,
            dayDates,
            weekTypeLabel,
            studyForm,
            academicYear,
            directorName,
            directorTitle,
            approvalYear
        });
    }

    return workbook;
}

module.exports = {
    buildScheduleWorkbook,
    formatLessonText,
    EXPORT_DAYS,
    DAY_LABELS,
    sanitizeCellText
};
