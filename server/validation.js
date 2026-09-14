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

function parseTargetWeek(raw) {
    const value = raw ?? 'template';
    if (value === 'template' || value === 'current') return value;
    return readInteger(value, 'Номер недели', { min: 1 });
}

function validateLessonEntry(lesson, index, groupLabel = '') {
    assertPlainObject(lesson, `Занятие #${index + 1}${groupLabel} должно быть объектом`);

    const timeStart = readRequiredString(lesson.time_start, `time_start у занятия #${index + 1}`, 5);
    const timeEnd = readRequiredString(lesson.time_end, `time_end у занятия #${index + 1}`, 5);

    if (!isValidTime(timeStart) || !isValidTime(timeEnd)) {
        throw createValidationError(`Некорректное время у занятия #${index + 1}${groupLabel}`);
    }

    if (timeStart >= timeEnd) {
        throw createValidationError(`time_end должно быть позже time_start у занятия #${index + 1}${groupLabel}`);
    }

    const weekType = lesson.week_type ?? 'all';

    if (!['all', 'odd', 'even'].includes(weekType)) {
        throw createValidationError(`Некорректный week_type у занятия #${index + 1}${groupLabel}`);
    }

    return {
        day: readInteger(lesson.day, `day у занятия #${index + 1}`, { min: 1, max: 7 }),
        subgroup: lesson.subgroup === undefined ? 0 : readInteger(lesson.subgroup, `subgroup у занятия #${index + 1}`, { min: 0, max: 2 }),
        time_start: timeStart,
        time_end: timeEnd,
        subject: readRequiredString(lesson.subject, `subject у занятия #${index + 1}`),
        room: readOptionalString(lesson.room, `room у занятия #${index + 1}`),
        type: readOptionalString(lesson.type, `type у занятия #${index + 1}`),
        teacher: readOptionalString(lesson.teacher, `teacher у занятия #${index + 1}`),
        week_type: weekType,
        sort_order: lesson.sort_order === undefined ? undefined : readInteger(lesson.sort_order, `sort_order у занятия #${index + 1}`, { min: 0 })
    };
}

function readOptionalIsoDate(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw createValidationError(`${label} должно быть строкой`);
    if (!isValidIsoDate(value.trim())) throw createValidationError(`${label} должно быть датой в формате YYYY-MM-DD`);
    return value.trim();
}

function validateScheduleUploadBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (!Array.isArray(body.lessons)) {
        throw createValidationError('Поле lessons должно быть массивом');
    }

    return {
        university: readOptionalString(body.university, 'Университет', 120),
        group: readRequiredString(body.group, 'Группа', 120),
        lessons: body.lessons.map((lesson, index) => validateLessonEntry(lesson, index)),
        target_week: parseTargetWeek(body.target_week),
        reference_date: readOptionalIsoDate(body.reference_date, 'reference_date')
    };
}

function validateBulkScheduleUploadBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (!Array.isArray(body.groups)) {
        throw createValidationError('Поле groups должно быть массивом');
    }

    if (body.groups.length === 0) {
        throw createValidationError('Поле groups не должно быть пустым');
    }

    if (body.groups.length > 100) {
        throw createValidationError('Слишком много групп (максимум 100)');
    }

    const groups = body.groups.map((entry, index) => {
        assertPlainObject(entry, `Группа #${index + 1} должна быть объектом`);

        const group = readRequiredString(entry.group, `group у группы #${index + 1}`, 120);

        if (!Array.isArray(entry.lessons)) {
            throw createValidationError(`Поле lessons у группы #${index + 1} (${group}) должно быть массивом`);
        }

        return {
            university: readOptionalString(entry.university, 'Университет', 120),
            group,
            lessons: entry.lessons.map((lesson, lessonIndex) =>
                validateLessonEntry(lesson, lessonIndex, ` (группа ${group})`)
            )
        };
    });

    return {
        groups,
        target_week: parseTargetWeek(body.target_week),
        reference_date: readOptionalIsoDate(body.reference_date, 'reference_date')
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
        payload.lesson_type = readOptionalString(body.lesson_type, 'Тип занятия');
    }

    if (body.teacher !== undefined) {
        payload.teacher = readOptionalString(body.teacher, 'Преподаватель');
    }

    if (body.sort_order !== undefined) {
        payload.sort_order = readInteger(body.sort_order, 'Порядок сортировки', { min: 0 });
    }

    return payload;
}

function validateMaterializeWeekBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (!['upsert', 'remove'].includes(body.action)) {
        throw createValidationError('Поле action должно быть upsert или remove');
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
        result.lesson_type = readOptionalString(body.lesson_type, 'Тип занятия');
        result.teacher = readOptionalString(body.teacher, 'Преподаватель');
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
        lesson_type: readOptionalString(body.lesson_type, 'Тип занятия'),
        teacher: readOptionalString(body.teacher, 'Преподаватель'),
        kind: readLessonKind(body.kind),
        sort_order: body.sort_order === undefined ? 0 : readInteger(body.sort_order, 'Порядок сортировки', { min: 0 })
    };
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

    const allowedKeys = ['semester_start_date', 'director_name', 'director_title', 'academic_year', 'study_form', 'term_parity'];
    const bodyKeys = Object.keys(body);

    for (const key of bodyKeys) {
        if (!allowedKeys.includes(key)) {
            throw createValidationError(`Неизвестная настройка: ${key}`);
        }
    }

    if (body.term_parity !== undefined && !['fall', 'spring'].includes(body.term_parity)) {
        throw createValidationError('term_parity должен быть fall или spring');
    }

    const semesterStartDate = readRequiredString(body.semester_start_date, 'Дата начала семестра', 10);

    if (!isValidIsoDate(semesterStartDate)) {
        throw createValidationError('Дата начала семестра должна быть в формате YYYY-MM-DD');
    }

    return {
        semester_start_date: mondayOfWeek(semesterStartDate),
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

        if (newPassword.length < 8) {
            throw createValidationError('Новый пароль должен быть не короче 8 символов');
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

    return {
        direction: readOptionalString(body.direction, 'Направление', 300)
    };
}

function validateGroupCreateBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    return {
        university_id: readInteger(body.university_id, 'university_id', { min: 1 }),
        name: readRequiredString(body.name, 'Название группы', 50),
        direction: readOptionalString(body.direction, 'Направление', 300)
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

const LOAD_PLAN_LESSON_TYPES = ['Лекция', 'Практика', 'Лаб', 'Консультация', 'Зачёт', 'Экзамен'];

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
        group_id: readInteger(body.group_id, 'group_id', { min: 1 }),
        subgroup: body.subgroup === undefined ? 0 : readInteger(body.subgroup, 'Подгруппа', { min: 0, max: 2 }),
        // Optional: a plan row can be auto-created (e.g. the moment a schedule
        // lesson references a teacher/discipline/type/group combo with no plan
        // row yet) before its hours are known — it then shows as "часы не
        // заданы" until the specialist fills them in.
        planned_hours: readOptionalPositiveInteger(body.planned_hours, 'Плановые часы'),
        entered_by: body.entered_by === 'teacher' ? 'teacher' : 'specialist'
    };
}

function readOptionalPositiveInteger(value, label) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    return readInteger(value, label, { min: 1, max: 2000 });
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

    if (body.group_id !== undefined) {
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

function validateLessonLoadPlanLinkBody(body) {
    assertPlainObject(body, 'Тело запроса должно быть объектом');

    if (body.load_plan_id === null) {
        return { load_plan_id: null };
    }

    return {
        load_plan_id: readInteger(body.load_plan_id, 'load_plan_id', { min: 1 })
    };
}

module.exports = {
    createValidationError,
    validateAccountUpdateBody,
    validateBulkScheduleUploadBody,
    validateDisciplineCreateBody,
    validateGroupCreateBody,
    validateGroupUpdateBody,
    validateLessonCreateBody,
    validateLessonLoadPlanLinkBody,
    validateLessonUpdateBody,
    validateLoadPlanCreateBody,
    validateLoadPlanUpdateBody,
    validateLoginBody,
    validateMaterializeWeekBody,
    validateMoveLessonBody,
    validateScheduleUploadBody,
    validateSemesterCreateBody,
    validateSemesterUpdateBody,
    validateSettingsBody,
    validateTeacherCreateBody
};
