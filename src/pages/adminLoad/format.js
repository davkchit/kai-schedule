import { getWeekTypeNumber } from '../../lib/date';

/**
 * Turns "18 недель" into the dates it actually means, shown right next to the
 * number: a count that runs the last teaching week through New Year is obvious
 * on sight, while the bare "18" is not.
 */
export function formatWeekRange(startDate, weeksCount) {
    if (!startDate || !Number.isInteger(weeksCount) || weeksCount < 1) {
        return '—';
    }

    const [year, month, day] = startDate.split('-').map(Number);
    const monday = new Date(Date.UTC(year, month - 1, day + (weeksCount - 1) * 7));
    const saturday = new Date(monday.getTime() + 5 * 86400000);
    const short = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

    return `${short(monday)}–${short(saturday)}.${saturday.getUTCFullYear()}`;
}

/** 2026-09-01 → 01.09.2026 */
export function formatIsoDay(isoDate) {
    const [year, month, day] = isoDate.split('-');
    return `${day}.${month}.${year}`;
}

export function parityLabel(parity) {
    return parity === 1 ? 'нечётная' : 'чётная';
}

/** The picked parity, else the calendar default for the chosen start date. */
export function resolveNewSemesterParity(form) {
    if (form.first_week_parity === 1 || form.first_week_parity === 2) {
        return form.first_week_parity;
    }

    if (!form.start_date) {
        return undefined;
    }

    const [year, month, day] = form.start_date.split('-').map(Number);
    return getWeekTypeNumber(new Date(year, month - 1, day));
}

export function pluralizeKinds(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'случай';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'случая';
    return 'случаев';
}

export function pluralizePairs(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'пара';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'пары';
    return 'пар';
}

export function pluralizeRecords(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'запись';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'записи';
    return 'записей';
}
