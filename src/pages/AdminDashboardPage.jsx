import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import usePageAssets from '../hooks/usePageAssets';
import { formatLocalDateForApi, getSemesterWeekNumber, getWeekTypeNumber } from '../lib/date';
import { resolveTemplateLessons } from '../lib/templateResolve';
import AdminLoadSection from './AdminLoadSection';

const DAY_NAMES = {
    1: 'Пн',
    2: 'Вт',
    3: 'Ср',
    4: 'Чт',
    5: 'Пт',
    6: 'Сб'
};

DAY_NAMES[7] = '\u0412\u0441';


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
    subgroup: 0,
    week_type: 0,
    specific_week: ''
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

export default function AdminDashboardPage() {
    const isAssetsReady = usePageAssets({
        title: 'Панель администратора',
        description: 'Административная панель управления расписанием.',
        stylesheets: ['/css/admin-dashboard.css'],
        links: [
            { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
            { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
            { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap' }
        ]
    });

    const navigate = useNavigate();
    const [activeSection, setActiveSection] = useState('builder');
    const [groups, setGroups] = useState([]);
    const [universities, setUniversities] = useState([]);
    const [newGroupUniversityId, setNewGroupUniversityId] = useState('');
    const [newGroupName, setNewGroupName] = useState('');
    const [newGroupDirection, setNewGroupDirection] = useState('');
    const [isCreatingGroup, setIsCreatingGroup] = useState(false);
    const [selectedGroupId, setSelectedGroupId] = useState('');
    const [lessons, setLessons] = useState([]);
    const [semesterStartDate, setSemesterStartDate] = useState('');
    const [directorName, setDirectorName] = useState('');
    const [directorTitle, setDirectorTitle] = useState('Директор филиала');
    const [academicYear, setAcademicYear] = useState('');
    const [studyForm, setStudyForm] = useState('очная форма обучения');
    const [termParity, setTermParity] = useState('spring');
    const [isExporting, setIsExporting] = useState(false);
    const [groupDirectionDrafts, setGroupDirectionDrafts] = useState({});
    const [settingsStatus, setSettingsStatus] = useState({ type: '', message: '' });
    const [toastMessage, setToastMessage] = useState('');
    const [isToastVisible, setIsToastVisible] = useState(false);
    const [editForm, setEditForm] = useState(DEFAULT_EDIT_FORM);
    const [editMode, setEditMode] = useState('edit');
    const [editContext, setEditContext] = useState('direct');
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [builderMode, setBuilderMode] = useState('week');
    const [builderWeekStart, setBuilderWeekStart] = useState(() => getMondayOfWeek(new Date()));
    const [builderTemplateWeekType, setBuilderTemplateWeekType] = useState(1);
    const [draggedLesson, setDraggedLesson] = useState(null);
    const [dragOverCellKey, setDragOverCellKey] = useState(null);
    const [auditLogs, setAuditLogs] = useState([]);
    const [isAuditLogsLoading, setIsAuditLogsLoading] = useState(false);
    const [backups, setBackups] = useState([]);
    const [isBackupsLoading, setIsBackupsLoading] = useState(false);
    const [isCreatingBackup, setIsCreatingBackup] = useState(false);
    const [csrfToken, setCsrfToken] = useState('');

    useEffect(() => {
        let ignore = false;

        async function bootstrap() {
            try {
                const sessionResponse = await fetch('/api/admin/session');

                if (!sessionResponse.ok) {
                    navigate('/admin', { replace: true });
                    return;
                }

                const sessionData = await sessionResponse.json();

                if (ignore) {
                    return;
                }

                setCsrfToken(sessionData.csrf_token || '');

                await Promise.all([loadGroups(), loadUniversities(), loadSettings(), loadAuditLogs(), loadBackups()]);
            } catch {
                if (!ignore) {
                    navigate('/admin', { replace: true });
                }
            }
        }

        bootstrap();

        return () => {
            ignore = true;
        };
    }, [navigate]);

    useEffect(() => {
        if (!toastMessage) {
            return undefined;
        }

        setIsToastVisible(true);

        const timeout = window.setTimeout(() => {
            setIsToastVisible(false);
        }, 3000);

        return () => window.clearTimeout(timeout);
    }, [toastMessage]);

    useEffect(() => {
        if (!selectedGroupId) {
            setLessons([]);
            return;
        }

        loadLessons(selectedGroupId);
    }, [selectedGroupId]);


    function isUnsafeMethod(method = 'GET') {
        return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
    }

    async function getCsrfTokenForRequest() {
        if (csrfToken) {
            return csrfToken;
        }

        const sessionResponse = await fetch('/api/admin/session');

        if (sessionResponse.status === 401) {
            navigate('/admin', { replace: true });
            throw new Error('UNAUTHORIZED');
        }

        const sessionData = await sessionResponse.json();
        const nextToken = sessionData.csrf_token || '';

        setCsrfToken(nextToken);
        return nextToken;
    }

    async function api(path, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const headers = {
            ...(options.headers || {})
        };

        if (options.body !== undefined && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        if (isUnsafeMethod(method)) {
            const nextCsrfToken = await getCsrfTokenForRequest();

            if (nextCsrfToken) {
                headers['X-CSRF-Token'] = nextCsrfToken;
            }
        }

        const response = await fetch(path, {
            ...options,
            method,
            headers
        });

        if (response.status === 401) {
            navigate('/admin', { replace: true });
            throw new Error('UNAUTHORIZED');
        }

        return response;
    }

    async function loadGroups() {
        try {
            const response = await api('/api/admin/groups');
            const data = await response.json();
            setGroups(Array.isArray(data) ? data : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить группы');
            }
        }
    }

    async function loadUniversities() {
        try {
            const response = await fetch('/api/universities');
            const data = await response.json();
            setUniversities(Array.isArray(data) ? data : []);
        } catch {
            setUniversities([]);
        }
    }

    async function loadLessons(groupId) {
        try {
            const response = await api(`/api/admin/lessons?group_id=${groupId}`);
            const data = await response.json();
            setLessons(Array.isArray(data) ? data : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить занятия');
                setLessons([]);
            }
        }
    }

    async function loadSettings() {
        try {
            const response = await api('/api/admin/settings');
            const data = await response.json();

            if (data.semester_start_date) {
                setSemesterStartDate(data.semester_start_date);
            }

            if (data.director_name) setDirectorName(data.director_name);
            if (data.director_title) setDirectorTitle(data.director_title);
            if (data.academic_year) setAcademicYear(data.academic_year);
            if (data.study_form) setStudyForm(data.study_form);
            if (data.term_parity) setTermParity(data.term_parity);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить настройки');
            }
        }
    }

    async function loadAuditLogs() {
        setIsAuditLogsLoading(true);

        try {
            const response = await api('/api/admin/audit-logs?limit=100');
            const data = await response.json();
            setAuditLogs(Array.isArray(data) ? data : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить журнал действий');
                setAuditLogs([]);
            }
        } finally {
            setIsAuditLogsLoading(false);
        }
    }

    async function loadBackups() {
        setIsBackupsLoading(true);

        try {
            const response = await api('/api/admin/backups');
            const data = await response.json();
            setBackups(Array.isArray(data) ? data : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить резервные копии');
                setBackups([]);
            }
        } finally {
            setIsBackupsLoading(false);
        }
    }

    async function createBackup() {
        setIsCreatingBackup(true);

        try {
            const response = await api('/api/admin/backups', {
                method: 'POST'
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось создать резервную копию');
                return;
            }

            setToastMessage(`Резервная копия создана: ${data.backup.file_name}`);
            await loadBackups();
            await loadAuditLogs();
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        } finally {
            setIsCreatingBackup(false);
        }
    }

    async function logout() {
        try {
            await api('/api/admin/logout', { method: 'POST' });
        } finally {
            navigate('/admin', { replace: true });
        }
    }

    function openEditModal(lesson, context = 'direct') {
        setEditMode('edit');
        setEditContext(context);
        setEditForm({
            id: lesson.id,
            group_id: lesson.group_id,
            day_of_week: lesson.day_of_week,
            time_start: lesson.time_start,
            time_end: lesson.time_end,
            subject: lesson.subject,
            room: lesson.room || '',
            lesson_type: lesson.lesson_type || 'Лекция',
            teacher: lesson.teacher || '',
            subgroup: lesson.subgroup,
            week_type: lesson.week_type,
            specific_week: lesson.specific_week ?? ''
        });
        setIsEditModalOpen(true);
    }

    const builderWeekEnd = new Date(builderWeekStart);
    builderWeekEnd.setDate(builderWeekEnd.getDate() + 6);

    const builderWeekNumber = semesterStartDate
        ? getSemesterWeekNumber(semesterStartDate, builderWeekStart)
        : null;

    const todayWeekNumber = semesterStartDate
        ? getSemesterWeekNumber(semesterStartDate, new Date())
        : null;

    const builderWeekMaterialized = builderWeekNumber !== null
        && lessons.some((lesson) => lesson.specific_week === builderWeekNumber);

    function openCreateModal(day, timeStart, timeEnd, subgroup, context = 'direct') {
        if (!selectedGroupId) {
            setToastMessage('Сначала выберите группу');
            return;
        }

        const targetWeekNumber = context === 'template' ? todayWeekNumber : builderWeekNumber;

        if (targetWeekNumber === null) {
            setToastMessage('Сначала задайте дату начала семестра в разделе «Настройки»');
            return;
        }

        setEditMode('create');
        setEditContext(context);
        setEditForm({
            id: '',
            group_id: selectedGroupId,
            day_of_week: day,
            time_start: timeStart,
            time_end: timeEnd,
            subject: '',
            room: '',
            lesson_type: 'Лекция',
            teacher: '',
            subgroup,
            week_type: context === 'template' ? builderTemplateWeekType : 0,
            specific_week: context === 'template' ? '' : targetWeekNumber
        });
        setIsEditModalOpen(true);
    }

    function getBuilderCellLessons(day, timeStart, timeEnd) {
        if (builderWeekNumber === null) {
            return [];
        }

        if (builderWeekMaterialized) {
            return lessons.filter((lesson) =>
                lesson.day_of_week === day &&
                lesson.time_start === timeStart &&
                lesson.time_end === timeEnd &&
                lesson.specific_week === builderWeekNumber
            );
        }

        // Same parity the server and the student schedule use.
        const weekTypeNumber = getWeekTypeNumber(builderWeekStart);
        const candidates = lessons.filter((lesson) =>
            lesson.day_of_week === day &&
            lesson.time_start === timeStart &&
            lesson.time_end === timeEnd &&
            lesson.specific_week == null &&
            (lesson.week_type === 0 || lesson.week_type === weekTypeNumber)
        );

        return resolveTemplateLessons(candidates, builderWeekNumber);
    }

    function getTemplateCellLessons(day, timeStart, timeEnd) {
        if (todayWeekNumber === null) {
            return [];
        }

        // The tabs here are only Нечётная/Чётная, so an "every week" pair
        // (week_type 0, which bulk JSON upload can create with "all") matched
        // neither and was invisible in BOTH tabs — the cell looked free while
        // actually being occupied on every week, and a second pair created on
        // top of it meant two lessons in one slot for students and doubled
        // hours for the teacher. It overlaps both parities, so show it in both.
        const candidates = lessons.filter((lesson) =>
            lesson.day_of_week === day &&
            lesson.time_start === timeStart &&
            lesson.time_end === timeEnd &&
            lesson.specific_week == null &&
            (lesson.week_type === builderTemplateWeekType || lesson.week_type === 0)
        );

        return resolveTemplateLessons(candidates, todayWeekNumber);
    }

    function renderGridCell(day, timeStart, timeEnd, cellLessons, context) {
        const full = cellLessons.find((lesson) => lesson.subgroup === 0);

        if (full) {
            return (
                <button
                    type="button"
                    className={`builder-lesson-card ${draggedLesson?.id === full.id ? 'is-dragging' : ''}`}
                    onClick={() => openEditModal(full, context)}
                    draggable
                    onDragStart={() => setDraggedLesson(full)}
                    onDragEnd={() => {
                        setDraggedLesson(null);
                        setDragOverCellKey(null);
                    }}
                >
                    <span className="builder-lesson-subject">{full.subject}</span>
                    <span className="builder-lesson-meta">
                        {full.lesson_type && <span>{full.lesson_type}</span>}
                        {full.room && <span className="builder-lesson-room">{full.room}</span>}
                    </span>
                    {full.teacher && <span className="builder-lesson-teacher" title={full.teacher}>{full.teacher}</span>}
                </button>
            );
        }

        const sub1 = cellLessons.find((lesson) => lesson.subgroup === 1);
        const sub2 = cellLessons.find((lesson) => lesson.subgroup === 2);

        if (sub1 || sub2) {
            return (
                <div className="builder-cell-split">
                    {sub1 ? (
                        <button
                            type="button"
                            className={`builder-lesson-card half ${draggedLesson?.id === sub1.id ? 'is-dragging' : ''}`}
                            onClick={() => openEditModal(sub1, context)}
                            draggable
                            onDragStart={() => setDraggedLesson(sub1)}
                            onDragEnd={() => {
                                setDraggedLesson(null);
                                setDragOverCellKey(null);
                            }}
                        >
                            <span className="builder-lesson-subgroup-tag">1 п/г</span>
                            <span className="builder-lesson-subject">{sub1.subject}</span>
                            {sub1.room && <span className="builder-lesson-room">{sub1.room}</span>}
                            {sub1.teacher && <span className="builder-lesson-teacher" title={sub1.teacher}>{sub1.teacher}</span>}
                        </button>
                    ) : (
                        <button type="button" className="builder-add-btn half" onClick={() => openCreateModal(day, timeStart, timeEnd, 1, context)}>+</button>
                    )}
                    {sub2 ? (
                        <button
                            type="button"
                            className={`builder-lesson-card half ${draggedLesson?.id === sub2.id ? 'is-dragging' : ''}`}
                            onClick={() => openEditModal(sub2, context)}
                            draggable
                            onDragStart={() => setDraggedLesson(sub2)}
                            onDragEnd={() => {
                                setDraggedLesson(null);
                                setDragOverCellKey(null);
                            }}
                        >
                            <span className="builder-lesson-subgroup-tag">2 п/г</span>
                            <span className="builder-lesson-subject">{sub2.subject}</span>
                            {sub2.room && <span className="builder-lesson-room">{sub2.room}</span>}
                            {sub2.teacher && <span className="builder-lesson-teacher" title={sub2.teacher}>{sub2.teacher}</span>}
                        </button>
                    ) : (
                        <button type="button" className="builder-add-btn half" onClick={() => openCreateModal(day, timeStart, timeEnd, 2, context)}>+</button>
                    )}
                </div>
            );
        }

        return (
            <button type="button" className="builder-add-btn" onClick={() => openCreateModal(day, timeStart, timeEnd, 0, context)}>+</button>
        );
    }

    // Drag-and-drop moves a lesson to another slot. It deliberately calls the
    // dedicated move endpoint rather than doing a delete+create from here: the
    // server does both halves in one transaction, so a failed move can't leave
    // the lesson missing from both slots.
    async function handleDropOnCell(day, timeStart, timeEnd) {
        const lesson = draggedLesson;

        setDraggedLesson(null);
        setDragOverCellKey(null);

        if (!lesson) {
            return;
        }

        const isSameSlot =
            lesson.day_of_week === day &&
            lesson.time_start === timeStart &&
            lesson.time_end === timeEnd;

        if (isSameSlot) {
            return;
        }

        if (builderMode === 'week' && builderWeekNumber === null) {
            setToastMessage('Сначала выберите неделю');
            return;
        }

        try {
            const response = await api('/api/admin/schedule/move-lesson', {
                method: 'POST',
                body: JSON.stringify({
                    lesson_id: lesson.id,
                    mode: builderMode === 'template' ? 'template' : 'week',
                    week_number: builderMode === 'template' ? undefined : builderWeekNumber,
                    day_of_week: day,
                    time_start: timeStart,
                    time_end: timeEnd
                })
            });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось перенести занятие');
                return;
            }

            setToastMessage(
                builderMode === 'template'
                    ? 'Пара перенесена — с этой недели и далее'
                    : 'Пара перенесена на этой неделе'
            );
            loadLessons(selectedGroupId);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    function cellKey(day, timeStart, timeEnd) {
        return `${day}|${timeStart}|${timeEnd}`;
    }

    function renderBuilderCell(day, timeStart, timeEnd) {
        const context = builderWeekMaterialized ? 'direct' : 'materialize';
        return renderGridCell(day, timeStart, timeEnd, getBuilderCellLessons(day, timeStart, timeEnd), context);
    }

    function renderTemplateCell(day, timeStart, timeEnd) {
        return renderGridCell(day, timeStart, timeEnd, getTemplateCellLessons(day, timeStart, timeEnd), 'template');
    }

    async function deleteLesson(lessonId) {
        const shouldDelete = window.confirm('Удалить это занятие?');

        if (!shouldDelete) {
            return false;
        }

        try {
            const response = await api(`/api/admin/lessons/${lessonId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось удалить занятие');
                return false;
            }

            // A template pair that has already run in earlier weeks is retired
            // from this week forward rather than erased, so those weeks keep
            // showing it — and the teacher keeps the hours already taught.
            const data = await response.json();
            setToastMessage(
                data.retired_from_week
                    ? `Занятие убрано с ${data.retired_from_week}-й недели — прошедшие недели не изменились`
                    : 'Занятие удалено'
            );
            loadLessons(selectedGroupId);
            return true;
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
            return false;
        }
    }

    async function handleDeleteFromModal() {
        if (editContext === 'template') {
            const shouldRemove = window.confirm(
                'Убрать это занятие из шаблона начиная с текущей недели? Прошлые недели не изменятся.'
            );

            if (!shouldRemove) {
                return;
            }

            try {
                const response = await api('/api/admin/lessons', {
                    method: 'POST',
                    body: JSON.stringify({
                        group_id: Number(editForm.group_id),
                        day_of_week: Number(editForm.day_of_week),
                        time_start: editForm.time_start,
                        time_end: editForm.time_end,
                        subject: editForm.subject,
                        room: editForm.room,
                        lesson_type: editForm.lesson_type,
                        subgroup: Number(editForm.subgroup),
                        week_type: Number(editForm.week_type),
                        specific_week: null,
                        is_removed: true
                    })
                });

                if (!response.ok) {
                    const data = await response.json();
                    setToastMessage(data.error || 'Не удалось убрать занятие из шаблона');
                    return;
                }

                setToastMessage('Занятие убрано из шаблона начиная с этой недели');
                setIsEditModalOpen(false);
                setEditForm(DEFAULT_EDIT_FORM);
                loadLessons(selectedGroupId);
            } catch (error) {
                if (error.message !== 'UNAUTHORIZED') {
                    setToastMessage('Ошибка сети');
                }
            }

            return;
        }

        if (editContext === 'materialize') {
            const shouldRemove = window.confirm(
                'Убрать эту пару из недели? Остальные пары шаблона будут сохранены для этой недели как есть.'
            );

            if (!shouldRemove) {
                return;
            }

            try {
                const response = await api('/api/admin/schedule/materialize-week', {
                    method: 'POST',
                    body: JSON.stringify({
                        group_id: Number(editForm.group_id),
                        week_number: builderWeekNumber,
                        action: 'remove',
                        day_of_week: Number(editForm.day_of_week),
                        time_start: editForm.time_start,
                        time_end: editForm.time_end,
                        subgroup: Number(editForm.subgroup)
                    })
                });

                if (!response.ok) {
                    const data = await response.json();
                    setToastMessage(data.error || 'Не удалось убрать пару');
                    return;
                }

                setToastMessage('Пара убрана из этой недели');
                setIsEditModalOpen(false);
                setEditForm(DEFAULT_EDIT_FORM);
                loadLessons(selectedGroupId);
            } catch (error) {
                if (error.message !== 'UNAUTHORIZED') {
                    setToastMessage('Ошибка сети');
                }
            }

            return;
        }

        const deleted = await deleteLesson(editForm.id);

        if (deleted) {
            setIsEditModalOpen(false);
            setEditForm(DEFAULT_EDIT_FORM);
        }
    }

    async function handleEditSubmit(event) {
        event.preventDefault();

        const body = {
            day_of_week: Number(editForm.day_of_week),
            time_start: editForm.time_start,
            time_end: editForm.time_end,
            subject: editForm.subject,
            room: editForm.room,
            lesson_type: editForm.lesson_type,
            teacher: editForm.teacher,
            subgroup: Number(editForm.subgroup),
            week_type: Number(editForm.week_type),
            specific_week: editForm.specific_week
        };

        try {
            let response;

            if (editContext === 'template') {
                // Template edits are always inserted as a new version — existing rows
                // (and therefore past weeks that resolved to them) are never mutated.
                response = await api('/api/admin/lessons', {
                    method: 'POST',
                    body: JSON.stringify({
                        ...body,
                        group_id: Number(editForm.group_id),
                        specific_week: null
                    })
                });
            } else if (editContext === 'materialize') {
                // First real change to a still-template-driven week: clone the rest of
                // that week's resolved template into real rows in the same transaction,
                // so the untouched pairs don't silently vanish (override replaces the
                // whole week, it never merges with the template).
                response = await api('/api/admin/schedule/materialize-week', {
                    method: 'POST',
                    body: JSON.stringify({
                        group_id: Number(editForm.group_id),
                        week_number: builderWeekNumber,
                        action: 'upsert',
                        day_of_week: Number(editForm.day_of_week),
                        time_start: editForm.time_start,
                        time_end: editForm.time_end,
                        subgroup: Number(editForm.subgroup),
                        subject: editForm.subject,
                        room: editForm.room,
                        lesson_type: editForm.lesson_type,
                        teacher: editForm.teacher
                    })
                });
            } else if (editMode === 'create') {
                response = await api('/api/admin/lessons', {
                    method: 'POST',
                    body: JSON.stringify({ ...body, group_id: Number(editForm.group_id) })
                });
            } else {
                response = await api(`/api/admin/lessons/${editForm.id}`, {
                    method: 'PUT',
                    body: JSON.stringify(body)
                });
            }

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || (editMode === 'create' ? 'Не удалось добавить занятие' : 'Не удалось обновить занятие'));
                return;
            }

            setIsEditModalOpen(false);
            setEditForm(DEFAULT_EDIT_FORM);
            setToastMessage(editMode === 'create' ? 'Занятие добавлено' : 'Занятие обновлено');
            loadLessons(selectedGroupId);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function handleClearWeek() {
        if (!selectedGroupId || builderWeekNumber === null) {
            return;
        }

        const shouldClear = window.confirm(
            'Стереть все правки этой недели и вернуться к шаблону? Действие необратимо.'
        );

        if (!shouldClear) {
            return;
        }

        try {
            const response = await api(
                `/api/admin/schedule/week?group_id=${selectedGroupId}&week_number=${builderWeekNumber}`,
                { method: 'DELETE' }
            );

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось очистить неделю');
                return;
            }

            setToastMessage('Неделя очищена — показывается шаблон');
            loadLessons(selectedGroupId);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function handleExport() {
        setIsExporting(true);

        try {
            const params = new URLSearchParams({
                week_start: formatLocalDateForApi(builderWeekStart)
            });

            const response = await api(`/api/admin/schedule/export?${params.toString()}`);

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось сформировать файл расписания');
                return;
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `raspisanie_${formatLocalDateForApi(builderWeekStart)}.xlsx`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        } finally {
            setIsExporting(false);
        }
    }

    async function handleCreateGroup() {
        if (!newGroupUniversityId) {
            setToastMessage('Выберите вуз');
            return;
        }

        if (!newGroupName.trim()) {
            setToastMessage('Введите номер группы');
            return;
        }

        setIsCreatingGroup(true);

        try {
            const response = await api('/api/admin/groups', {
                method: 'POST',
                body: JSON.stringify({
                    university_id: Number(newGroupUniversityId),
                    name: newGroupName.trim(),
                    direction: newGroupDirection.trim()
                })
            });

            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось добавить группу');
                return;
            }

            setGroups((previous) => [...previous, data].sort((a, b) => a.name.localeCompare(b.name)));
            setToastMessage(`Группа ${data.name} добавлена`);
            setNewGroupName('');
            setNewGroupDirection('');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        } finally {
            setIsCreatingGroup(false);
        }
    }

    async function handleSaveGroupDirection(groupId) {
        const direction = groupDirectionDrafts[groupId] ?? '';

        try {
            const response = await api(`/api/admin/groups/${groupId}`, {
                method: 'PUT',
                body: JSON.stringify({ direction })
            });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось сохранить направление');
                return;
            }

            const updated = await response.json();
            setGroups((previous) => previous.map((group) => (group.id === groupId ? updated : group)));
            setToastMessage('Направление сохранено');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function saveSettings() {
        try {
            const response = await api('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    semester_start_date: semesterStartDate,
                    director_name: directorName,
                    director_title: directorTitle,
                    academic_year: academicYear,
                    study_form: studyForm,
                    term_parity: termParity
                })
            });

            if (!response.ok) {
                const data = await response.json();
                setSettingsStatus({ type: 'error', message: data.error || 'Ошибка' });
                return;
            }

            setSettingsStatus({ type: 'success', message: 'Сохранено' });
            setToastMessage('Настройки сохранены');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setSettingsStatus({ type: 'error', message: 'Ошибка' });
            }
        }
    }

    if (!isAssetsReady) {
        return null;
    }

    return (
        <div className="dashboard">
            <aside className="sidebar">
                <div className="sidebar-header">
                    <img src="/assets/logo.png" alt="Логотип КАИ" width="108" height="45" />
                    <span className="sidebar-title">КАИ Расписание</span>
                </div>
                <nav className="sidebar-nav">
                    <button className={`nav-item ${activeSection === 'builder' ? 'active' : ''}`} data-section="builder" id="navBuilder" onClick={() => setActiveSection('builder')}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="3" y1="15" x2="21" y2="15" />
                            <line x1="9" y1="9" x2="9" y2="21" />
                            <line x1="15" y1="9" x2="15" y2="21" />
                        </svg>
                        Конструктор
                    </button>
                    <button className={`nav-item ${activeSection === 'settings' ? 'active' : ''}`} data-section="settings" id="navSettings" onClick={() => setActiveSection('settings')}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                        </svg>
                        Настройки
                    </button>
                    <button
                        className={`nav-item ${activeSection === 'load' ? 'active' : ''}`}
                        data-section="load"
                        id="navLoad"
                        onClick={() => setActiveSection('load')}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 20V10" />
                            <path d="M18 20V4" />
                            <path d="M6 20v-4" />
                        </svg>
                        Нагрузка
                    </button>
                    <button
                        className={`nav-item ${activeSection === 'backup' ? 'active' : ''}`}
                        data-section="backup"
                        id="navBackup"
                        onClick={() => {
                            setActiveSection('backup');

                            if (backups.length === 0) {
                                loadBackups();
                            }
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 8v13H3V8" />
                            <path d="M1 3h22v5H1z" />
                            <path d="M10 12h4" />
                        </svg>
                        Резервные копии
                    </button>
                    <button
                        className={`nav-item ${activeSection === 'audit' ? 'active' : ''}`}
                        data-section="audit"
                        id="navAudit"
                        onClick={() => {
                            setActiveSection('audit');

                            if (auditLogs.length === 0) {
                                loadAuditLogs();
                            }
                        }}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 8v4l3 3" />
                            <circle cx="12" cy="12" r="9" />
                        </svg>
                        Журнал
                    </button>
                </nav>
                <button className="nav-item logout-btn" id="logoutBtn" onClick={logout}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    Выйти
                </button>
            </aside>

            <main className="main-content">
                <section className={`content-section ${activeSection === 'builder' ? 'active' : ''}`} id="sectionBuilder">
                    <h2 className="section-title">Конструктор расписания</h2>
                    <p className="section-desc">Добавляйте и редактируйте занятия прямо на сетке недели — так они лягут и в само расписание.</p>

                    <div className="builder-toolbar">
                        <select
                            className="group-select"
                            value={selectedGroupId}
                            onChange={(event) => setSelectedGroupId(event.target.value)}
                        >
                            <option value="">Выберите группу</option>
                            {groups.map((group) => (
                                <option key={group.id} value={group.id}>
                                    {group.university} — {group.name}
                                </option>
                            ))}
                        </select>

                        <div className="builder-tabs">
                            <button type="button" className={`builder-tab ${builderMode === 'week' ? 'active' : ''}`} onClick={() => setBuilderMode('week')}>По неделям</button>
                            <button type="button" className={`builder-tab ${builderMode === 'template' ? 'active' : ''}`} onClick={() => setBuilderMode('template')}>Шаблон</button>
                        </div>

                        {builderMode === 'week' ? (
                            <div className="builder-week-nav">
                                <button
                                    type="button"
                                    className="week-nav-btn"
                                    onClick={() => setBuilderWeekStart((start) => {
                                        const prev = new Date(start);
                                        prev.setDate(prev.getDate() - 7);
                                        return prev;
                                    })}
                                    aria-label="Предыдущая неделя"
                                >
                                    ‹
                                </button>
                                <div className="builder-week-current">
                                    {formatDayMonth(builderWeekStart)}
                                    {' – '}
                                    {formatDayMonth(builderWeekEnd)}.{builderWeekEnd.getFullYear()}
                                </div>
                                <button
                                    type="button"
                                    className="week-nav-btn"
                                    onClick={() => setBuilderWeekStart((start) => {
                                        const next = new Date(start);
                                        next.setDate(next.getDate() + 7);
                                        return next;
                                    })}
                                    aria-label="Следующая неделя"
                                >
                                    ›
                                </button>
                            </div>
                        ) : (
                            <div className="builder-tabs">
                                <button type="button" className={`builder-tab ${builderTemplateWeekType === 1 ? 'active' : ''}`} onClick={() => setBuilderTemplateWeekType(1)}>Нечётная</button>
                                <button type="button" className={`builder-tab ${builderTemplateWeekType === 2 ? 'active' : ''}`} onClick={() => setBuilderTemplateWeekType(2)}>Чётная</button>
                            </div>
                        )}
                    </div>

                    {builderMode === 'week' && builderWeekNumber !== null && (
                        <div className="builder-export-row">
                            {selectedGroupId && builderWeekMaterialized && (
                                <button type="button" className="btn btn-delete" onClick={handleClearWeek}>
                                    Очистить и вернуть к шаблону
                                </button>
                            )}
                            <button type="button" className="btn btn-secondary" onClick={handleExport} disabled={isExporting}>
                                {isExporting ? 'Формирование...' : 'Скачать расписание всех курсов (.xlsx)'}
                            </button>
                        </div>
                    )}

                    {builderMode === 'week' && selectedGroupId && builderWeekNumber !== null && !builderWeekMaterialized && (
                        <p className="builder-hint">
                            Сейчас показан шаблон для этой недели. Любое изменение сохранит всю неделю как отдельную копию — прошлые и другие недели не затронет.
                        </p>
                    )}

                    {builderMode === 'template' && (
                        <p className="builder-hint">
                            Изменения в шаблоне вступают в силу с текущей недели. Уже прошедшие недели останутся такими, какими были показаны.
                        </p>
                    )}

                    {!selectedGroupId ? (
                        <p className="empty-message">Выберите группу, чтобы начать редактирование</p>
                    ) : builderMode === 'week' && builderWeekNumber === null ? (
                        <p className="empty-message">Задайте дату начала семестра в разделе «Настройки», чтобы редактировать расписание по неделям</p>
                    ) : builderMode === 'template' && todayWeekNumber === null ? (
                        <p className="empty-message">Задайте дату начала семестра в разделе «Настройки», чтобы редактировать шаблон</p>
                    ) : (
                        <div className="builder-grid-wrapper">
                            <div className="builder-grid">
                                <div className="builder-row builder-header-row">
                                    <div className="builder-slot-label"></div>
                                    <div className="builder-row-cells">
                                        {BUILDER_DAYS.map((day) => (
                                            <div className="builder-day-header" key={day}>{DAY_NAMES[day]}</div>
                                        ))}
                                    </div>
                                </div>
                                {BUILDER_TIME_SLOTS.map(([start, end]) => (
                                    <div className="builder-row" key={`${start}-${end}`}>
                                        <div className="builder-slot-label">{start}–{end}</div>
                                        <div className="builder-row-cells">
                                            {BUILDER_DAYS.map((day) => (
                                                <div
                                                    className={`builder-cell ${
                                                        draggedLesson ? 'is-drop-target' : ''
                                                    } ${
                                                        dragOverCellKey === cellKey(day, start, end) ? 'is-drag-over' : ''
                                                    }`}
                                                    key={day}
                                                    onDragOver={(event) => {
                                                        if (!draggedLesson) {
                                                            return;
                                                        }

                                                        event.preventDefault();
                                                        setDragOverCellKey(cellKey(day, start, end));
                                                    }}
                                                    onDragLeave={() => {
                                                        setDragOverCellKey((previous) =>
                                                            previous === cellKey(day, start, end) ? null : previous
                                                        );
                                                    }}
                                                    onDrop={(event) => {
                                                        event.preventDefault();
                                                        handleDropOnCell(day, start, end);
                                                    }}
                                                >
                                                    {builderMode === 'week'
                                                        ? renderBuilderCell(day, start, end)
                                                        : renderTemplateCell(day, start, end)}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </section>

                <section className={`content-section ${activeSection === 'load' ? 'active' : ''}`} id="sectionLoad">
                    {activeSection === 'load' && (
                        <AdminLoadSection api={api} groups={groups} setToastMessage={setToastMessage} />
                    )}
                </section>

                <section className={`content-section ${activeSection === 'settings' ? 'active' : ''}`} id="sectionSettings">
                    <h2 className="section-title">Настройки</h2>
                    <div className="settings-form">
                        <div className="setting-row">
                            <label htmlFor="semesterStart">Дата начала семестра</label>
                            <p className="setting-hint">Используется для расчёта чётной/нечётной недели</p>
                            <input
                                type="date"
                                id="semesterStart"
                                className="setting-input"
                                value={semesterStartDate}
                                onChange={(event) => setSemesterStartDate(event.target.value)}
                            />
                        </div>
                        <div className="setting-row">
                            <label htmlFor="termParity">Текущий семестр (осенний/весенний)</label>
                            <p className="setting-hint">Вместе с курсом группы определяет номер семестра в шапке экспорта (I/III/V/VII — осенний, II/IV/VI/VIII — весенний)</p>
                            <select
                                id="termParity"
                                className="setting-input"
                                value={termParity}
                                onChange={(event) => setTermParity(event.target.value)}
                            >
                                <option value="spring">Весенний</option>
                                <option value="fall">Осенний</option>
                            </select>
                        </div>
                        <div className="setting-row">
                            <label htmlFor="academicYear">Учебный год</label>
                            <p className="setting-hint">Используется в шапке при экспорте в Excel, например «2025/2026»</p>
                            <input
                                type="text"
                                id="academicYear"
                                className="setting-input"
                                placeholder="2025/2026"
                                value={academicYear}
                                onChange={(event) => setAcademicYear(event.target.value)}
                            />
                        </div>
                        <div className="setting-row">
                            <label htmlFor="studyForm">Форма обучения</label>
                            <input
                                type="text"
                                id="studyForm"
                                className="setting-input"
                                placeholder="очная форма обучения"
                                value={studyForm}
                                onChange={(event) => setStudyForm(event.target.value)}
                            />
                        </div>
                        <div className="setting-row">
                            <label htmlFor="directorTitle">Должность подписанта</label>
                            <input
                                type="text"
                                id="directorTitle"
                                className="setting-input"
                                placeholder="Директор филиала"
                                value={directorTitle}
                                onChange={(event) => setDirectorTitle(event.target.value)}
                            />
                        </div>
                        <div className="setting-row">
                            <label htmlFor="directorName">ФИО подписанта</label>
                            <p className="setting-hint">Появляется в шапке экспортированного расписания рядом со строкой подписи</p>
                            <input
                                type="text"
                                id="directorName"
                                className="setting-input"
                                placeholder="А.Ф. Мустафин"
                                value={directorName}
                                onChange={(event) => setDirectorName(event.target.value)}
                            />
                        </div>
                        <button className="btn btn-primary" id="saveSettingsBtn" onClick={saveSettings}>
                            Сохранить настройки
                        </button>
                        <span className={`upload-status ${settingsStatus.type}`} id="settingsStatus">
                            {settingsStatus.message}
                        </span>
                    </div>

                    <h3 className="subsection-title">Группы и направления</h3>
                    <p className="section-desc">Курс определяется автоматически по номеру группы (23<strong>1</strong>01 — 1 курс). Направление появляется в шапке при экспорте расписания.</p>

                    <div className="add-group-row">
                        <select
                            className="form-input"
                            value={newGroupUniversityId}
                            onChange={(event) => setNewGroupUniversityId(event.target.value)}
                        >
                            <option value="">Вуз</option>
                            {universities.map((university) => (
                                <option key={university.id} value={university.id}>{university.short_name}</option>
                            ))}
                        </select>
                        <input
                            type="text"
                            className="form-input"
                            placeholder="Номер группы, например 23101"
                            value={newGroupName}
                            onChange={(event) => setNewGroupName(event.target.value)}
                        />
                        <input
                            type="text"
                            className="form-input"
                            placeholder="Направление (необязательно)"
                            value={newGroupDirection}
                            onChange={(event) => setNewGroupDirection(event.target.value)}
                        />
                        <button type="button" className="btn btn-primary" onClick={handleCreateGroup} disabled={isCreatingGroup}>
                            {isCreatingGroup ? 'Добавление...' : 'Добавить группу'}
                        </button>
                    </div>

                    <div className="lessons-table-wrapper">
                        <table className="lessons-table">
                            <thead>
                                <tr>
                                    <th>Университет</th>
                                    <th>Группа</th>
                                    <th>Курс</th>
                                    <th>Направление</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {groups.map((group) => {
                                    const course = getCourseFromGroupName(group.name);
                                    const draft = groupDirectionDrafts[group.id] ?? group.direction ?? '';

                                    return (
                                        <tr key={group.id}>
                                            <td>{group.university}</td>
                                            <td><strong>{group.name}</strong></td>
                                            <td>{course ?? '—'}</td>
                                            <td>
                                                <input
                                                    type="text"
                                                    className="form-input"
                                                    placeholder="09.03.01 Информатика и вычислительная техника"
                                                    value={draft}
                                                    onChange={(event) => setGroupDirectionDrafts((previous) => ({
                                                        ...previous,
                                                        [group.id]: event.target.value
                                                    }))}
                                                />
                                            </td>
                                            <td>
                                                <button className="btn-edit" onClick={() => handleSaveGroupDirection(group.id)}>
                                                    Сохранить
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {groups.length === 0 && (
                            <p className="empty-message">Групп пока нет</p>
                        )}
                    </div>
                </section>

                <section className={`content-section ${activeSection === 'backup' ? 'active' : ''}`} id="sectionBackup">
                    <div className="audit-header">
                        <div>
                            <h2 className="section-title">Резервные копии</h2>
                            <p className="section-desc">Ручное создание и скачивание backup-файлов SQLite перед опасными изменениями.</p>
                        </div>
                        <div className="section-actions">
                            <button className="btn btn-secondary" onClick={loadBackups}>
                                Обновить список
                            </button>
                            <button className="btn btn-primary" onClick={createBackup} disabled={isCreatingBackup}>
                                {isCreatingBackup ? 'Создание...' : 'Создать backup'}
                            </button>
                        </div>
                    </div>
                    <div className="lessons-table-wrapper audit-table-wrapper">
                        <table className="lessons-table audit-table">
                            <thead>
                                <tr>
                                    <th>Файл</th>
                                    <th>Создан</th>
                                    <th>Размер</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {backups.map((backup) => (
                                    <tr key={backup.file_name}>
                                        <td><strong>{backup.file_name}</strong></td>
                                        <td>{formatAuditTimestamp(backup.created_at)}</td>
                                        <td>{formatBytes(backup.size_bytes)}</td>
                                        <td>
                                            <a className="btn-link" href={`/api/admin/backups/${encodeURIComponent(backup.file_name)}/download`}>
                                                Скачать
                                            </a>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p className="empty-message" style={{ display: backups.length === 0 ? '' : 'none' }}>
                            {isBackupsLoading ? 'Загрузка резервных копий...' : 'Резервных копий пока нет'}
                        </p>
                    </div>
                </section>

                <section className={`content-section ${activeSection === 'audit' ? 'active' : ''}`} id="sectionAudit">
                    <div className="audit-header">
                        <div>
                            <h2 className="section-title">Журнал действий</h2>
                            <p className="section-desc">История изменений расписания и важных действий администратора.</p>
                        </div>
                        <div className="section-actions">
                            <a className="btn btn-secondary" href="/api/admin/audit-logs/export?limit=1000">
                                Экспорт CSV
                            </a>
                            <button className="btn btn-secondary" onClick={loadAuditLogs}>
                                Обновить журнал
                            </button>
                        </div>
                    </div>
                    <div className="lessons-table-wrapper audit-table-wrapper">
                        <table className="lessons-table audit-table">
                            <thead>
                                <tr>
                                    <th>Время</th>
                                    <th>Админ</th>
                                    <th>Действие</th>
                                    <th>Сущность</th>
                                    <th>IP</th>
                                    <th>Детали</th>
                                </tr>
                            </thead>
                            <tbody>
                                {auditLogs.map((log) => (
                                    <tr key={log.id}>
                                        <td>{formatAuditTimestamp(log.created_at)}</td>
                                        <td>{log.admin_username || '—'}</td>
                                        <td><strong>{formatAuditAction(log.action)}</strong></td>
                                        <td>{formatAuditEntity(log)}</td>
                                        <td>{log.ip_address || '—'}</td>
                                        <td className="audit-details-cell">{formatAuditDetails(log)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <p className="empty-message" style={{ display: auditLogs.length === 0 ? '' : 'none' }}>
                            {isAuditLogsLoading ? 'Загрузка журнала...' : 'Журнал пока пуст'}
                        </p>
                    </div>
                </section>
            </main>

            <div
                className={`modal-overlay ${isEditModalOpen ? 'active' : ''}`}
                id="editModal"
                aria-hidden={!isEditModalOpen}
                onClick={(event) => {
                    if (event.target.id === 'editModal') {
                        setIsEditModalOpen(false);
                    }
                }}
            >
                <div className="modal-card">
                    <h3 className="modal-title">
                        {editMode === 'create'
                            ? (editContext === 'template' ? 'Добавить в шаблон' : 'Добавить занятие')
                            : 'Редактировать занятие'}
                    </h3>
                    {editContext === 'template' && (
                        <p className="modal-hint">Сохранится как новая версия с текущей недели — прошлые недели не изменятся.</p>
                    )}
                    <form id="editForm" className="edit-form" onSubmit={handleEditSubmit}>
                        <input type="hidden" id="editId" value={editForm.id} readOnly />
                        <div className="form-row">
                            <label>День недели</label>
                            <select
                                id="editDay"
                                className="form-input"
                                value={editForm.day_of_week}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, day_of_week: event.target.value }))}
                            >
                                <option value="1">Понедельник</option>
                                <option value="2">Вторник</option>
                                <option value="3">Среда</option>
                                <option value="4">Четверг</option>
                                <option value="5">Пятница</option>
                                <option value="6">Суббота</option>
                                <option value="7">{'\u0412\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435'}</option>
                            </select>
                        </div>
                        <div className="form-row-pair">
                            <div className="form-row">
                                <label>Начало</label>
                                <input
                                    type="time"
                                    id="editTimeStart"
                                    className="form-input"
                                    value={editForm.time_start}
                                    onChange={(event) => setEditForm((previous) => ({ ...previous, time_start: event.target.value }))}
                                />
                            </div>
                            <div className="form-row">
                                <label>Конец</label>
                                <input
                                    type="time"
                                    id="editTimeEnd"
                                    className="form-input"
                                    value={editForm.time_end}
                                    onChange={(event) => setEditForm((previous) => ({ ...previous, time_end: event.target.value }))}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <label>Предмет</label>
                            <input
                                type="text"
                                id="editSubject"
                                className="form-input"
                                required
                                value={editForm.subject}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, subject: event.target.value }))}
                            />
                        </div>
                        <div className="form-row">
                            <label>Кабинет</label>
                            <input
                                type="text"
                                id="editRoom"
                                className="form-input"
                                value={editForm.room}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, room: event.target.value }))}
                            />
                        </div>
                        <div className="form-row">
                            <label>Преподаватель</label>
                            <input
                                type="text"
                                id="editTeacher"
                                className="form-input"
                                placeholder="Например: Герасимов Н.П."
                                value={editForm.teacher}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, teacher: event.target.value }))}
                            />
                        </div>
                        <div className="form-row-pair">
                            <div className="form-row">
                                <label>Тип</label>
                                <select
                                    id="editType"
                                    className="form-input"
                                    value={editForm.lesson_type}
                                    onChange={(event) => setEditForm((previous) => ({ ...previous, lesson_type: event.target.value }))}
                                >
                                    <option value="Лекция">Лекция</option>
                                    <option value="Практика">Практика</option>
                                    <option value="Лаб. работа">Лаб. работа</option>
                                </select>
                            </div>
                            <div className="form-row">
                                <label>Подгруппа</label>
                                <select
                                    id="editSubgroup"
                                    className="form-input"
                                    value={editForm.subgroup}
                                    onChange={(event) => setEditForm((previous) => ({ ...previous, subgroup: event.target.value }))}
                                >
                                    <option value="0">Обе</option>
                                    <option value="1">1-я</option>
                                    <option value="2">2-я</option>
                                </select>
                            </div>
                        </div>
                        <div className="modal-actions">
                            {editMode === 'edit' && (
                                <button type="button" className="btn btn-delete" onClick={handleDeleteFromModal}>
                                    {editContext === 'template' ? 'Убрать из шаблона' : 'Удалить'}
                                </button>
                            )}
                            <button type="button" className="btn btn-secondary" id="cancelEditBtn" onClick={() => setIsEditModalOpen(false)}>
                                Отмена
                            </button>
                            <button type="submit" className="btn btn-primary">
                                {editMode === 'create'
                                    ? 'Добавить'
                                    : (editContext === 'template' ? 'Сохранить как новую версию' : 'Сохранить')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            <div className={`toast ${isToastVisible ? 'active' : ''}`} aria-hidden={!isToastVisible}>{toastMessage}</div>
        </div>
    );
}

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
        'settings.update': 'Изменение настройки',
        'backup.create': 'Создание backup'
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
