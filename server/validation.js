const { isValidIsoDate, isValidTime, mondayOfWeek } = require('./utils/date');

function createValidationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function assertPlainObject(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw createValidationError(message);
    }
}

function readRequiredString(value, label, maxLength = 255) {
    if (typeof value !== 'string') {
        throw createValidationError(`${label} должно быть строкой`);
    }

    const normalized = value.trim();

    if (!normalized) {
        throw createValidationError(`${label} не должно быть пустым`);
    }

    if (normalized.length > maxLength) {
        throw createValidationError(`${label} слишком длинное`);
    }

    return normalized;
}

function readOptionalString(value, label, maxLength = 255) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (typeof value !== 'string') {
        throw createValidationError(`${label} должно быть строкой`);
    }

    const normalized = value.trim();

    if (normalized.length > maxLength) {
        throw createValidationError(`${label} слишком длинное`);
    }

    return normalized || null;
}

function readInteger(value, label, { min, max, allowUndefined = false } = {}) {
    if (allowUndefined && value === undefined) {
        return undefined;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed)) {
        throw createValidationError(`${label} должно быть целым числом`);
    }

    if (min !== undefined && parsed < min) {
        throw createValidationError(`${label} должно быть не меньше ${min}`);
    }

    if (max !== undefined && parsed > max) {
        throw createValidationError(`${label} должно быть не больше ${max}`);
    }

    return parsed;
}

function validateLoginBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    return {
        username: readRequiredString(body.username, 'Логин', 100),
        password: readRequiredString(body.password, 'Пароль', 255)
    };
}

function validateLessonUpdateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const payload = {};

    if (body.subgroup !== undefined) {
        payload.subgroup = readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 });
    }

    if (body.day_of_week !== undefined) {
        payload.day_of_week = readInteger(body.day_of_week, 'День недели', { min: 1, max: 7 });
    }

    if (body.week_type !== undefined) {
        payload.week_type = readInteger(body.week_type, 'Тип недели', { min: 0, max: 2 });
    }

    if (body.kind !== undefined) {
        payload.kind = readLessonKind(body.kind);
    }

    if (body.specific_week !== undefined) {
        if (body.specific_week === '' || body.specific_week === 'null' || body.specific_week === null) {
            payload.specific_week = null;
        } else {
            payload.specific_week = readInteger(body.specific_week, 'Номер конкретной недели', { min: 1 });
        }
    }

    if (body.time_start !== undefined) {
        const timeStart = readRequiredString(body.time_start, 'Время начала', 5);
        if (!isValidTime(timeStart)) {
            throw createValidationError('Некорректное время начала');
        }
        payload.time_start = timeStart;
    }

    if (body.time_end !== undefined) {
        const timeEnd = readRequiredString(body.time_end, 'Время окончания', 5);
        if (!isValidTime(timeEnd)) {
            throw createValidationError('Некорректное время окончания');
        }
        payload.time_end = timeEnd;
    }

    if (body.subject !== undefined) {
        payload.subject = readRequiredString(body.subject, 'Предмет');
    }

    if (body.room !== undefined) {
        payload.room = readOptionalString(body.room, 'Кабинет');
    }

    if (body.lesson_type !== undefined) {
        payload.lesson_type = readLessonType(body.lesson_type);
    }

    if (body.teacher !== undefined) {
        payload.teacher = readOptionalString(body.teacher, 'Преподаватель');
    }

    if (body.teacher_id !== undefined) {
        payload.teacher_id = readOptionalId(body.teacher_id, 'teacher_id');
    }

    if (body.discipline_id !== undefined) {
        payload.discipline_id = readOptionalId(body.discipline_id, 'discipline_id');
    }

    if (body.sort_order !== undefined) {
        payload.sort_order = readInteger(body.sort_order, 'Порядок сортировки', { min: 0 });
    }

    return payload;
}

function validateMaterializeWeekBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (!['upsert', 'remove', 'copy'].includes(body.action)) {
        throw createValidationError('Поле action должно быть upsert, remove или copy');
    }

    // copy: the week entered exactly as the template has it — no pair named.
    if (body.action === 'copy') {
        return {
            group_id: readInteger(body.group_id, 'group_id', { min: 1 }),
            week_number: readInteger(body.week_number, 'week_number', { min: 1 }),
            action: 'copy'
        };
    }

    const timeStart = readRequiredString(body.time_start, 'Время начала', 5);
    const timeEnd = readRequiredString(body.time_end, 'Время окончания', 5);

    if (!isValidTime(timeStart) || !isValidTime(timeEnd)) {
        throw createValidationError('Некорректное время');
    }

    const result = {
        group_id: readInteger(body.group_id, 'group_id', { min: 1 }),
        week_number: readInteger(body.week_number, 'week_number', { min: 1 }),
        action: body.action,
        day_of_week: readInteger(body.day_of_week, 'День недели', { min: 1, max: 7 }),
        time_start: timeStart,
        time_end: timeEnd,
        subgroup: body.subgroup === undefined ? 0 : readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 })
    };

    if (body.action === 'upsert') {
        result.subject = readRequiredString(body.subject, 'Предмет');
        result.room = readOptionalString(body.room, 'Кабинет');
        result.lesson_type = readLessonType(body.lesson_type);
        result.teacher = readOptionalString(body.teacher, 'Преподаватель');
        result.teacher_id = readOptionalId(body.teacher_id, 'teacher_id');
        result.discipline_id = readOptionalId(body.discipline_id, 'discipline_id');
        result.kind = readLessonKind(body.kind);
    }

    return result;
}

function validateMoveLessonBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (!['template', 'week'].includes(body.mode)) {
        throw createValidationError('Поле mode должно быть template или week');
    }

    const timeStart = readRequiredString(body.time_start, 'Время начала', 5);
    const timeEnd = readRequiredString(body.time_end, 'Время окончания', 5);

    if (!isValidTime(timeStart) || !isValidTime(timeEnd)) {
        throw createValidationError('Некорректное время');
    }

    if (timeStart >= timeEnd) {
        throw createValidationError('Время окончания должно быть позже времени начала');
    }

    const result = {
        lesson_id: readInteger(body.lesson_id, 'lesson_id', { min: 1 }),
        mode: body.mode,
        day_of_week: readInteger(body.day_of_week, 'День недели', { min: 1, max: 7 }),
        time_start: timeStart,
        time_end: timeEnd
    };

    if (body.mode === 'week') {
        result.week_number = readInteger(body.week_number, 'week_number', { min: 1 });
    }

    return result;
}

function validateLessonCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const timeStart = readRequiredString(body.time_start, 'Время начала', 5);
    const timeEnd = readRequiredString(body.time_end, 'Время окончания', 5);

    if (!isValidTime(timeStart)) {
        throw createValidationError('Некорректное время начала');
    }

    if (!isValidTime(timeEnd)) {
        throw createValidationError('Некорректное время окончания');
    }

    if (timeStart >= timeEnd) {
        throw createValidationError('Время окончания должно быть позже времени начала');
    }

    let specificWeek = null;

    if (body.specific_week !== undefined && body.specific_week !== null && body.specific_week !== '') {
        specificWeek = readInteger(body.specific_week, 'Номер конкретной недели', { min: 1 });
    }

    return {
        group_id: readInteger(body.group_id, 'group_id', { min: 1 }),
        subgroup: body.subgroup === undefined ? 0 : readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 }),
        day_of_week: readInteger(body.day_of_week, 'День недели', { min: 1, max: 7 }),
        week_type: body.week_type === undefined ? 0 : readInteger(body.week_type, 'Тип недели', { min: 0, max: 2 }),
        specific_week: specificWeek,
        // template_from_week is intentionally NOT accepted from the client: it's the
        // anchor that makes "edits never rewrite history" hold, so it must always be
        // derived server-side from the real current date, never trusted from the request.
        is_removed: Boolean(body.is_removed),
        time_start: timeStart,
        time_end: timeEnd,
        subject: readRequiredString(body.subject, 'Предмет'),
        room: readOptionalString(body.room, 'Кабинет'),
        lesson_type: readLessonType(body.lesson_type),
        teacher: readOptionalString(body.teacher, 'Преподаватель'),
        teacher_id: readOptionalId(body.teacher_id, 'teacher_id'),
        discipline_id: readOptionalId(body.discipline_id, 'discipline_id'),
        kind: readLessonKind(body.kind),
        sort_order: body.sort_order === undefined ? 0 : readInteger(body.sort_order, 'Порядок сортировки', { min: 0 }),
        // The template row this one is a new version of (an edit or a removal
        // made in the template view), so it can take that row's place.
        replaces_lesson_id: body.replaces_lesson_id === undefined || body.replaces_lesson_id === null
            ? null
            : readInteger(body.replaces_lesson_id, 'replaces_lesson_id', { min: 1 })
    };
}

/**
 * A pair's type on the schedule. Hours match a plan row on it exactly, and the plan only
 * knows these three — «лекция» typed through the API would silently count for nobody.
 * Empty is fine (an event, or a pair that counts for nobody anyway).
 */
function readLessonType(value) {
    const type = readOptionalString(value, 'Тип занятия', 50);

    if (type !== null && !LOAD_PLAN_LESSON_TYPES.includes(type)) {
        throw createValidationError(`Тип занятия должен быть одним из: ${LOAD_PLAN_LESSON_TYPES.join(', ')}`);
    }

    return type;
}

const LESSON_KINDS = ['lesson', 'event'];

/**
 * 'event' covers торжественная линейка, субботник and similar — entries that
 * occupy a slot and show a title but are not teaching, so they never carry a
 * teacher or count towards anyone's hours.
 */
function readLessonKind(value) {
    if (value === undefined || value === null || value === '') {
        return 'lesson';
    }

    if (!LESSON_KINDS.includes(value)) {
        throw createValidationError('Тип записи должен быть «lesson» или «event»');
    }

    return value;
}

function validateSettingsBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const allowedKeys = ['director_name', 'director_title', 'academic_year', 'study_form', 'term_parity'];
    const bodyKeys = Object.keys(body);

    // The start date moves every entered week and every teacher's hours, so it
    // is changed only on the semester itself (Нагрузка), behind the impact
    // preview and the closed-semester guard — never as a side effect of saving
    // the director's name.
    if (bodyKeys.includes('semester_start_date')) {
        throw createValidationError('Дата начала семестра меняется в разделе «Нагрузка» — там видно, как это повлияет на часы');
    }

    for (const key of bodyKeys) {
        if (!allowedKeys.includes(key)) {
            throw createValidationError(`Неизвестная настройка: ${key}`);
        }
    }

    if (body.term_parity !== undefined && !['fall', 'spring'].includes(body.term_parity)) {
        throw createValidationError('term_parity должен быть fall или spring');
    }

    return {
        director_name: readOptionalString(body.director_name, 'ФИО директора', 200),
        director_title: readOptionalString(body.director_title, 'Должность', 200),
        academic_year: readOptionalString(body.academic_year, 'Учебный год', 20),
        study_form: readOptionalString(body.study_form, 'Форма обучения', 100),
        term_parity: body.term_parity === undefined ? null : body.term_parity
    };
}

function validateAccountUpdateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const result = {
        current_password: readRequiredString(body.current_password, 'Текущий пароль', 255)
    };

    if (body.new_username !== undefined) {
        result.new_username = readRequiredString(body.new_username, 'Новый логин', 100);
    }

    if (body.new_password !== undefined) {
        const newPassword = readRequiredString(body.new_password, 'Новый пароль', 255);

        // Length is what makes a password hard to guess; no rules about
        // digits and symbols, which mostly produce «Password1!».
        if (newPassword.length < 12) {
            throw createValidationError('Новый пароль должен быть не короче 12 символов');
        }

        result.new_password = newPassword;
    }

    if (result.new_username === undefined && result.new_password === undefined) {
        throw createValidationError('Укажите новый логин или новый пароль');
    }

    return result;
}

function validateGroupUpdateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    // Each field only when sent: joining a group must not wipe its direction.
    const result = {};

    if (body.direction !== undefined) {
        result.direction = readOptionalString(body.direction, 'Направление', 300);
    }

    if (body.joined_to !== undefined) {
        result.joined_to = readOptionalJoinTarget(body.joined_to);
    }

    return result;
}

/** The group this one studies together with (null or '' = on its own). */
function readOptionalJoinTarget(value) {
    return value === null || value === '' ? null : readInteger(value, 'joined_to', { min: 1 });
}

function validateGroupCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    return {
        university_id: readInteger(body.university_id, 'university_id', { min: 1 }),
        name: readRequiredString(body.name, 'Название группы', 50),
        direction: readOptionalString(body.direction, 'Направление', 300),
        joined_to: body.joined_to === undefined ? null : readOptionalJoinTarget(body.joined_to)
    };
}

function validateTeacherCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    return {
        full_name: readRequiredString(body.full_name, 'ФИО преподавателя', 200)
    };
}

function validateDisciplineCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    return {
        name: readRequiredString(body.name, 'Название дисциплины', 200)
    };
}

function validateSemesterCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const startDate = readRequiredString(body.start_date, 'Дата начала семестра', 10);

    if (!isValidIsoDate(startDate)) {
        throw createValidationError('Дата начала семестра должна быть в формате YYYY-MM-DD');
    }

    return {
        label: readRequiredString(body.label, 'Название семестра', 100),
        // Stored as the Monday of its week — see mondayOfWeek.
        start_date: mondayOfWeek(startDate),
        weeks_count: body.weeks_count === undefined ? 18 : readInteger(body.weeks_count, 'Количество недель', { min: 1, max: 52 }),
        first_week_parity: readOptionalWeekParity(body.first_week_parity)
    };
}

/** 1 — первая неделя нечётная, 2 — чётная; absent means "use the calendar default". */
function readOptionalWeekParity(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const parity = readInteger(value, 'Чётность первой недели', { min: 1, max: 2 });
    return parity;
}

function validateSemesterUpdateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const result = {};

    if (body.label !== undefined) {
        result.label = readRequiredString(body.label, 'Название семестра', 100);
    }

    if (body.start_date !== undefined) {
        const startDate = readRequiredString(body.start_date, 'Дата начала семестра', 10);

        if (!isValidIsoDate(startDate)) {
            throw createValidationError('Дата начала семестра должна быть в формате YYYY-MM-DD');
        }

        result.start_date = mondayOfWeek(startDate);
    }

    if (body.weeks_count !== undefined) {
        result.weeks_count = readInteger(body.weeks_count, 'Количество недель', { min: 1, max: 52 });
    }

    if (body.is_active !== undefined) {
        result.is_active = Boolean(body.is_active);
    }

    if (body.first_week_parity !== undefined) {
        result.first_week_parity = readOptionalWeekParity(body.first_week_parity);
    }

    return result;
}

const LOAD_PLAN_LESSON_TYPES = ['Лекция', 'Практика', 'Лаб'];

function validateLoadPlanCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const lessonType = readRequiredString(body.lesson_type, 'Вид занятия', 50);

    if (!LOAD_PLAN_LESSON_TYPES.includes(lessonType)) {
        throw createValidationError(`Вид занятия должен быть одним из: ${LOAD_PLAN_LESSON_TYPES.join(', ')}`);
    }

    return {
        semester_id: readInteger(body.semester_id, 'semester_id', { min: 1 }),
        teacher_id: readInteger(body.teacher_id, 'teacher_id', { min: 1 }),
        discipline_id: readInteger(body.discipline_id, 'discipline_id', { min: 1 }),
        lesson_type: lessonType,
        ...readPlanGroups(body),
        subgroup: body.subgroup === undefined ? 0 : readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 }),
        // Optional: a plan row can be auto-created (e.g. the moment a schedule
        // lesson references a teacher/discipline/type/group combo with no plan
        // row yet) before its hours are known — it then shows as "часы не
        // заданы" until the specialist fills them in.
        planned_hours: readOptionalPositiveInteger(body.planned_hours, 'Плановые часы'),
        entered_by: body.entered_by === 'teacher' ? 'teacher' : 'specialist'
    };
}

/**
 * A plan row's groups: `group_ids` (a stream, e.g. 23303 + 23313) or a single
 * `group_id`. Returns both — group_id is the first of group_ids.
 */
function readPlanGroups(body) {
    if (body.group_ids === undefined) {
        const groupId = readInteger(body.group_id, 'group_id', { min: 1 });
        return { group_id: groupId, group_ids: [groupId] };
    }

    if (!Array.isArray(body.group_ids) || body.group_ids.length === 0 || body.group_ids.length > 8) {
        throw createValidationError('Укажите от 1 до 8 групп');
    }

    const groupIds = body.group_ids.map((value) => readInteger(value, 'group_ids', { min: 1 }));

    if (new Set(groupIds).size !== groupIds.length) {
        throw createValidationError('Одна и та же группа указана дважды');
    }

    return { group_id: groupIds[0], group_ids: groupIds };
}

function readOptionalPositiveInteger(value, label) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    return readInteger(value, label, { min: 1, max: 2000 });
}

/** A dictionary id (teacher_id/discipline_id on a lesson) — absent or null means "not from the dictionary". */
function readOptionalId(value, label) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    return readInteger(value, label, { min: 1 });
}

function validateLoadPlanUpdateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    const result = {};

    if (body.planned_hours !== undefined) {
        result.planned_hours = readOptionalPositiveInteger(body.planned_hours, 'Плановые часы');
    }

    if (body.confirmed !== undefined) {
        result.confirmed = Boolean(body.confirmed);
    }

    // Full-row edit — fixing a plan row entered against the wrong teacher,
    // discipline, type or group, rather than deleting and recreating it.
    if (body.teacher_id !== undefined) {
        result.teacher_id = readInteger(body.teacher_id, 'teacher_id', { min: 1 });
    }

    if (body.discipline_id !== undefined) {
        result.discipline_id = readInteger(body.discipline_id, 'discipline_id', { min: 1 });
    }

    if (body.group_ids !== undefined) {
        Object.assign(result, readPlanGroups(body));
    } else if (body.group_id !== undefined) {
        result.group_id = readInteger(body.group_id, 'group_id', { min: 1 });
    }

    if (body.subgroup !== undefined) {
        result.subgroup = readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 });
    }

    if (body.lesson_type !== undefined) {
        const lessonType = readRequiredString(body.lesson_type, 'Вид занятия', 50);

        if (!LOAD_PLAN_LESSON_TYPES.includes(lessonType)) {
            throw createValidationError(`Вид занятия должен быть одним из: ${LOAD_PLAN_LESSON_TYPES.join(', ')}`);
        }

        result.lesson_type = lessonType;
    }

    return result;
}

const ATTESTATION_KINDS = ['exam', 'credit', 'consultation'];

/**
 * An экзамен, зачёт or консультация (server/utils/attestations.js). The whole
 * row is sent every time, for a new one and an edit alike. Discipline and
 * teacher: an id from the dictionary, or text when nothing there matches.
 */
function validateAttestationBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (!ATTESTATION_KINDS.includes(body.kind)) {
        throw createValidationError('Вид должен быть экзаменом, зачётом или консультацией');
    }

    const date = readRequiredString(body.date, 'Дата', 10);

    if (!isValidIsoDate(date)) {
        throw createValidationError('Некорректная дата. Ожидается формат YYYY-MM-DD');
    }

    const timeStart = readRequiredString(body.time_start, 'Время начала', 5);
    const timeEnd = readOptionalString(body.time_end, 'Время окончания', 5);

    if (!isValidTime(timeStart) || (timeEnd && !isValidTime(timeEnd))) {
        throw createValidationError('Некорректное время');
    }

    if (timeEnd && timeEnd <= timeStart) {
        throw createValidationError('Время окончания должно быть позже начала');
    }

    const result = {
        kind: body.kind,
        group_id: readInteger(body.group_id, 'group_id', { min: 1 }),
        subgroup: body.subgroup === undefined ? 0 : readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 }),
        date,
        time_start: timeStart,
        time_end: timeEnd,
        room: readOptionalString(body.room, 'Аудитория', 50),
        discipline_id: readOptionalId(body.discipline_id, 'discipline_id'),
        discipline_text: readOptionalString(body.discipline_text, 'Дисциплина'),
        teacher_id: readOptionalId(body.teacher_id, 'teacher_id'),
        teacher_text: readOptionalString(body.teacher_text, 'Преподаватель')
    };

    if (!result.discipline_id && !result.discipline_text) {
        throw createValidationError('Укажите дисциплину');
    }

    return result;
}

module.exports = {
    ATTESTATION_KINDS,
    createValidationError,
    validateAttestationBody,
    validateAccountUpdateBody,
    validateDisciplineCreateBody,
    validateGroupCreateBody,
    validateGroupUpdateBody,
    validateLessonCreateBody,
    validateLessonUpdateBody,
    validateLoadPlanCreateBody,
    validateLoadPlanUpdateBody,
    validateLoginBody,
    validateMaterializeWeekBody,
    validateMoveLessonBody,
    validateSemesterCreateBody,
    validateSemesterUpdateBody,
    validateSettingsBody,
    validateTeacherCreateBody
};
