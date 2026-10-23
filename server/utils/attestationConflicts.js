// What an экзамен, зачёт or консультация collides with. They live outside the
// weekly timetable (server/utils/attestations.js), so nothing else stops one
// from landing on top of a pair. Checked when one is saved (the specialist
// confirms or changes it) and again every time the list is read — a pair
// added later in the constructor shows up on the row it now overlaps.
//
// Only one thing is refused outright: the very same record twice. The rest
// are warnings, because each can be intended (an exam that replaces that
// day's pair, a consultation held in the same room as another group's).

const { getSemesterForDate } = require('./semesters');
const { getSemesterWeekMeta } = require('./date');
const { scheduleGroupId } = require('./groupJoin');
const { resolveGroupLessons } = require('./dayResolve');

// The lists give a start time only. For an overlap a consultation without an
// end counts as an hour (the branch puts them back to back: 9:00, 10:00), an
// exam or a credit as one pair.
const DEFAULT_MINUTES = { consultation: 60, exam: 90, credit: 90 };
const KIND_LABELS = { exam: 'экзамен', credit: 'зачёт', consultation: 'консультация' };

const toMinutes = (time) => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
};
const span = (item) => {
    const start = toMinutes(item.time_start);
    return [start, item.time_end ? toMinutes(item.time_end) : start + (DEFAULT_MINUTES[item.kind] || 90)];
};
const overlaps = (left, right) => {
    const [leftStart, leftEnd] = span(left);
    const [rightStart, rightEnd] = span(right);
    return leftStart < rightEnd && rightStart < leftEnd;
};
const subgroupsMeet = (left, right) => !left.subgroup || !right.subgroup || left.subgroup === right.subgroup;
const normalize = (value) => String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const formatDate = (isoDate) => isoDate.split('-').reverse().slice(0, 2).join('.');
const timeText = (item) => (item.time_end ? `${item.time_start}–${item.time_end}` : item.time_start);
const sameTeacher = (left, right) => (left.teacher_id && right.teacher_id
    ? left.teacher_id === right.teacher_id
    : Boolean(normalize(left.teacher)) && normalize(left.teacher) === normalize(right.teacher));
// «онлайн» and a blank room are not a place two groups can fight over.
const roomKey = (room) => {
    const key = normalize(room);
    return key && !['онлайн', 'online', 'дистанционно'].includes(key) ? key : '';
};

/**
 * Pairs every group really has on a date, resolved the way the student page
 * resolves them (src/lib/scheduleResolve.js): the semester in effect that
 * day, a week with its own rows replaces the template, nothing past the last
 * teaching week. Cached per date for one request.
 */
function createDayIndex(db) {
    const groups = db.prepare('SELECT id, name FROM groups_ WHERE joined_to IS NULL').all();
    const labels = new Map(db.prepare('SELECT id, name, joined_to FROM groups_').all()
        .filter((group) => group.joined_to)
        .map((group) => [group.joined_to, group.name]));
    const lessonsOf = db.prepare(`
        SELECT * FROM lessons WHERE group_id = ? AND semester_id = ?
    `);
    const lessonCache = new Map();
    const dayCache = new Map();

    function groupLessons(groupId, semesterId) {
        const key = `${groupId}:${semesterId}`;
        if (!lessonCache.has(key)) lessonCache.set(key, lessonsOf.all(groupId, semesterId));
        return lessonCache.get(key);
    }

    function pairsOn(isoDate) {
        if (dayCache.has(isoDate)) return dayCache.get(isoDate);

        const semester = getSemesterForDate(db, isoDate);
        const pairs = [];

        if (semester) {
            for (const group of groups) {
                const { lessons } = resolveGroupLessons(db, group.id, isoDate, { lessonsOf: groupLessons, semesterFor: () => semester });
                const name = labels.has(group.id) ? `${group.name} / ${labels.get(group.id)}` : group.name;
                lessons.forEach((lesson) => pairs.push({ ...lesson, group_name: name }));
            }
        }

        dayCache.set(isoDate, pairs);
        return pairs;
    }

    return { pairsOn };
}

/**
 * Problems with one record (as stored, or about to be). `others` are the
 * other records to compare with — the caller decides which (all of them, or
 * the ones on that date). Returns { duplicate, warnings }.
 */
function findAttestationConflicts(db, record, others, dayIndex = createDayIndex(db)) {
    const groupId = scheduleGroupId(db, record.group_id);
    const warnings = [];
    // The group's own pairs this record lands on (clashing); those it takes
    // over entirely (covered) the specialist may take out of that day, so
    // they stop counting toward anyone's hours.
    const clashing = [];
    const covered = [];
    let duplicate = null;

    const [year, month, day] = record.date.split('-').map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0) {
        warnings.push('Это воскресенье');
    }

    for (const pair of dayIndex.pairsOn(record.date)) {
        if (!overlaps(record, pair)) continue;
        const what = `${pair.subject || 'пара'}${pair.lesson_type ? ` (${pair.lesson_type.toLowerCase()})` : ''}, ${timeText(pair)}`;

        if (pair.group_id === groupId && subgroupsMeet(record, pair)) {
            warnings.push(`У группы в это время пара: ${what}`);
            clashing.push(pair);
            // Only a pair the record takes over entirely can be taken out: a
            // credit of п/г 1 over a whole-group pair leaves п/г 2 that pair.
            if (!record.subgroup || pair.subgroup === record.subgroup) {
                covered.push(pair);
            }
        } else if (pair.group_id !== groupId) {
            if (sameTeacher(record, pair)) warnings.push(`${record.teacher} в это время ведёт пару у ${pair.group_name}: ${what}`);
            if (roomKey(record.room) && roomKey(record.room) === roomKey(pair.room)) {
                warnings.push(`Ауд. ${record.room} в это время занята: ${pair.group_name}, ${what}`);
            }
        }
    }

    const isSameSubject = (other) => (record.discipline_id && other.discipline_id
        ? record.discipline_id === other.discipline_id
        : normalize(record.subject) === normalize(other.subject));
    const sameCourse = others.filter((other) => other.id !== record.id
        && scheduleGroupId(db, other.group_id) === groupId && isSameSubject(other) && subgroupsMeet(record, other));

    // A consultation comes before an exam. One the exams of its subject are all
    // over by is a slip (a resit later on is fine: it is still ahead of it).
    const exams = [...sameCourse.filter((other) => other.kind === 'exam'), ...(record.kind === 'exam' ? [record] : [])];
    const consultations = [...sameCourse.filter((other) => other.kind === 'consultation'), ...(record.kind === 'consultation' ? [record] : [])];
    for (const consultation of consultations) {
        const lastExam = exams.map((exam) => exam.date).sort().pop();
        if (lastExam && consultation.date > lastExam && (consultation === record || record.kind === 'exam')) {
            warnings.push(`Консультация ${formatDate(consultation.date)} — уже после экзамена (${formatDate(lastExam)})`);
        }
    }

    for (const other of others) {
        if (other.id === record.id) continue;
        const sameGroup = scheduleGroupId(db, other.group_id) === groupId;
        const sameSubject = isSameSubject(other);

        if (other.date !== record.date || !overlaps(record, other)) continue;
        const what = `${KIND_LABELS[other.kind]} «${other.subject}», ${timeText(other)}`;

        if (sameGroup && subgroupsMeet(record, other)) {
            if (other.kind === record.kind && other.time_start === record.time_start && other.subgroup === record.subgroup && sameSubject) {
                duplicate = `Такая запись уже есть: ${what}`;
            } else {
                warnings.push(`У группы в это время уже ${what}`);
            }
        } else if (!sameGroup && !(sameSubject && other.kind === record.kind && other.time_start === record.time_start)) {
            // (The same exam at the same time for another group is one joint
            // session — 23203 and 23213 sit Базы данных together — not a clash.)
            if (sameTeacher(record, other)) warnings.push(`${record.teacher} в это время занят(а): ${other.group_name}, ${what}`);
            if (roomKey(record.room) && roomKey(record.room) === roomKey(other.room)) {
                warnings.push(`Ауд. ${record.room} в это время занята: ${other.group_name}, ${what}`);
            }
        }
    }

    return { duplicate, warnings: [...new Set(warnings)], covered, clashing };
}

/**
 * Экзамены, зачёты, консультации of the lesson's group that a pair lands on —
 * a week's own pair on its date, a template pair on each of its dates from
 * template_from_week on, except in weeks that have rows of their own (the
 * template does not run there).
 */
function attestationsUnderLesson(db, semester, lesson, ignoreId = null) {
    if (!lesson || lesson.is_removed || lesson.kind === 'event') {
        return [];
    }

    const groupId = scheduleGroupId(db, lesson.group_id);
    const records = db.prepare(`
        SELECT a.*, COALESCE(d.name, a.discipline_text) AS subject
        FROM attestations a LEFT JOIN disciplines d ON d.id = a.discipline_id
        WHERE a.semester_id = ? AND a.group_id = ?
    `).all(semester.id, groupId);
    const ownWeeks = new Set(db.prepare('SELECT DISTINCT specific_week FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week IS NOT NULL')
        .all(semester.id, groupId).map((row) => row.specific_week));

    return records.filter((record) => {
        const { weekNumber, weekTypeNumber } = getSemesterWeekMeta(semester, record.date);
        const [year, month, day] = record.date.split('-').map(Number);
        const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
        const onItsDay = lesson.specific_week !== null && lesson.specific_week !== undefined
            ? lesson.specific_week === weekNumber
            : weekNumber >= (lesson.template_from_week ?? 1) && weekNumber <= semester.weeks_count && !ownWeeks.has(weekNumber)
                && (lesson.week_type === 0 || lesson.week_type === weekTypeNumber);

        return record.id !== ignoreId && onItsDay && weekday === lesson.day_of_week && subgroupsMeet(record, lesson) && overlaps(record, lesson);
    });
}

const recordLabel = (record) => `${KIND_LABELS[record.kind]} «${record.subject}» ${formatDate(record.date)} ${timeText(record)}`;

/**
 * Records a pair (just saved in the constructor) lands on, said back to the
 * specialist, e.g. «экзамен «Физика» 15.01 09:00». Only records without an end
 * time — one with an end refuses the pair beforehand (timedAttestationError).
 */
function findAttestationsUnderLesson(db, semester, lesson) {
    return attestationsUnderLesson(db, semester, lesson).filter((record) => !record.time_end).map(recordLabel);
}

/**
 * A record with a known end time is a fixed block of the group's day: no pair
 * may be placed over it. The error to answer with, or null. (A record without
 * an end is only assumed to last an hour or a pair, so that one stays a warning.)
 */
function timedAttestationError(db, semester, lesson, ignoreId = null) {
    const record = attestationsUnderLesson(db, semester, lesson, ignoreId).find((item) => item.time_end);
    return record ? `В это время у группы ${recordLabel(record)} — пару сюда поставить нельзя` : null;
}

module.exports = { createDayIndex, findAttestationConflicts, findAttestationsUnderLesson, timedAttestationError };
