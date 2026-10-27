// How far ahead students (and the public teacher page, and Alice) may look.
//
// The template is the specialist's draft, never shown: a student sees only
// weeks entered as their own, and only up to the end of the current week —
// plus the next week once it has been entered (the branch enters it on
// Thursday). Nothing further ahead, even if it is already in the database.
// Exams, credits and consultations are the exception: their days are shown
// in advance (they are published early), see routes/api.js.

const { addDaysToIsoDate, formatLocalDate, getSemesterWeekMeta } = require('./date');
const { getSemesterForDate } = require('./semesters');
const { scheduleGroupId } = require('./groupJoin');

/** The Monday of the week isoDate falls in. */
function mondayOf(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    return addDaysToIsoDate(isoDate, 1 - weekday);
}

/** Whether the group's week starting on mondayIso has been entered (has rows of its own). */
function weekEntered(db, groupId, mondayIso) {
    const semester = getSemesterForDate(db, mondayIso);

    if (!semester) {
        return false;
    }

    const { weekNumber } = getSemesterWeekMeta(semester, mondayIso);
    return Boolean(db.prepare('SELECT 1 FROM lessons WHERE semester_id = ? AND group_id = ? AND specific_week = ? LIMIT 1')
        .get(semester.id, scheduleGroupId(db, groupId), weekNumber));
}

/** The last date whose pairs are open to the public for this group (inclusive). */
function visibleUntil(db, groupId, today = formatLocalDate()) {
    const sunday = addDaysToIsoDate(mondayOf(today), 6);
    return weekEntered(db, groupId, addDaysToIsoDate(sunday, 1)) ? addDaysToIsoDate(sunday, 7) : sunday;
}

module.exports = { mondayOf, visibleUntil };
