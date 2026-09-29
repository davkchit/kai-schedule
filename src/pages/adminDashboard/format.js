// Formatting of audit-log entries and file sizes. Moved verbatim from
// AdminDashboardPage.jsx.

function formatAuditTimestamp(value) {
    if (!value) {
        return '—';
    }

    const parsed = new Date(value.replace(' ', 'T'));

    if (Number.isNaN(parsed.getTime())) {
        return value;
    }

    return parsed.toLocaleString('ru-RU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatAuditAction(action) {
    const labels = {
        'login.success': 'Успешный вход',
        'schedule.upload': 'Загрузка расписания',
        'schedule.materialize_week': 'Первая правка недели (скопирован шаблон)',
        'schedule.clear_week': 'Очистка недели (возврат к шаблону)',
        'group.create': 'Добавление группы',
        'group.update': 'Изменение направления группы',
        'lesson.create': 'Добавление занятия',
        'lesson.update': 'Редактирование занятия',
        'lesson.delete': 'Удаление занятия',
        'lesson.retire': 'Занятие убрано из шаблона',
        'lesson.move': 'Перенос занятия',
        'group.delete': 'Удаление группы',
        'semester.create': 'Создание семестра',
        'semester.update': 'Изменение семестра',
        'semester.close': 'Закрытие семестра',
        'semester.reopen': 'Семестр открыт заново',
        'teacher.create': 'Добавление преподавателя',
        'teacher.update': 'Переименование преподавателя',
        'teacher.delete': 'Удаление преподавателя',
        'discipline.create': 'Добавление дисциплины',
        'discipline.update': 'Переименование дисциплины',
        'discipline.delete': 'Удаление дисциплины',
        'load_plan.create': 'Добавление строки плана',
        'load_plan.update': 'Изменение строки плана',
        'load_plan.delete': 'Удаление строки плана',
        'admin.update_credentials': 'Смена логина или пароля',
        'settings.update': 'Изменение настройки',
        'backup.create': 'Создание резервной копии',
        'backup.restore': 'Восстановление базы из копии'
    };

    return labels[action] || action;
}

function formatAuditEntity(log) {
    if (!log.entity_type) {
        return '—';
    }

    return log.entity_id ? `${log.entity_type} #${log.entity_id}` : log.entity_type;
}

function formatAuditDetails(log) {
    const details = log.details;

    if (!details) {
        return '—';
    }

    if (log.action === 'schedule.upload') {
        return `${details.group || 'Группа'} · ${details.lesson_count || 0} занятий · ${details.target_week}`;
    }

    if (log.action === 'settings.update') {
        return `semester_start_date = ${details.semester_start_date}`;
    }

    if (log.action === 'lesson.delete') {
        return `${details.subject || '—'} · ${details.time_start || '—'}—${details.time_end || '—'}`;
    }

    if (log.action === 'lesson.update') {
        return `${details.after?.subject || details.before?.subject || '—'} · ${details.after?.time_start || details.before?.time_start || '—'}—${details.after?.time_end || details.before?.time_end || '—'}`;
    }

    if (log.action === 'backup.create') {
        return `${details.file_name || 'backup'} · ${formatBytes(details.size_bytes || 0)}`;
    }

    return JSON.stringify(details);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) {
        return `${bytes || 0} Б`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} КБ`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

export {
    formatAuditTimestamp,
    formatAuditAction,
    formatAuditEntity,
    formatAuditDetails,
    formatBytes
};
