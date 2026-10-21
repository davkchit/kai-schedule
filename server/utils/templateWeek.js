const clock = require('./clock');
const { addDaysToIsoDate, formatLocalDate, getSemesterWeekMeta, mondayOfWeek } = require('./date');

/**
 * The week a template change of one cell takes effect from.
 *
 * Template versions are per week, but a week is not one moment: on a
 * Wednesday, this week's Monday pair has already taken place. A change made
 * "from this week" used to rewrite it too — retiring a pair on Wednesday took
 * away the Monday it had just been taught (and its 2 hours), and a new pair
 * added on Wednesday for Monday appeared, and counted, on a Monday nobody held
 * it. So: if this cell's pair this week has already ended, the change starts
 * next week; otherwise this week.
 */
function templateWeekForSlot(semester, dayOfWeek, timeEnd, now = clock.now()) {
    const currentWeek = getSemesterWeekMeta(semester, formatLocalDate(now)).weekNumber;
    const slotDate = addDaysToIsoDate(mondayOfWeek(semester.start_date), (currentWeek - 1) * 7 + dayOfWeek - 1);
    const endsAt = new Date(`${slotDate}T${timeEnd}:00`);

    return endsAt.getTime() <= now.getTime() ? currentWeek + 1 : currentWeek;
}

module.exports = { templateWeekForSlot };
