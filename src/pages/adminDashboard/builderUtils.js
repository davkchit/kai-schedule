// Constants and date helpers of the schedule constructor. Moved verbatim from
// AdminDashboardPage.jsx.

const DAY_NAMES = {
    1: 'Пн',
    2: 'Вт',
    3: 'Ср',
    4: 'Чт',
    5: 'Пт',
    6: 'Сб'
};

DAY_NAMES[7] = '\u0412\u0441';

// Same vocabulary the load plan uses — the hour engine matches a pair to a
// plan row by exact lesson_type text, so a form offering a value the plan
// never uses (an old "Лаб. работа" instead of "Лаб") would quietly create
// pairs nothing could ever count.
const LESSON_TYPES = ['Лекция', 'Практика', 'Лаб'];

const DEFAULT_EDIT_FORM = {
    id: '',
    group_id: '',
    day_of_week: 1,
    time_start: '',
    time_end: '',
    subject: '',
    room: '',
    lesson_type: 'Лекция',
    teacher: '',
    teacher_id: null,
    discipline_id: null,
    subgroup: 0,
    week_type: 0,
    specific_week: '',
    // Other groups the new pair goes to as well (a stream's lecture).
    extra_group_ids: []
};

const BUILDER_TIME_SLOTS = [
    ['08:00', '09:30'],
    ['09:40', '11:10'],
    ['11:30', '13:00'],
    ['13:10', '14:40'],
    ['15:00', '16:30'],
    ['16:40', '18:10']
];

const BUILDER_DAYS = [1, 2, 3, 4, 5, 6, 7];

function getMondayOfWeek(date) {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    const dayOfWeek = normalized.getDay();
    const offsetToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    normalized.setDate(normalized.getDate() + offsetToMonday);
    return normalized;
}

function formatDayMonth(date) {
    return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getCourseFromGroupName(name) {
    const match = String(name).match(/^\d{2}(\d)\d{2}$/);
    return match ? Number(match[1]) : null;
}

export {
    DAY_NAMES,
    LESSON_TYPES,
    DEFAULT_EDIT_FORM,
    BUILDER_TIME_SLOTS,
    BUILDER_DAYS,
    getMondayOfWeek,
    formatDayMonth,
    getCourseFromGroupName
};
