const ExcelJS = require('exceljs');
const { sanitizeCellText } = require('./exportSchedule');

// The two session documents the branch publishes, in their own layout, fonts
// and wording (measured from the 2025/2026 spring files):
//   «Расписание промежуточной аттестации» — зачёты и экзамены, the date in
//     a «зачет» or an «экзамен» column under «Форма контроля»;
//   «Расписание консультаций к экзаменам».
// One sheet per course, each group a block with its number merged down the side.

const TNR = 'Times New Roman';
const FONTS = {
    approval: { name: TNR, size: 16 },
    title: { name: 'Arial', size: 18, bold: true },
    consultationTitle: { name: 'Arial', size: 25, bold: true },
    groupHeader: { name: 'Arial', size: 16, bold: true },
    header: { name: TNR, size: 16, bold: true },
    group: { name: TNR, size: 18, bold: true },
    cell: { name: TNR, size: 18 }
};
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const THIN = { style: 'thin' };
const MEDIUM = { style: 'medium' };

const formatDate = (isoDate) => isoDate.split('-').reverse().join('.');
const formatTime = (time) => time.replace(/^0(\d:)/, '$1');

function disciplineText(item) {
    const name = sanitizeCellText(item.subject || '');
    return item.subgroup ? `${name} ${item.subgroup} п/г` : name;
}

function setCell(sheet, row, col, value, font, alignment = CENTER) {
    const cell = sheet.getCell(row, col);
    cell.value = value;
    cell.font = font;
    cell.alignment = alignment;
    return cell;
}

/** Medium frame around every cell of the table, thin lines between a group's own rows. */
function drawTable(sheet, { firstRow, lastRow, lastCol, groupRanges }) {
    const groupEnds = new Set(groupRanges.map(([, end]) => end));
    const groupStarts = new Set(groupRanges.map(([start]) => start));

    for (let row = firstRow; row <= lastRow; row += 1) {
        for (let col = 1; col <= lastCol; col += 1) {
            sheet.getCell(row, col).border = {
                left: MEDIUM,
                right: MEDIUM,
                top: groupStarts.has(row) || row === firstRow ? MEDIUM : THIN,
                bottom: groupEnds.has(row) || row === lastRow ? MEDIUM : THIN
            };
        }
    }
}

function writeGroupBlocks(sheet, { firstRow, groups, columns, rowHeight }) {
    let row = firstRow;
    const groupRanges = [];

    for (const group of groups) {
        const start = row;

        for (const item of group.items) {
            columns.forEach((write, index) => write(setCellAt(sheet, row, index + 2), item));
            sheet.getRow(row).height = rowHeight;
            row += 1;
        }

        if (row - 1 > start) sheet.mergeCells(start, 1, row - 1, 1);
        setCell(sheet, start, 1, sanitizeCellText(group.label), FONTS.group);
        groupRanges.push([start, row - 1]);
    }

    return { lastRow: row - 1, groupRanges };
}

const setCellAt = (sheet, row, col) => (value) => setCell(sheet, row, col, value, FONTS.cell);

function approvalBlock(sheet, { directorTitle, directorName, approvalYear }) {
    setCell(sheet, 1, 7, 'Приложение 2', FONTS.approval, { horizontal: 'right', vertical: 'middle' });
    const left = { horizontal: 'left', vertical: 'middle' };
    setCell(sheet, 2, 6, 'УТВЕРЖДАЮ', FONTS.approval, left);
    setCell(sheet, 3, 6, sanitizeCellText(directorTitle), FONTS.approval, left);
    sheet.mergeCells(4, 6, 4, 7);
    setCell(sheet, 4, 6, `____________ ${sanitizeCellText(directorName)}`, FONTS.approval, left);
    sheet.mergeCells(5, 6, 5, 7);
    setCell(sheet, 5, 6, `«___» ____________ ${approvalYear} г.`, FONTS.approval, left);
}

function pageSetup(sheet) {
    sheet.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
}

/** зачёты и экзамены: the sheet the students get before the session. */
function buildSessionWorkbook({ courseSheets, termLabel, academicYear, studyForm, directorTitle, directorName, approvalYear }) {
    const workbook = new ExcelJS.Workbook();

    for (const { course, groups } of courseSheets) {
        const sheet = workbook.addWorksheet(`${course} курс`);
        pageSetup(sheet);
        [11.4, 112.4, 17.6, 17.7, 12.4, 28.4, 11.3].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
        for (let row = 1; row <= 12; row += 1) sheet.getRow(row).height = 30;

        approvalBlock(sheet, { directorTitle, directorName, approvalYear });
        [
            [7, 'Расписание промежуточной аттестации'],
            [8, `за ${termLabel} семестр ${academicYear} учебный год`],
            [9, studyForm]
        ].forEach(([row, text]) => {
            sheet.mergeCells(row, 2, row, 7);
            setCell(sheet, row, 2, sanitizeCellText(text), FONTS.title);
        });

        sheet.mergeCells(11, 1, 12, 1);
        setCell(sheet, 11, 1, 'Группа', FONTS.groupHeader);
        sheet.mergeCells(11, 2, 12, 2);
        setCell(sheet, 11, 2, 'Дисциплина', FONTS.header);
        sheet.mergeCells(11, 3, 11, 4);
        setCell(sheet, 11, 3, 'Форма контроля', FONTS.header);
        setCell(sheet, 12, 3, 'зачет', FONTS.header);
        setCell(sheet, 12, 4, 'экзамен', FONTS.header);
        [[5, 'Время'], [6, 'Преподаватель'], [7, 'Аудитория']].forEach(([col, text]) => {
            sheet.mergeCells(11, col, 12, col);
            setCell(sheet, 11, col, text, FONTS.header);
        });

        const { lastRow, groupRanges } = writeGroupBlocks(sheet, {
            firstRow: 13,
            groups,
            rowHeight: 30,
            columns: [
                (write, item) => write(disciplineText(item)),
                (write, item) => write(item.kind === 'credit' ? formatDate(item.date) : ''),
                (write, item) => write(item.kind === 'exam' ? formatDate(item.date) : ''),
                (write, item) => write(formatTime(item.time_start)),
                (write, item) => write(sanitizeCellText(item.teacher || '')),
                (write, item) => write(sanitizeCellText(item.room || ''))
            ]
        });

        drawTable(sheet, { firstRow: 11, lastRow: Math.max(lastRow, 12), lastCol: 7, groupRanges: [[11, 12], ...groupRanges] });
    }

    return workbook;
}

/** Консультации перед экзаменами. */
function buildConsultationWorkbook({ courseSheets }) {
    const workbook = new ExcelJS.Workbook();

    for (const { course, groups } of courseSheets) {
        const sheet = workbook.addWorksheet(`${course} курс`);
        pageSetup(sheet);
        [11.4, 107, 17.6, 12.4, 28.4, 11.3].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
        for (let row = 1; row <= 5; row += 1) sheet.getRow(row).height = 30;

        sheet.mergeCells(2, 2, 2, 6);
        setCell(sheet, 2, 2, 'Расписание консультаций к экзаменам', FONTS.consultationTitle);

        [[1, 'Группа', FONTS.groupHeader], [2, 'Дисциплина'], [3, 'дата'], [4, 'Время'], [5, 'Преподаватель'], [6, 'Аудитория']]
            .forEach(([col, text, font = FONTS.header]) => {
                sheet.mergeCells(4, col, 5, col);
                setCell(sheet, 4, col, text, font);
            });

        const { lastRow, groupRanges } = writeGroupBlocks(sheet, {
            firstRow: 6,
            groups,
            rowHeight: 40,
            columns: [
                (write, item) => write(disciplineText(item)),
                (write, item) => write(formatDate(item.date)),
                (write, item) => write(formatTime(item.time_start)),
                (write, item) => write(sanitizeCellText(item.teacher || '')),
                (write, item) => write(sanitizeCellText(item.room || ''))
            ]
        });

        drawTable(sheet, { firstRow: 4, lastRow: Math.max(lastRow, 5), lastCol: 6, groupRanges: [[4, 5], ...groupRanges] });
    }

    return workbook;
}

module.exports = { buildConsultationWorkbook, buildSessionWorkbook };
