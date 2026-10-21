import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import usePageAssets from '../hooks/usePageAssets';
import { formatLocalDateForApi, getSemesterWeekNumber } from '../lib/date';
import AdminLoadSection from './AdminLoadSection';
import { DEFAULT_EDIT_FORM, getMondayOfWeek } from './adminDashboard/builderUtils';
import BuilderSection from './adminDashboard/BuilderSection';
import useAdminApi from './adminDashboard/useAdminApi';
import DashboardSidebar from './adminDashboard/DashboardSidebar';
import SettingsSection from './adminDashboard/SettingsSection';
import SecuritySection from './adminDashboard/SecuritySection';
import BackupsSection from './adminDashboard/BackupsSection';
import AuditSection from './adminDashboard/AuditSection';
import AttestationsSection from './adminDashboard/AttestationsSection';
import LessonEditModal from './adminDashboard/LessonEditModal';

// localStorage key for the group last opened in the constructor.
const LAST_GROUP_KEY = 'kai_admin_last_group';

export default function AdminDashboardPage() {
    const isAssetsReady = usePageAssets({
        title: 'Панель администратора',
        description: 'Административная панель управления расписанием.',
        stylesheets: ['/css/admin-dashboard.css']
    });

    const navigate = useNavigate();
    const [activeSection, setActiveSection] = useState('builder');
    const [groups, setGroups] = useState([]);
    const [teachers, setTeachers] = useState([]);
    const [disciplines, setDisciplines] = useState([]);
    const [universities, setUniversities] = useState([]);
    const [newGroupUniversityId, setNewGroupUniversityId] = useState('');
    const [newGroupName, setNewGroupName] = useState('');
    const [newGroupDirection, setNewGroupDirection] = useState('');
    const [newGroupJoinedTo, setNewGroupJoinedTo] = useState('');
    const [isCreatingGroup, setIsCreatingGroup] = useState(false);
    // The constructor reopens on the group last worked on, instead of an
    // empty «Выберите группу» screen every visit.
    const [selectedGroupId, setSelectedGroupId] = useState(() => {
        try {
            return localStorage.getItem(LAST_GROUP_KEY) || '';
        } catch {
            return '';
        }
    });
    // "day|time" of the pair just saved: its card glows once in the grid.
    const [justSavedCell, setJustSavedCell] = useState('');
    const [lessons, setLessons] = useState([]);
    // The semester the constructor edits. Week numbers and parity are always
    // measured in it — never in another semester's calendar.
    const [workingSemester, setWorkingSemester] = useState(null);
    const [directorName, setDirectorName] = useState('');
    const [directorTitle, setDirectorTitle] = useState('Директор филиала');
    const [studyForm, setStudyForm] = useState('очная форма обучения');
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
    const { api, setCsrfToken } = useAdminApi(navigate);

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

                await Promise.all([
                    loadGroups(), loadUniversities(), loadSettings(), loadAuditLogs(), loadBackups(),
                    loadTeachers(), loadDisciplines()
                ]);
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
        // Runs once on arrival: the load* helpers are plain functions recreated every
        // render, so listing them would re-fetch everything on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        try {
            if (selectedGroupId) {
                localStorage.setItem(LAST_GROUP_KEY, String(selectedGroupId));
            } else {
                localStorage.removeItem(LAST_GROUP_KEY);
            }
        } catch {
            // Storage unavailable: the group just isn't remembered.
        }
    }, [selectedGroupId]);

    // A remembered group that no longer exists (deleted since) is dropped.
    useEffect(() => {
        if (selectedGroupId && groups.length > 0 && !groups.some((group) => String(group.id) === String(selectedGroupId))) {
            setSelectedGroupId('');
        }
    }, [groups, selectedGroupId]);

    useEffect(() => {
        if (!justSavedCell) {
            return undefined;
        }

        const timer = window.setTimeout(() => setJustSavedCell(''), 1600);
        return () => window.clearTimeout(timer);
    }, [justSavedCell]);

    useEffect(() => {
        if (!selectedGroupId) {
            setLessons([]);
            return;
        }

        loadLessons(selectedGroupId);
        // Re-fetch only when the group changes (loadLessons is recreated every render).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedGroupId]);


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

    // The constructor's teacher/discipline pickers need the same dictionaries
    // the "Нагрузка" section manages — a pair's identity comes from picking
    // one of these rows, not from typing.
    async function loadTeachers() {
        try {
            const response = await api('/api/admin/teachers');
            const data = await response.json();
            setTeachers(Array.isArray(data) ? data : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить преподавателей');
            }
        }
    }

    async function loadDisciplines() {
        try {
            const response = await api('/api/admin/disciplines');
            const data = await response.json();
            setDisciplines(Array.isArray(data) ? data : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить дисциплины');
            }
        }
    }

    async function createTeacher(fullName) {
        const response = await api('/api/admin/teachers', { method: 'POST', body: JSON.stringify({ full_name: fullName }) });
        const data = await response.json();

        if (!response.ok) {
            setToastMessage(data.error || 'Не удалось добавить преподавателя');
            return null;
        }

        setTeachers((previous) => [...previous, data]);
        return { id: data.id, label: data.full_name };
    }

    async function createDiscipline(name) {
        const response = await api('/api/admin/disciplines', { method: 'POST', body: JSON.stringify({ name }) });
        const data = await response.json();

        if (!response.ok) {
            setToastMessage(data.error || 'Не удалось добавить дисциплину');
            return null;
        }

        setDisciplines((previous) => [...previous, data]);
        return { id: data.id, label: data.name };
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

    // Switching the working semester changes which lessons the constructor
    // shows and how it numbers weeks — reload both, or the grid would keep
    // editing the previous semester's rows under the new semester's dates.
    async function reloadWorkingSemester() {
        await loadSettings();
        if (selectedGroupId) {
            await loadLessons(selectedGroupId);
        }
    }

    async function loadSettings() {
        try {
            const response = await api('/api/admin/settings');
            const data = await response.json();

            setWorkingSemester(data.active_semester || null);

            if (data.director_name) setDirectorName(data.director_name);
            if (data.director_title) setDirectorTitle(data.director_title);
            if (data.study_form) setStudyForm(data.study_form);
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

    // Replacing the whole database is the one action here that cannot be
    // undone by editing — so the specialist types a word, not just clicks OK.
    // The server keeps a copy of the state being replaced either way.
    function confirmRestore(sourceLabel) {
        const answer = window.prompt(
            `Восстановить базу из «${sourceLabel}»?\n\n` +
            'Всё расписание, нагрузка и настройки станут такими, какими были в этой копии. ' +
            'Изменения, сделанные после неё, пропадут (текущее состояние сохранится отдельной копией).\n\n' +
            'Чтобы продолжить, введите слово ВОССТАНОВИТЬ'
        );
        return answer !== null && answer.trim().toUpperCase() === 'ВОССТАНОВИТЬ';
    }

    async function finishRestore(response) {
        const data = await response.json();

        if (!response.ok) {
            setToastMessage(data.error || 'Не удалось восстановить базу');
            return;
        }

        window.alert(
            `База восстановлена: групп ${data.groups}, занятий ${data.lessons}.\n` +
            `Состояние до восстановления сохранено как ${data.safety_backup}.\n\nСтраница перезагрузится.`
        );
        window.location.reload();
    }

    async function restoreBackup(fileName) {
        if (!confirmRestore(fileName)) return;

        try {
            await finishRestore(await api(`/api/admin/backups/${encodeURIComponent(fileName)}/restore`, { method: 'POST' }));
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
        }
    }

    async function restoreFromFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';

        if (!file || !confirmRestore(file.name)) return;

        try {
            await finishRestore(await api('/api/admin/backups/upload-restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: file
            }));
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
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
            lesson_type: lesson.lesson_type || (lesson.kind === 'event' ? '' : 'Лекция'),
            teacher: lesson.teacher || '',
            teacher_id: lesson.teacher_id ?? null,
            discipline_id: lesson.discipline_id ?? null,
            kind: lesson.kind || 'lesson',
            subgroup: lesson.subgroup,
            week_type: lesson.week_type,
            specific_week: lesson.specific_week ?? ''
        });
        setIsEditModalOpen(true);
    }

    const builderWeekEnd = new Date(builderWeekStart);
    builderWeekEnd.setDate(builderWeekEnd.getDate() + 6);

    // A browsed week that ends before the working semester starts has no
    // number in it: clamping it to week 1 would let an edit of "December" in
    // the spring constructor silently land in spring's first week.
    const isBuilderWeekBeforeSemester = Boolean(workingSemester)
        && formatLocalDateForApi(builderWeekEnd) < workingSemester.start_date;

    const builderWeekNumber = workingSemester && !isBuilderWeekBeforeSemester
        ? getSemesterWeekNumber(workingSemester.start_date, builderWeekStart)
        : null;

    // Before the semester starts (building it ahead of time) this is week 1 —
    // the initial version of the template, which is exactly what is edited.
    const todayWeekNumber = workingSemester
        ? getSemesterWeekNumber(workingSemester.start_date, new Date())
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
            teacher_id: null,
            discipline_id: null,
            kind: 'lesson',
            subgroup,
            week_type: context === 'template' ? builderTemplateWeekType : 0,
            specific_week: context === 'template' ? '' : targetWeekNumber,
            extra_group_ids: []
        });
        setIsEditModalOpen(true);
    }


    // Saved, but on top of an exam, credit or consultation of the group: said
    // right away (the «Сессия» list also marks the record ⚠).
    function attestationNote(saved) {
        const warnings = saved?.attestation_warnings || [];
        return warnings.length > 0
            ? `Сохранено, но в это время у группы ${warnings.join('; ')} — пара будет засчитана, если её не убрать`
            : '';
    }

    // A pair placed after the semester's last week would show to students but
    // never count toward hours, so the server refuses it with needs_extension.
    // Offered here in one step: extend the semester to that week, then the
    // caller saves again. Returns true when the semester was extended.
    async function offerSemesterExtension(data) {
        if (!data?.needs_extension) {
            return false;
        }

        const shouldExtend = window.confirm(
            `Это ${data.weeks_needed}-я неделя, а семестр — до ${data.weeks_count}-й.\n\n`
            + `Продлить семестр до ${data.weeks_needed} недель? Тогда пары этой недели будут засчитываться в часы. `
            + 'Если в шаблоне есть пары, они тоже начнут показываться в добавленных неделях.'
        );

        if (!shouldExtend) {
            return false;
        }

        const response = await api(`/api/admin/semesters/${data.semester_id}`, {
            method: 'PUT',
            body: JSON.stringify({ weeks_count: data.weeks_needed })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            setToastMessage(error.error || 'Не удалось продлить семестр');
            return false;
        }

        await loadSettings();
        return true;
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
            const move = () => api('/api/admin/schedule/move-lesson', {
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
            let response = await move();
            let failure = response.ok ? null : await response.json();

            if (failure && await offerSemesterExtension(failure)) {
                response = await move();
                failure = response.ok ? null : await response.json();
            }

            if (failure) {
                // Declining the extension is a choice, not an error to report.
                if (!failure.needs_extension) {
                    setToastMessage(failure.error || 'Не удалось перенести занятие');
                }
                return;
            }

            setToastMessage(attestationNote(await response.json().catch(() => ({}))) || (
                builderMode === 'template'
                    ? 'Пара перенесена — с этой недели и далее'
                    : 'Пара перенесена на этой неделе'
            ));
            loadLessons(selectedGroupId);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
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
                        is_removed: true,
                        replaces_lesson_id: editForm.id ? Number(editForm.id) : null
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

        const isEvent = editForm.kind === 'event';

        // A pair's subject comes from the list only (what makes its hours
        // count); a free title is what the «Мероприятие» box is for.
        if (!isEvent && !editForm.discipline_id) {
            setToastMessage('Выберите предмет из списка — или отметьте «Мероприятие», если это не занятие');
            return;
        }

        const body = {
            day_of_week: Number(editForm.day_of_week),
            time_start: editForm.time_start,
            time_end: editForm.time_end,
            subject: editForm.subject,
            room: editForm.room,
            lesson_type: isEvent ? null : editForm.lesson_type,
            teacher: isEvent ? null : editForm.teacher,
            teacher_id: isEvent ? null : editForm.teacher_id,
            discipline_id: isEvent ? null : editForm.discipline_id,
            kind: isEvent ? 'event' : 'lesson',
            subgroup: Number(editForm.subgroup),
            week_type: Number(editForm.week_type),
            specific_week: editForm.specific_week
        };

        // A new pair for other groups too (a stream's lecture): checked for
        // every group BEFORE anything is saved, so a taken cell in one of them
        // stops the whole thing rather than leaving the lecture in one group.
        const extraGroupIds = editMode === 'create' ? (editForm.extra_group_ids || []).filter(Boolean).map(Number) : [];
        const extraBody = {
            ...body,
            group_ids: extraGroupIds,
            specific_week: editContext === 'template' ? null : Number(editForm.specific_week)
        };

        try {
            let response;

            if (extraGroupIds.length > 0) {
                const check = await api('/api/admin/lessons/for-groups', {
                    method: 'POST',
                    body: JSON.stringify({ ...extraBody, dry_run: true })
                });

                if (!check.ok) {
                    const data = await check.json();

                    if (await offerSemesterExtension(data)) {
                        return handleEditSubmit(event);
                    }

                    if (!data.needs_extension) {
                        setToastMessage(data.error || 'Не удалось проверить другие группы');
                    }
                    return;
                }
            }

            if (editContext === 'template') {
                // Template edits are always inserted as a new version — existing rows
                // (and therefore past weeks that resolved to them) are never mutated.
                response = await api('/api/admin/lessons', {
                    method: 'POST',
                    body: JSON.stringify({
                        ...body,
                        group_id: Number(editForm.group_id),
                        specific_week: null,
                        replaces_lesson_id: editMode === 'edit' && editForm.id ? Number(editForm.id) : null
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
                        subject: body.subject,
                        room: body.room,
                        lesson_type: body.lesson_type,
                        teacher: body.teacher,
                        teacher_id: body.teacher_id,
                        discipline_id: body.discipline_id,
                        kind: body.kind
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

                if (await offerSemesterExtension(data)) {
                    return handleEditSubmit(event);
                }

                if (!data.needs_extension) {
                    setToastMessage(data.error || (editMode === 'create' ? 'Не удалось добавить занятие' : 'Не удалось обновить занятие'));
                }
                return;
            }

            const saved = await response.json().catch(() => ({}));
            const ownWeeks = editContext === 'template' && Array.isArray(saved.own_weeks_ahead) ? saved.own_weeks_ahead : [];
            let extraNote = '';

            if (extraGroupIds.length > 0) {
                const extra = await api('/api/admin/lessons/for-groups', {
                    method: 'POST',
                    body: JSON.stringify(extraBody)
                });
                const names = groups.filter((group) => extraGroupIds.includes(Number(group.id))).map((group) => group.name);
                extraNote = extra.ok
                    ? ` — и в ${names.join(', ')}`
                    : `, но в ${names.join(', ')} не добавлено: ${(await extra.json().catch(() => ({}))).error || 'ошибка'}`;
            }

            setJustSavedCell(`${editForm.day_of_week}|${editForm.time_start}`);
            setIsEditModalOpen(false);
            setEditForm(DEFAULT_EDIT_FORM);

            // Hours match this pair to a plan row live, by identity — no
            // separate link to lose track of any more. A substitute or a
            // swapped-in discipline just carries different ids and stops
            // matching the old plan row on its own.
            setToastMessage(attestationNote(saved) || (ownWeeks.length > 0
                ? `Недели ${ownWeeks.join(', ')} отредактированы отдельно — в них это изменение не появится, поправьте их на вкладке недели.`
                : (editMode === 'create' ? `Занятие добавлено${extraNote}` : 'Занятие обновлено')));
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

        const weekQuery = `group_id=${selectedGroupId}&week_number=${builderWeekNumber}`;

        try {
            // Said as it is: on the live site the template is empty, so
            // "back to the template" would really mean an empty week.
            const summaryResponse = await api(`/api/admin/schedule/week-summary?${weekQuery}`);
            const summary = await summaryResponse.json();

            if (!summaryResponse.ok) {
                setToastMessage(summary.error || 'Не удалось очистить неделю');
                return;
            }

            const shouldClear = window.confirm(summary.template_pairs > 0
                ? `Удалить ${summary.pairs} пар(ы) этой недели и вернуть шаблон (${summary.template_pairs} пар(ы))? Действие необратимо.`
                : `Удалить все ${summary.pairs} пар(ы) этой недели? Шаблона нет — неделя станет пустой. Действие необратимо.`);

            if (!shouldClear) {
                return;
            }

            if (summary.hours_lost > 0 && !window.confirm(
                `Эти пары уже засчитаны преподавателям: они потеряют ${summary.hours_lost} ч. Всё равно удалить?`
            )) {
                return;
            }

            const response = await api(
                `/api/admin/schedule/week?${weekQuery}${summary.hours_lost > 0 ? '&confirm=1' : ''}`,
                { method: 'DELETE' }
            );

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось очистить неделю');
                return;
            }

            setToastMessage(summary.template_pairs > 0 ? 'Неделя очищена — показывается шаблон' : 'Неделя очищена');
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
                    direction: newGroupDirection.trim(),
                    joined_to: newGroupJoinedTo ? Number(newGroupJoinedTo) : null
                })
            });

            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось добавить группу');
                return;
            }

            // A full reload: joining changes the other group's label too.
            await loadGroups();
            setToastMessage(data.joined_to_name ? `Группа ${data.name} добавлена и объединена с ${data.joined_to_name}` : `Группа ${data.name} добавлена`);
            setNewGroupName('');
            setNewGroupDirection('');
            setNewGroupJoinedTo('');
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

    // Join a group to another (they share one timetable from then on), or
    // split it off again with leaderId ''.
    async function handleJoinGroup(groupId, leaderId) {
        const group = groups.find((item) => item.id === groupId);
        const leader = groups.find((item) => String(item.id) === String(leaderId));
        const question = leader
            ? `Объединить ${group.name} с ${leader.name}?\n\nРасписание станет общим: правите только ${leader.name}, студенты ${group.name} видят то же самое, в Excel — один блок «${leader.name} / ${group.name}». Пары ${group.name}, совпадающие с ${leader.name}, удалятся как дубли; если хоть одна отличается, объединения не будет.`
            : `Разъединить ${group.name} и ${group.joined_to_name}?\n\n${group.name} получит копию общего расписания и дальше пойдёт отдельно.`;

        if (!window.confirm(question)) {
            return;
        }

        try {
            const response = await api(`/api/admin/groups/${groupId}`, {
                method: 'PUT',
                body: JSON.stringify({ joined_to: leaderId ? Number(leaderId) : null })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось изменить объединение');
                return;
            }

            await loadGroups();
            setToastMessage(leader ? `${group.name} объединена с ${leader.name}` : `${group.name} теперь отдельно`);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    // A group joined while it was open in the constructor: switch to the
    // leader, where its timetable now lives.
    const selectedLeaderId = groups.find((group) => String(group.id) === String(selectedGroupId))?.joined_to;

    useEffect(() => {
        if (selectedLeaderId) {
            setSelectedGroupId(String(selectedLeaderId));
        }
    }, [selectedLeaderId]);

    // The constructor works with one group per shared timetable: a joined
    // group is left out, its leader is shown as "23303 / 23313".
    const builderGroups = groups
        .filter((group) => !group.joined_to)
        .map((group) => (group.joined_label ? { ...group, name: group.joined_label } : group));

    async function saveSettings() {
        try {
            const response = await api('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify({
                    director_name: directorName,
                    director_title: directorTitle,
                    study_form: studyForm
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
            <DashboardSidebar
                activeSection={activeSection}
                auditLogs={auditLogs}
                backups={backups}
                loadAuditLogs={loadAuditLogs}
                loadBackups={loadBackups}
                logout={logout}
                setActiveSection={setActiveSection}
            />

            <main className="main-content">
                <BuilderSection
                    activeSection={activeSection}
                    workingSemester={workingSemester}
                    groups={builderGroups}
                    selectedGroupId={selectedGroupId}
                    setSelectedGroupId={setSelectedGroupId}
                    lessons={lessons}
                    builderMode={builderMode}
                    setBuilderMode={setBuilderMode}
                    builderWeekStart={builderWeekStart}
                    setBuilderWeekStart={setBuilderWeekStart}
                    builderWeekEnd={builderWeekEnd}
                    builderTemplateWeekType={builderTemplateWeekType}
                    setBuilderTemplateWeekType={setBuilderTemplateWeekType}
                    builderWeekNumber={builderWeekNumber}
                    builderWeekMaterialized={builderWeekMaterialized}
                    isBuilderWeekBeforeSemester={isBuilderWeekBeforeSemester}
                    todayWeekNumber={todayWeekNumber}
                    isExporting={isExporting}
                    handleClearWeek={handleClearWeek}
                    handleExport={handleExport}
                    draggedLesson={draggedLesson}
                    setDraggedLesson={setDraggedLesson}
                    dragOverCellKey={dragOverCellKey}
                    setDragOverCellKey={setDragOverCellKey}
                    handleDropOnCell={handleDropOnCell}
                    openEditModal={openEditModal}
                    openCreateModal={openCreateModal}
                    justSavedCell={justSavedCell}
                />

                <section className={`content-section ${activeSection === 'load' ? 'active' : ''}`} id="sectionLoad">
                    {activeSection === 'load' && (
                        <AdminLoadSection
                            api={api}
                            groups={groups}
                            setToastMessage={setToastMessage}
                            onWorkingSemesterChange={reloadWorkingSemester}
                        />
                    )}
                </section>

                <AttestationsSection
                    activeSection={activeSection}
                    api={api}
                    groups={builderGroups}
                    teachers={teachers}
                    disciplines={disciplines}
                    onCreateTeacher={createTeacher}
                    onCreateDiscipline={createDiscipline}
                    setToastMessage={setToastMessage}
                />

                <SettingsSection
                    activeSection={activeSection}
                    directorName={directorName}
                    directorTitle={directorTitle}
                    groupDirectionDrafts={groupDirectionDrafts}
                    groups={groups}
                    handleCreateGroup={handleCreateGroup}
                    handleSaveGroupDirection={handleSaveGroupDirection}
                    handleJoinGroup={handleJoinGroup}
                    newGroupJoinedTo={newGroupJoinedTo}
                    setNewGroupJoinedTo={setNewGroupJoinedTo}
                    isCreatingGroup={isCreatingGroup}
                    newGroupDirection={newGroupDirection}
                    newGroupName={newGroupName}
                    newGroupUniversityId={newGroupUniversityId}
                    saveSettings={saveSettings}
                    setDirectorName={setDirectorName}
                    setDirectorTitle={setDirectorTitle}
                    setGroupDirectionDrafts={setGroupDirectionDrafts}
                    setNewGroupDirection={setNewGroupDirection}
                    setNewGroupName={setNewGroupName}
                    setNewGroupUniversityId={setNewGroupUniversityId}
                    setStudyForm={setStudyForm}
                    settingsStatus={settingsStatus}
                    studyForm={studyForm}
                    universities={universities}
                >
                    <SecuritySection
                        isActive={activeSection === 'settings'}
                        api={api}
                        setToastMessage={setToastMessage}
                        onLoggedOut={() => navigate('/admin', { replace: true })}
                    />
                </SettingsSection>

                <BackupsSection
                    activeSection={activeSection}
                    backups={backups}
                    createBackup={createBackup}
                    isBackupsLoading={isBackupsLoading}
                    isCreatingBackup={isCreatingBackup}
                    loadBackups={loadBackups}
                    restoreBackup={restoreBackup}
                    restoreFromFile={restoreFromFile}
                />

                <AuditSection
                    activeSection={activeSection}
                    auditLogs={auditLogs}
                    isAuditLogsLoading={isAuditLogsLoading}
                    loadAuditLogs={loadAuditLogs}
                />
            </main>

            <LessonEditModal
                disciplines={disciplines}
                editContext={editContext}
                editForm={editForm}
                editMode={editMode}
                groups={builderGroups}
                handleDeleteFromModal={handleDeleteFromModal}
                handleEditSubmit={handleEditSubmit}
                isEditModalOpen={isEditModalOpen}
                onCreateDiscipline={createDiscipline}
                onCreateTeacher={createTeacher}
                setEditForm={setEditForm}
                setIsEditModalOpen={setIsEditModalOpen}
                teachers={teachers}
            />

            <div className={`toast ${isToastVisible ? 'active' : ''}`} aria-hidden={!isToastVisible}>{toastMessage}</div>
        </div>
    );
}
