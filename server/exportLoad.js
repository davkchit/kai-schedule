const ExcelJS = require('exceljs');
const { sanitizeCellText } = require('./exportSchedule');
const { HOURS_PER_LESSON } = require('./utils/loadCalc');

const THIN = { style: 'thin' };
const MEDIUM = { style: 'medium' };
const TITLE_FONT = { name: 'Times New Roman', size: 18, bold: true };
const HEADER_FONT = { name: 'Times New Roman', size: 12, bold: true };
const CELL_FONT = { name: 'Times New Roman', size: 12 };

function box(cell, { top, bottom, left, right } = {}) {
    cell.border = {
        top: top || THIN,
        bottom: bottom || THIN,
        left: left || THIN,
        right: right || THIN
    };
}

function writeHeaderRow(sheet, rowNum, labels, widths) {
    labels.forEach((label, index) => {
        const cell = sheet.getCell(rowNum, index + 1);
        cell.value = label;
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
        box(cell, { top: MEDIUM, bottom: MEDIUM, left: THIN, right: THIN });

        if (widths?.[index]) {
            sheet.getColumn(index + 1).width = widths[index];
        }
    });
    sheet.getRow(rowNum).height = 32;
}

function writeDataRow(sheet, rowNum, values, { align } = {}) {
    values.forEach((value, index) => {
        const cell = sheet.getCell(rowNum, index + 1);
        cell.value = typeof value === 'string' ? sanitizeCellText(value) : value;
        cell.font = CELL_FONT;
        cell.alignment = { horizontal: (align && align[index]) || 'left', vertical: 'middle', wrapText: true };
        box(cell);
    });
}

function writeTitle(sheet, text, lastCol) {
    sheet.mergeCells(1, 1, 1, lastCol);
    const cell = sheet.getCell(1, 1);
    cell.value = text;
    cell.font = TITLE_FONT;
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(1).height = 30;
}

/**
 * Sheet 1: one line per teacher, plan/occurred/remaining totals summed
 * across every discipline and view type — this is the line that actually
 * gets handed over / signed.
 */
function buildSummarySheet(workbook, semesterLabel, rows) {
    const sheet = workbook.addWorksheet('Сводка', { views: [{ showGridLines: false }] });
    writeTitle(sheet, `Нагрузка — сводка (${semesterLabel})`, 4);

    const totalsByTeacher = new Map();

    for (const row of rows) {
        // Rows with no plan hours yet ("часы не заданы") don't contribute to
        // the planned total — otherwise one unset row would turn the whole
        // teacher's summed total into a meaningless partial number.
        const existing = totalsByTeacher.get(row.teacher_name) || { planned: 0, occurred: 0, hasUnplanned: false };
        if (row.planned_hours === null) {
            existing.hasUnplanned = true;
        } else {
            existing.planned += row.planned_hours;
        }
        existing.occurred += row.occurred_hours;
        totalsByTeacher.set(row.teacher_name, existing);
    }

    writeHeaderRow(sheet, 3, ['Преподаватель', 'План, ч', 'Проведено, ч', 'Осталось, ч'], [32, 14, 16, 14]);

    let rowNum = 4;
    for (const [teacherName, totals] of [...totalsByTeacher.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
        const plannedLabel = totals.hasUnplanned ? `${totals.planned}+` : totals.planned;
        const remainingLabel = totals.hasUnplanned ? '—' : Math.max(0, totals.planned - totals.occurred);
        writeDataRow(
            sheet,
            rowNum,
            [teacherName, plannedLabel, totals.occurred, remainingLabel],
            { align: ['left', 'center', 'center', 'center'] }
        );
        rowNum += 1;
    }

    if (totalsByTeacher.size === 0) {
        sheet.getCell(rowNum, 1).value = 'Нет данных';
        sheet.getCell(rowNum, 1).font = CELL_FONT;
    }
}

/**
 * Sheet 2: one row per load_plan line — the breakdown behind sheet 1's totals.
 */
function buildDisciplineSheet(workbook, semesterLabel, rows) {
    const sheet = workbook.addWorksheet('По дисциплинам', { views: [{ showGridLines: false }] });
    writeTitle(sheet, `Нагрузка по дисциплинам (${semesterLabel})`, 7);

    writeHeaderRow(
        sheet,
        3,
        ['Преподаватель', 'Дисциплина', 'Вид', 'Группа', 'План, ч', 'Проведено, ч', 'Осталось, ч'],
        [28, 30, 14, 14, 12, 14, 12]
    );

    let rowNum = 4;
    const sorted = [...rows].sort((a, b) =>
        a.teacher_name.localeCompare(b.teacher_name, 'ru') || a.discipline_name.localeCompare(b.discipline_name, 'ru')
    );

    for (const row of sorted) {
        const groupLabel = row.subgroup ? `${row.group_name} (${row.subgroup} п/г)` : row.group_name;
        writeDataRow(
            sheet,
            rowNum,
            [
                row.teacher_name,
                row.discipline_name,
                row.lesson_type,
                groupLabel,
                row.planned_hours ?? 'не задано',
                row.occurred_hours,
                row.planned_hours === null ? '—' : Math.max(0, row.planned_hours - row.occurred_hours)
            ],
            { align: ['left', 'left', 'center', 'center', 'center', 'center', 'center'] }
        );
        rowNum += 1;
    }

    if (sorted.length === 0) {
        sheet.getCell(rowNum, 1).value = 'Нет данных';
        sheet.getCell(rowNum, 1).font = CELL_FONT;
    }
}

const STATUS_LABELS = { true: 'проведено', false: 'предстоит' };

/**
 * Sheet 3: every individual occurrence, one per row. This is the "show your
 * work" sheet — when a total is disputed, this is what settles it: point at
 * the exact dates instead of arguing about the number.
 */
function buildDateSheet(workbook, semesterLabel, rows) {
    const sheet = workbook.addWorksheet('По датам', { views: [{ showGridLines: false }] });
    writeTitle(sheet, `Нагрузка по датам (${semesterLabel})`, 6);

    writeHeaderRow(
        sheet,
        3,
        ['Дата', 'Время', 'Преподаватель', 'Дисциплина', 'Часы', 'Статус'],
        [14, 16, 28, 30, 10, 14]
    );

    const entries = [];
    for (const row of rows) {
        for (const occurrence of row.occurrences || []) {
            entries.push({ row, occurrence });
        }
    }

    entries.sort((a, b) => (a.occurrence.date < b.occurrence.date ? -1 : a.occurrence.date > b.occurrence.date ? 1 : 0));

    let rowNum = 4;
    for (const { row, occurrence } of entries) {
        writeDataRow(
            sheet,
            rowNum,
            [
                formatRuDate(occurrence.date),
                `${occurrence.time_start}–${occurrence.time_end}`,
                row.teacher_name,
                `${row.discipline_name} (${row.lesson_type})`,
                occurrence.has_occurred ? HOURS_PER_LESSON : 0,
                STATUS_LABELS[occurrence.has_occurred]
            ],
            { align: ['center', 'center', 'left', 'left', 'center', 'center'] }
        );
        rowNum += 1;
    }

    if (entries.length === 0) {
        sheet.getCell(rowNum, 1).value = 'Нет данных — ни одна пара ещё не привязана к плану';
        sheet.getCell(rowNum, 1).font = CELL_FONT;
    }
}

function formatRuDate(isoDate) {
    const [year, month, day] = isoDate.split('-');
    return `${day}.${month}.${year}`;
}

/**
 * Builds the three-sheet load report: a signable summary, a per-discipline
 * breakdown, and a per-date ledger. Can be generated at any point in the
 * semester — hours are always computed as of "now", never stored, so the
 * report is simply a snapshot of the same numbers the teacher's own lookup
 * page shows.
 */
function buildLoadWorkbook({ semesterLabel, rows }) {
    const workbook = new ExcelJS.Workbook();
    buildSummarySheet(workbook, semesterLabel, rows);
    buildDisciplineSheet(workbook, semesterLabel, rows);
    buildDateSheet(workbook, semesterLabel, rows);
    return workbook;
}

module.exports = {
    buildLoadWorkbook
};
