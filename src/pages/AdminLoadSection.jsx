import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getWeekTypeNumber } from '../lib/date';

const LESSON_TYPES = ['Лекция', 'Практика', 'Лаб', 'Консультация', 'Зачёт', 'Экзамен'];
const REF_PREVIEW_COUNT = 5;

// The teaching-load admin window — kept as its own component (rather than
// folded into AdminDashboardPage.jsx) since that file is already the
// biggest one in the app; this is a natural place to stop adding to it.
export default function AdminLoadSection({ api, groups, setToastMessage, onWorkingSemesterChange }) {
    const [teachers, setTeachers] = useState([]);
    const [disciplines, setDisciplines] = useState([]);
    const [semesters, setSemesters] = useState([]);
    const [loadPlan, setLoadPlan] = useState([]);
    const [isLoading, setIsLoading] = useState(false);

    const [newTeacherName, setNewTeacherName] = useState('');
    const [newDisciplineName, setNewDisciplineName] = useState('');
    // first_week_parity '' = "take the calendar default for the start date" until picked.
    const [newSemester, setNewSemester] = useState({ label: '', start_date: '', weeks_count: 18, first_week_parity: '' });

    const [planForm, setPlanForm] = useState(emptyPlanForm());
    // Only tracks WHICH row is being edited — the field values themselves live
    // as local state inside that row's PlanRow instance (see the comment on
    // PlanRow) so that typing in the edit form never re-renders every other row.
    const [editingPlanId, setEditingPlanId] = useState(null);

    // Past weeks nobody entered: their hours came from the template.
    const [unconfirmedWeeks, setUnconfirmedWeeks] = useState([]);
    const [isEditingSemester, setIsEditingSemester] = useState(false);
    const [semesterEdit, setSemesterEdit] = useState({ start_date: '', weeks_count: 18, first_week_parity: 1 });

    const [showAllTeachers, setShowAllTeachers] = useState(false);
    const [showAllDisciplines, setShowAllDisciplines] = useState(false);
    const [filterQuery, setFilterQuery] = useState('');
    const [filterGroupId, setFilterGroupId] = useState('');
    const [openMenuId, setOpenMenuId] = useState(null);
    const menuCloseTimeout = useRef(null);

    // Two different things that used to be one dropdown: the WORKING semester
    // (server-side, the one the constructor edits and bulk upload writes into)
    // and the semester merely being LOOKED AT here. Picking last autumn's plan
    // to check a number must not switch what everyone else is working in.
    const activeSemester = semesters.find((semester) => semester.is_active) || null;
    const [viewedSemesterId, setViewedSemesterId] = useState(null);
    const viewedSemester = semesters.find((semester) => semester.id === viewedSemesterId) || activeSemester;

    useEffect(() => {
        loadAll();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        setIsEditingSemester(false);
        setEditingPlanId(null);

        if (viewedSemester) {
            loadPlanForSemester(viewedSemester.id);
        } else {
            setLoadPlan([]);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewedSemester?.id]);

    async function loadAll() {
        setIsLoading(true);

        try {
            const [teachersRes, disciplinesRes, semestersRes] = await Promise.all([
                api('/api/admin/teachers'),
                api('/api/admin/disciplines'),
                api('/api/admin/semesters')
            ]);

            setTeachers(await teachersRes.json());
            setDisciplines(await disciplinesRes.json());
            setSemesters(await semestersRes.json());
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить данные по нагрузке');
            }
        } finally {
            setIsLoading(false);
        }
    }

    async function loadPlanForSemester(semesterId) {
        try {
            const response = await api(`/api/admin/load-plan?semester_id=${semesterId}`);
            setLoadPlan(await response.json());

            const coverage = await (await api(`/api/admin/semesters/${semesterId}/week-coverage`)).json();
            setUnconfirmedWeeks(Array.isArray(coverage.unconfirmed_weeks) ? coverage.unconfirmed_weeks : []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Не удалось загрузить план нагрузки');
            }
        }
    }

    const refreshPlan = useCallback(async () => {
        if (viewedSemester) {
            await loadPlanForSemester(viewedSemester.id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- loadPlanForSemester
        // closes over api/setToastMessage/setLoadPlan, none of which change
        // for the interactions this is memoized against (see PlanRow).
    }, [viewedSemester?.id]);

    async function addTeacher(event) {
        event.preventDefault();
        const fullName = newTeacherName.trim();
        if (!fullName) return;

        try {
            const response = await api('/api/admin/teachers', {
                method: 'POST',
                body: JSON.stringify({ full_name: fullName })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось добавить преподавателя');
                return;
            }

            setTeachers((previous) => [...previous, data].sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru')));
            setNewTeacherName('');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function addDiscipline(event) {
        event.preventDefault();
        const name = newDisciplineName.trim();
        if (!name) return;

        try {
            const response = await api('/api/admin/disciplines', {
                method: 'POST',
                body: JSON.stringify({ name })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось добавить дисциплину');
                return;
            }

            setDisciplines((previous) => [...previous, data].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
            setNewDisciplineName('');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    // Fixing a one-letter typo without deleting and recreating (which would
    // detach every load_plan row already entered against the old name).
    async function renameTeacher(teacher) {
        const nextName = window.prompt('Новое ФИО преподавателя', teacher.full_name);
        if (!nextName || !nextName.trim() || nextName.trim() === teacher.full_name) return;

        try {
            const response = await api(`/api/admin/teachers/${teacher.id}`, {
                method: 'PUT',
                body: JSON.stringify({ full_name: nextName.trim() })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось переименовать преподавателя');
                return;
            }

            setTeachers((previous) =>
                previous.map((t) => (t.id === teacher.id ? data : t)).sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
            );
            await refreshPlan();
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function deleteTeacher(teacher) {
        if (!window.confirm(`Удалить преподавателя «${teacher.full_name}» из справочника?`)) return;

        try {
            const response = await api(`/api/admin/teachers/${teacher.id}`, { method: 'DELETE' });

            if (!response.ok) {
                const data = await response.json();
                // 409 here means load_plan rows still reference this teacher —
                // the message explains what to clear first.
                setToastMessage(data.error || 'Не удалось удалить преподавателя');
                return;
            }

            setTeachers((previous) => previous.filter((t) => t.id !== teacher.id));
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function renameDiscipline(discipline) {
        const nextName = window.prompt('Новое название дисциплины', discipline.name);
        if (!nextName || !nextName.trim() || nextName.trim() === discipline.name) return;

        try {
            const response = await api(`/api/admin/disciplines/${discipline.id}`, {
                method: 'PUT',
                body: JSON.stringify({ name: nextName.trim() })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось переименовать дисциплину');
                return;
            }

            setDisciplines((previous) =>
                previous.map((d) => (d.id === discipline.id ? data : d)).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
            );
            await refreshPlan();
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function deleteDiscipline(discipline) {
        if (!window.confirm(`Удалить дисциплину «${discipline.name}» из справочника?`)) return;

        try {
            const response = await api(`/api/admin/disciplines/${discipline.id}`, { method: 'DELETE' });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось удалить дисциплину');
                return;
            }

            setDisciplines((previous) => previous.filter((d) => d.id !== discipline.id));
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    function startEditSemester() {
        setSemesterEdit({
            start_date: viewedSemester.start_date,
            weeks_count: String(viewedSemester.weeks_count),
            first_week_parity: viewedSemester.first_week_parity
        });
        setIsEditingSemester(true);
    }

    // Both of these settings silently re-derive every teacher's hours — the
    // start date moves every lesson's date, the week count is the ceiling the
    // counter stops at. So ask the server what the change would do and make
    // the specialist confirm the actual numbers before writing it.
    async function saveSemesterEdit(event) {
        event.preventDefault();

        const weeksCount = Number(semesterEdit.weeks_count);

        if (!semesterEdit.start_date || !Number.isInteger(weeksCount) || weeksCount < 1) {
            setToastMessage('Укажите дату начала и число недель');
            return;
        }

        const parity = Number(semesterEdit.first_week_parity);
        const semester = viewedSemester;

        if (
            semesterEdit.start_date === semester.start_date
            && weeksCount === semester.weeks_count
            && parity === semester.first_week_parity
        ) {
            setIsEditingSemester(false);
            return;
        }

        try {
            const impactRes = await api(
                `/api/admin/semesters/${semester.id}/impact?start_date=${semesterEdit.start_date}&weeks_count=${weeksCount}&first_week_parity=${parity}`
            );
            const impact = await impactRes.json();

            if (!impactRes.ok) {
                setToastMessage(impact.error || 'Не удалось посчитать последствия');
                return;
            }

            if (impact.teachers_changed > 0) {
                const names = impact.teacher_names.join(', ');
                const more = impact.teachers_changed > impact.teacher_names.length ? ' и др.' : '';
                const delta = impact.hours_after - impact.hours_before;
                const confirmed = window.confirm(
                    `Это пересчитает уже проведённые часы.\n\n` +
                    `Затронуто преподавателей: ${impact.teachers_changed}\n` +
                    `Строк плана: ${impact.plan_rows_changed} из ${impact.plan_rows_total}\n` +
                    `Суммарно часов: ${impact.hours_before} → ${impact.hours_after} (${delta > 0 ? '+' : ''}${delta})\n\n` +
                    `Кого затронет: ${names}${more}\n\n` +
                    `Последняя учебная неделя: ${impact.last_week.current} → ${impact.last_week.proposed}\n\n` +
                    `Применить?`
                );

                if (!confirmed) return;
            }

            const response = await api(`/api/admin/semesters/${semester.id}`, {
                method: 'PUT',
                body: JSON.stringify({ start_date: semesterEdit.start_date, weeks_count: weeksCount, first_week_parity: parity })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось сохранить семестр');
                return;
            }

            setSemesters((previous) => previous.map((s) => (s.id === semester.id ? data : s)));
            setIsEditingSemester(false);
            await refreshPlan();
            if (semester.is_active) {
                // The constructor numbers weeks from this semester's dates.
                onWorkingSemesterChange?.();
            }
            setToastMessage('Семестр изменён');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function addSemester(event) {
        event.preventDefault();

        if (!newSemester.label.trim() || !newSemester.start_date) {
            setToastMessage('Укажите название и дату начала семестра');
            return;
        }

        try {
            const response = await api('/api/admin/semesters', {
                method: 'POST',
                body: JSON.stringify({
                    label: newSemester.label.trim(),
                    start_date: newSemester.start_date,
                    weeks_count: Number(newSemester.weeks_count) || 18,
                    first_week_parity: resolveNewSemesterParity(newSemester)
                })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось создать семестр');
                return;
            }

            setSemesters((previous) => [data, ...previous]);
            setNewSemester({ label: '', start_date: '', weeks_count: 18, first_week_parity: '' });
            setToastMessage(activeSemester
                ? `Семестр создан. Рабочим остаётся «${activeSemester.label}» — переключите, когда начнёте вносить новое расписание`
                : 'Семестр создан');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    async function activateSemester(semester) {
        if (!semester || semester.is_active) {
            return;
        }

        const confirmed = window.confirm(
            `Сделать рабочим семестр «${semester.label}»?\n\n` +
            `Конструктор расписания и загрузка из Excel будут записывать пары в него` +
            (activeSemester ? ` вместо «${activeSemester.label}»` : '') + `.\n\n` +
            `Студенты и преподаватели это не заметят: каждый видит тот семестр, который идёт по календарю. ` +
            `Пары и часы других семестров не меняются.`
        );

        if (!confirmed) return;

        const semesterId = semester.id;

        try {
            const response = await api(`/api/admin/semesters/${semesterId}`, {
                method: 'PUT',
                body: JSON.stringify({ is_active: true })
            });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось активировать семестр');
                return;
            }

            setSemesters((previous) => previous.map((candidate) => ({ ...candidate, is_active: candidate.id === semesterId })));
            onWorkingSemesterChange?.();
            setToastMessage(`Рабочий семестр: «${semester.label}»`);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    // Closing turns the semester's hours into a stored result: reports printed
    // from it stay true afterwards, because nothing in it can change any more.
    async function closeSemester() {
        const hours = loadPlan.reduce((sum, row) => sum + (row.progress?.occurred_hours || 0), 0);
        const confirmed = window.confirm(
            `Закрыть семестр «${viewedSemester.label}»?\n\n` +
            `Итог будет зафиксирован: строк плана ${loadPlan.length}, проведено ${hours} часов.\n\n` +
            (unconfirmedWeeks.length > 0
                ? `Внимание: расписание не вносили на недели ${unconfirmedWeeks.join(', ')} — часы по ним посчитаны по шаблону.\n\n`
                : '') +
            'После этого расписание и нагрузку этого семестра нельзя будет менять, ' +
            'а часы перестанут пересчитываться. Семестр можно открыть заново.'
        );

        if (!confirmed) return;

        try {
            const response = await api(`/api/admin/semesters/${viewedSemester.id}/close`, { method: 'POST' });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось закрыть семестр');
                return;
            }

            setSemesters((previous) => previous.map((s) => (s.id === data.id ? data : s)));
            await refreshPlan();
            setToastMessage(`Семестр закрыт. Итог: ${data.total_hours} часов по ${data.plan_rows} строкам`);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
        }
    }

    async function reopenSemester() {
        const confirmed = window.confirm(
            `Открыть семестр «${viewedSemester.label}» заново?\n\n` +
            'Часы снова начнут считаться по расписанию, и цифры могут отличаться от тех, ' +
            'что уже попали в отчёт.'
        );

        if (!confirmed) return;

        try {
            const response = await api(`/api/admin/semesters/${viewedSemester.id}/reopen`, { method: 'POST' });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось открыть семестр');
                return;
            }

            setSemesters((previous) => previous.map((s) => (s.id === data.id ? data : s)));
            await refreshPlan();
            setToastMessage('Семестр открыт — часы снова считаются по расписанию');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
        }
    }

    async function submitPlanForm(event) {
        event.preventDefault();

        if (!viewedSemester) {
            setToastMessage('Сначала создайте семестр');
            return;
        }

        const { teacher_id, discipline_id, lesson_type, group_id, planned_hours } = planForm;

        if (!teacher_id || !discipline_id || !group_id) {
            setToastMessage('Заполните преподавателя, дисциплину и группу');
            return;
        }

        try {
            const response = await api('/api/admin/load-plan', {
                method: 'POST',
                body: JSON.stringify({
                    semester_id: viewedSemester.id,
                    teacher_id: Number(teacher_id),
                    discipline_id: Number(discipline_id),
                    lesson_type,
                    group_id: Number(group_id),
                    subgroup: Number(planForm.subgroup) || 0,
                    planned_hours: planned_hours ? Number(planned_hours) : undefined
                })
            });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось добавить строку плана');
                return;
            }

            setLoadPlan((previous) => [...previous, data]);
            setPlanForm(emptyPlanForm());
            setToastMessage('Строка плана добавлена');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

    const updatePlannedHours = useCallback(async (planId, hoursText) => {
        const trimmed = hoursText.trim();
        const hours = Number(trimmed);

        if (!trimmed || !Number.isInteger(hours) || hours < 1) {
            setToastMessage('Часы должны быть целым числом больше нуля');
            return;
        }

        try {
            const response = await api(`/api/admin/load-plan/${planId}`, {
                method: 'PUT',
                body: JSON.stringify({ planned_hours: hours })
            });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось сохранить часы');
                return;
            }

            await refreshPlan();
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }, [api, setToastMessage, refreshPlan]);

    const startEditRow = useCallback((row) => {
        setOpenMenuId(null);
        setEditingPlanId(row.id);
    }, []);

    const cancelEditRow = useCallback(() => setEditingPlanId(null), []);

    // Returns whether the save succeeded — PlanRow keeps the user's in-progress
    // edit (rather than discarding it) if the server refuses, e.g. the 409
    // from changing group while lessons are still linked to this row.
    const saveEditRow = useCallback(async (planId, form) => {
        try {
            const response = await api(`/api/admin/load-plan/${planId}`, {
                method: 'PUT',
                body: JSON.stringify({
                    teacher_id: Number(form.teacher_id),
                    discipline_id: Number(form.discipline_id),
                    lesson_type: form.lesson_type,
                    group_id: Number(form.group_id),
                    subgroup: Number(form.subgroup),
                    planned_hours: form.planned_hours ? Number(form.planned_hours) : null
                })
            });
            const data = await response.json();

            if (!response.ok) {
                // 409 here means the row is still linked to schedule lessons in
                // its current group — the server explains what to do first.
                setToastMessage(data.error || 'Не удалось сохранить строку');
                return false;
            }

            setLoadPlan((previous) => previous.map((row) => (row.id === planId ? data : row)));
            setEditingPlanId(null);
            setToastMessage('Строка плана изменена');
            return true;
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
            return false;
        }
    }, [api, setToastMessage]);

    const deletePlanRow = useCallback(async (planId) => {
        setOpenMenuId(null);

        if (!window.confirm('Удалить эту строку плана? Связанная пара из расписания при этом не удаляется, просто отвяжется.')) {
            return;
        }

        try {
            const response = await api(`/api/admin/load-plan/${planId}`, { method: 'DELETE' });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось удалить строку плана');
                return;
            }

            setLoadPlan((previous) => previous.filter((row) => row.id !== planId));
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }, [api, setToastMessage]);

    const toggleRowMenu = useCallback((planId) => {
        if (menuCloseTimeout.current) {
            window.clearTimeout(menuCloseTimeout.current);
        }
        setOpenMenuId((previous) => (previous === planId ? null : planId));
    }, []);

    const scheduleMenuClose = useCallback(() => {
        menuCloseTimeout.current = window.setTimeout(() => setOpenMenuId(null), 150);
    }, []);

    const visibleTeachers = showAllTeachers ? teachers : teachers.slice(0, REF_PREVIEW_COUNT);
    const visibleDisciplines = showAllDisciplines ? disciplines : disciplines.slice(0, REF_PREVIEW_COUNT);

    const planStats = useMemo(() => {
        const total = loadPlan.length;
        const withHours = loadPlan.filter((row) => row.planned_hours !== null);
        const totalHours = withHours.reduce((sum, row) => sum + row.planned_hours, 0);
        const percentFilled = total > 0 ? Math.round((withHours.length / total) * 100) : 0;
        return { total, totalHours, percentFilled, hasUnfilled: withHours.length < total };
    }, [loadPlan]);

    const visibleRows = useMemo(() => {
        const query = filterQuery.trim().toLowerCase();

        return loadPlan.filter((row) => {
            if (filterGroupId && String(row.group_id) !== filterGroupId) {
                return false;
            }
            if (!query) {
                return true;
            }
            const haystack = `${row.teacher_name} ${row.discipline_name} ${row.lesson_type} ${row.group_name}`.toLowerCase();
            return haystack.includes(query);
        });
    }, [loadPlan, filterQuery, filterGroupId]);

    return (
        <div className="load-section">
            <h2 className="section-title">Учёт нагрузки</h2>
            <p className="section-desc">
                План формируется один раз на семестр, дальше система сама считает часы по проведённым парам —
                преподавателям заходить никуда не нужно, они смотрят свои часы на отдельной странице по поиску.
            </p>

            <h3 className="subsection-title">Семестр</h3>
            <div className="load-semester-bar">
                <div className="load-semester-select-wrap">
                    <select
                        className="form-input load-semester-select"
                        value={viewedSemester ? String(viewedSemester.id) : ''}
                        onChange={(event) => setViewedSemesterId(Number(event.target.value) || null)}
                    >
                        {semesters.length === 0 && <option value="">Семестров пока нет</option>}
                        {semesters.map((semester) => (
                            <option key={semester.id} value={semester.id}>
                                {semester.label}{semester.is_active ? ' (рабочий)' : ''}{semester.closed ? ' (закрыт)' : ''}
                            </option>
                        ))}
                    </select>
                    {viewedSemester && !isEditingSemester && (
                        <>
                            <span className="load-semester-meta">
                                {viewedSemester.start_date} · {viewedSemester.weeks_count} нед. ·
                                {' '}1-я неделя {parityLabel(viewedSemester.first_week_parity)} ·
                                {' '}последняя неделя {formatWeekRange(viewedSemester.start_date, viewedSemester.weeks_count)}
                            </span>
                            {!viewedSemester.closed && (
                                <button type="button" className="btn-link" onClick={startEditSemester}>изменить</button>
                            )}
                            {viewedSemester.is_active && (
                                <span className="load-semester-meta"><strong>рабочий</strong></span>
                            )}
                            {!viewedSemester.is_active && !viewedSemester.closed && (
                                <button type="button" className="btn-link" onClick={() => activateSemester(viewedSemester)}>
                                    сделать рабочим
                                </button>
                            )}
                            {viewedSemester.closed ? (
                                <>
                                    <span className="load-semester-closed">закрыт {viewedSemester.closed_at}</span>
                                    <button type="button" className="btn-link" onClick={reopenSemester}>открыть заново</button>
                                </>
                            ) : (
                                <button type="button" className="btn-link" onClick={closeSemester}>закрыть семестр</button>
                            )}
                        </>
                    )}
                    {viewedSemester && isEditingSemester && !viewedSemester.closed && (
                        <form className="load-semester-edit" onSubmit={saveSemesterEdit}>
                            <input
                                type="date"
                                className="form-input"
                                value={semesterEdit.start_date}
                                onChange={(event) => setSemesterEdit((previous) => ({ ...previous, start_date: event.target.value }))}
                            />
                            <input
                                type="number"
                                min="1"
                                max="52"
                                className="form-input load-weeks-input"
                                value={semesterEdit.weeks_count}
                                onChange={(event) => setSemesterEdit((previous) => ({ ...previous, weeks_count: event.target.value }))}
                            />
                            <select
                                className="form-input"
                                title="Чётная или нечётная первая неделя семестра — смотрите шапку расписания"
                                value={String(semesterEdit.first_week_parity)}
                                onChange={(event) => setSemesterEdit((previous) => ({ ...previous, first_week_parity: Number(event.target.value) }))}
                            >
                                <option value="1">1-я неделя нечётная</option>
                                <option value="2">1-я неделя чётная</option>
                            </select>
                            <span className="load-semester-meta">
                                → последняя неделя {formatWeekRange(semesterEdit.start_date, Number(semesterEdit.weeks_count))}
                            </span>
                            <button type="submit" className="btn btn-primary load-edit-save">Сохранить</button>
                            <button type="button" className="btn-link" onClick={() => setIsEditingSemester(false)}>Отмена</button>
                        </form>
                    )}
                </div>
                <form className="load-semester-add" onSubmit={addSemester}>
                    <input
                        type="text"
                        className="form-input"
                        placeholder="Например Осень 2026-2027"
                        value={newSemester.label}
                        onChange={(event) => setNewSemester((previous) => ({ ...previous, label: event.target.value }))}
                    />
                    <input
                        type="date"
                        className="form-input"
                        value={newSemester.start_date}
                        onChange={(event) => setNewSemester((previous) => ({ ...previous, start_date: event.target.value }))}
                    />
                    <input
                        type="number"
                        min="1"
                        max="52"
                        className="form-input load-weeks-input"
                        value={newSemester.weeks_count}
                        onChange={(event) => setNewSemester((previous) => ({ ...previous, weeks_count: event.target.value }))}
                    />
                    <select
                        className="form-input"
                        title="Чётная или нечётная первая неделя семестра — смотрите шапку расписания"
                        value={String(resolveNewSemesterParity(newSemester) || '')}
                        onChange={(event) => setNewSemester((previous) => ({ ...previous, first_week_parity: Number(event.target.value) }))}
                    >
                        {!resolveNewSemesterParity(newSemester) && <option value="">Чётность 1-й недели</option>}
                        <option value="1">1-я неделя нечётная</option>
                        <option value="2">1-я неделя чётная</option>
                    </select>
                    <button type="submit" className="btn btn-secondary">Добавить семестр</button>
                </form>
            </div>

            <h3 className="subsection-title">Преподаватели и дисциплины</h3>
            <div className="load-refs-row">
                <div className="load-ref-card">
                    <form className="load-ref-add-row" onSubmit={addTeacher}>
                        <input
                            type="text"
                            className="form-input"
                            placeholder="ФИО преподавателя"
                            value={newTeacherName}
                            onChange={(event) => setNewTeacherName(event.target.value)}
                        />
                        <button type="submit" className="btn btn-secondary">Добавить</button>
                    </form>
                    <div className="load-ref-card-header">
                        <span>Преподаватели</span>
                        <span className="load-ref-count">{teachers.length}</span>
                    </div>
                    <ul className="load-ref-list">
                        {visibleTeachers.map((teacher) => (
                            <li key={teacher.id} className="load-ref-row">
                                <span>{teacher.full_name}</span>
                                <span className="load-ref-row-actions">
                                    <button type="button" onClick={() => renameTeacher(teacher)} title="Переименовать">✎</button>
                                    <button type="button" onClick={() => deleteTeacher(teacher)} title="Удалить">✕</button>
                                </span>
                            </li>
                        ))}
                        {teachers.length === 0 && <li className="load-ref-empty">Преподавателей пока нет</li>}
                    </ul>
                    {teachers.length > REF_PREVIEW_COUNT && (
                        <button type="button" className="btn-link load-ref-all" onClick={() => setShowAllTeachers((v) => !v)}>
                            {showAllTeachers ? 'Свернуть' : 'Все'}
                        </button>
                    )}
                </div>

                <div className="load-ref-card">
                    <form className="load-ref-add-row" onSubmit={addDiscipline}>
                        <input
                            type="text"
                            className="form-input"
                            placeholder="Название дисциплины"
                            value={newDisciplineName}
                            onChange={(event) => setNewDisciplineName(event.target.value)}
                        />
                        <button type="submit" className="btn btn-secondary">Добавить</button>
                    </form>
                    <div className="load-ref-card-header">
                        <span>Дисциплины</span>
                        <span className="load-ref-count">{disciplines.length}</span>
                    </div>
                    <ul className="load-ref-list">
                        {visibleDisciplines.map((discipline) => (
                            <li key={discipline.id} className="load-ref-row">
                                <span>{discipline.name}</span>
                                <span className="load-ref-row-actions">
                                    <button type="button" onClick={() => renameDiscipline(discipline)} title="Переименовать">✎</button>
                                    <button type="button" onClick={() => deleteDiscipline(discipline)} title="Удалить">✕</button>
                                </span>
                            </li>
                        ))}
                        {disciplines.length === 0 && <li className="load-ref-empty">Дисциплин пока нет</li>}
                    </ul>
                    {disciplines.length > REF_PREVIEW_COUNT && (
                        <button type="button" className="btn-link load-ref-all" onClick={() => setShowAllDisciplines((v) => !v)}>
                            {showAllDisciplines ? 'Свернуть' : 'Все'}
                        </button>
                    )}
                </div>
            </div>

            <div className="load-plan-heading-row">
                <h3 className="subsection-title">План нагрузки {viewedSemester ? `— ${viewedSemester.label}` : ''}</h3>
                {viewedSemester && (
                    <a
                        className="btn btn-secondary"
                        href={`/api/admin/load-plan/export?semester_id=${viewedSemester.id}`}
                    >
                        Выгрузить в Excel
                    </a>
                )}
            </div>

            {!viewedSemester ? (
                <p className="empty-message">
                    {isLoading ? 'Загрузка...' : (semesters.length === 0 ? 'Создайте семестр выше, чтобы вести план.' : 'Выберите семестр выше, чтобы вести план.')}
                </p>
            ) : (
                <>
                    <div className="load-plan-stats">
                        <span>{planStats.total} {pluralizeRecords(planStats.total)}</span>
                        <span className="load-plan-stats-dot">·</span>
                        <span>{planStats.totalHours}{planStats.hasUnfilled ? '+' : ''} часов</span>
                        <div className="load-plan-stats-progress">
                            <div className="load-plan-stats-progress-fill" style={{ width: `${planStats.percentFilled}%` }} />
                        </div>
                        <span>{planStats.percentFilled}% заполнено</span>
                    </div>

                    {unconfirmedWeeks.length > 0 && (
                        <p className="load-unconfirmed-note">
                            На {unconfirmedWeeks.length === 1 ? 'неделю' : 'недели'} {unconfirmedWeeks.join(', ')} расписание
                            не вносили — часы за {unconfirmedWeeks.length === 1 ? 'неё' : 'них'} посчитаны по шаблону.
                            Если там были отмены или переносы, откройте нужную неделю в конструкторе и внесите, как было.
                        </p>
                    )}

                    {viewedSemester.closed && (
                        <p className="empty-message">
                            Семестр закрыт {viewedSemester.closed_at}: часы зафиксированы, изменения выключены.
                            Чтобы что-то поправить, откройте его заново выше.
                        </p>
                    )}

                    {!viewedSemester.closed && (
                    <form className="load-plan-form" onSubmit={submitPlanForm}>
                        <select
                            className="form-input"
                            value={planForm.teacher_id}
                            onChange={(event) => setPlanForm((previous) => ({ ...previous, teacher_id: event.target.value }))}
                        >
                            <option value="">Преподаватель</option>
                            {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.full_name}</option>)}
                        </select>
                        <select
                            className="form-input"
                            value={planForm.discipline_id}
                            onChange={(event) => setPlanForm((previous) => ({ ...previous, discipline_id: event.target.value }))}
                        >
                            <option value="">Дисциплина</option>
                            {disciplines.map((discipline) => <option key={discipline.id} value={discipline.id}>{discipline.name}</option>)}
                        </select>
                        <select
                            className="form-input"
                            value={planForm.lesson_type}
                            onChange={(event) => setPlanForm((previous) => ({ ...previous, lesson_type: event.target.value }))}
                        >
                            {LESSON_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                        <select
                            className="form-input"
                            value={planForm.group_id}
                            onChange={(event) => setPlanForm((previous) => ({ ...previous, group_id: event.target.value }))}
                        >
                            <option value="">Группа</option>
                            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                        </select>
                        <select
                            className="form-input load-subgroup-input"
                            value={planForm.subgroup}
                            onChange={(event) => setPlanForm((previous) => ({ ...previous, subgroup: event.target.value }))}
                        >
                            <option value="0">Вся группа</option>
                            <option value="1">1 п/г</option>
                            <option value="2">2 п/г</option>
                        </select>
                        <input
                            type="number"
                            min="1"
                            className="form-input load-hours-input"
                            placeholder="Часов"
                            value={planForm.planned_hours}
                            onChange={(event) => setPlanForm((previous) => ({ ...previous, planned_hours: event.target.value }))}
                        />
                        <button type="submit" className="btn btn-primary">Добавить в план</button>
                    </form>
                    )}

                    <div className="load-plan-toolbar">
                        <div className="load-plan-search">
                            <SearchIcon />
                            <input
                                type="search"
                                placeholder="Поиск по преподавателю или дисциплине"
                                value={filterQuery}
                                onChange={(event) => setFilterQuery(event.target.value)}
                            />
                        </div>
                        <select
                            className="form-input load-plan-group-filter"
                            value={filterGroupId}
                            onChange={(event) => setFilterGroupId(event.target.value)}
                        >
                            <option value="">Все группы</option>
                            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                        </select>
                        {(filterQuery || filterGroupId) && (
                            <span className="load-plan-filter-active">
                                показано {visibleRows.length} из {loadPlan.length}
                                <button
                                    type="button"
                                    className="btn-link load-plan-filter-clear"
                                    onClick={() => { setFilterQuery(''); setFilterGroupId(''); }}
                                >
                                    ✕ показать все
                                </button>
                            </span>
                        )}
                    </div>

                    <div className="lessons-table-wrapper">
                        <table className="lessons-table load-plan-table">
                            <thead>
                                <tr>
                                    <th>Преподаватель</th>
                                    <th>Дисциплина</th>
                                    <th>Вид</th>
                                    <th>Группа</th>
                                    <th>Часы</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {visibleRows.map((row) => (
                                    <PlanRow
                                        key={row.id}
                                        row={row}
                                        teachers={teachers}
                                        disciplines={disciplines}
                                        groups={groups}
                                        isEditing={editingPlanId === row.id}
                                        onSaveEdit={saveEditRow}
                                        onCancelEdit={cancelEditRow}
                                        onStartEdit={startEditRow}
                                        onUpdateHours={updatePlannedHours}
                                        isClosed={Boolean(viewedSemester.closed)}
                                        isMenuOpen={openMenuId === row.id}
                                        onToggleMenu={toggleRowMenu}
                                        onScheduleMenuClose={scheduleMenuClose}
                                        onDelete={deletePlanRow}
                                    />
                                ))}
                            </tbody>
                        </table>
                        {loadPlan.length === 0 && (
                            <p className="empty-message">План на этот семестр пока пуст.</p>
                        )}
                        {loadPlan.length > 0 && visibleRows.length === 0 && (
                            <p className="empty-message">По этому запросу ничего не найдено.</p>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// Memoized so opening/closing one row's kebab menu or edit form
// doesn't re-render the other 100+ rows in the table — before this, every
// click on any row's "⋯" re-rendered the entire plan (132 rows on a real
// semester), which is exactly the visible lag that prompted this split.
function buildEditFormFromRow(row) {
    return {
        teacher_id: String(row.teacher_id),
        discipline_id: String(row.discipline_id),
        lesson_type: row.lesson_type,
        group_id: String(row.group_id),
        subgroup: String(row.subgroup),
        planned_hours: row.planned_hours === null ? '' : String(row.planned_hours)
    };
}

const PlanRow = memo(function PlanRow({
    row, teachers, disciplines, groups, isClosed,
    isEditing, onSaveEdit, onCancelEdit, onStartEdit, onUpdateHours,
    isMenuOpen, onToggleMenu, onScheduleMenuClose, onDelete
}) {
    // Lives here, not in the parent — otherwise every keystroke while editing
    // one row would change that row's callback identities and, without care,
    // ripple into a re-render of the other 100+ rows too.
    const [draft, setDraft] = useState(null);
    const form = draft ?? buildEditFormFromRow(row);

    // Covers leaving edit mode any other way than the Cancel button — e.g.
    // opening "Изменить" on a different row while this one was mid-edit —
    // so a later re-open of this row starts from the real row, not a stale
    // abandoned draft.
    useEffect(() => {
        if (!isEditing) setDraft(null);
    }, [isEditing]);

    async function handleSave() {
        const ok = await onSaveEdit(row.id, form);
        if (ok) setDraft(null);
    }

    function handleCancel() {
        setDraft(null);
        onCancelEdit();
    }

    return (
        <Fragment>
            {isEditing ? (
                <tr className="load-edit-row">
                    <td>
                        <select
                            className="form-input"
                            value={form.teacher_id}
                            onChange={(event) => setDraft({ ...form, teacher_id: event.target.value })}
                        >
                            {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.full_name}</option>)}
                        </select>
                    </td>
                    <td>
                        <select
                            className="form-input"
                            value={form.discipline_id}
                            onChange={(event) => setDraft({ ...form, discipline_id: event.target.value })}
                        >
                            {disciplines.map((discipline) => <option key={discipline.id} value={discipline.id}>{discipline.name}</option>)}
                        </select>
                    </td>
                    <td>
                        <select
                            className="form-input"
                            value={form.lesson_type}
                            onChange={(event) => setDraft({ ...form, lesson_type: event.target.value })}
                        >
                            {LESSON_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                    </td>
                    <td>
                        <div className="load-edit-group-cell">
                            <select
                                className="form-input"
                                value={form.group_id}
                                onChange={(event) => setDraft({ ...form, group_id: event.target.value })}
                            >
                                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                            </select>
                            <select
                                className="form-input load-edit-subgroup"
                                value={form.subgroup}
                                onChange={(event) => setDraft({ ...form, subgroup: event.target.value })}
                            >
                                <option value="0">Вся группа</option>
                                <option value="1">1 п/г</option>
                                <option value="2">2 п/г</option>
                            </select>
                        </div>
                    </td>
                    <td>
                        <input
                            type="number"
                            min="1"
                            className="form-input load-edit-hours"
                            placeholder="часы"
                            value={form.planned_hours}
                            onChange={(event) => setDraft({ ...form, planned_hours: event.target.value })}
                        />
                    </td>
                    <td className="load-edit-actions">
                        <button type="button" className="btn btn-primary load-edit-save" onClick={handleSave}>
                            Сохранить
                        </button>
                        <button type="button" className="btn-link" onClick={handleCancel}>
                            Отмена
                        </button>
                    </td>
                </tr>
            ) : (
                <tr>
                    <td>{row.teacher_name}</td>
                    <td>{row.discipline_name}</td>
                    <td><span className="load-type-badge">{row.lesson_type}</span></td>
                    <td>{row.group_name}{row.subgroup ? ` (${row.subgroup} п/г)` : ''}</td>
                    <td>
                        {row.planned_hours === null ? (
                            isClosed ? <span className="load-hours-empty">—</span> : <HoursEditor onSave={(hours) => onUpdateHours(row.id, hours)} />
                        ) : (
                            <div className="load-progress-cell">
                                <span className="load-hours-figure">{row.planned_hours} ч</span>
                                <div className="load-progress-track">
                                    <div
                                        className="load-progress-fill"
                                        style={{ width: `${Math.min(100, Math.round((row.progress?.occurred_hours || 0) / row.planned_hours * 100))}%` }}
                                    />
                                </div>
                            </div>
                        )}
                    </td>
                    <td className="load-row-menu-cell">
                        {!isClosed && (
                        <div className="load-row-menu" onBlur={onScheduleMenuClose}>
                            <button
                                type="button"
                                className="load-row-menu-trigger"
                                aria-label="Действия"
                                onClick={() => onToggleMenu(row.id)}
                            >
                                ⋯
                            </button>
                            {isMenuOpen && (
                                <div className="load-row-menu-dropdown">
                                    <button type="button" className="load-row-menu-item" onClick={() => onStartEdit(row)}>
                                        Изменить
                                    </button>
                                    <button type="button" className="load-row-menu-item danger" onClick={() => onDelete(row.id)}>
                                        Удалить
                                    </button>
                                </div>
                            )}
                        </div>
                        )}
                    </td>
                </tr>
            )}
        </Fragment>
    );
});

/**
 * Turns "18 недель" into the dates it actually means, shown right next to the
 * number: a count that runs the last teaching week through New Year is obvious
 * on sight, while the bare "18" is not.
 */
function formatWeekRange(startDate, weeksCount) {
    if (!startDate || !Number.isInteger(weeksCount) || weeksCount < 1) {
        return '—';
    }

    const [year, month, day] = startDate.split('-').map(Number);
    const monday = new Date(Date.UTC(year, month - 1, day + (weeksCount - 1) * 7));
    const saturday = new Date(monday.getTime() + 5 * 86400000);
    const short = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

    return `${short(monday)}–${short(saturday)}.${saturday.getUTCFullYear()}`;
}

function parityLabel(parity) {
    return parity === 1 ? 'нечётная' : 'чётная';
}

/** The picked parity, else the calendar default for the chosen start date. */
function resolveNewSemesterParity(form) {
    if (form.first_week_parity === 1 || form.first_week_parity === 2) {
        return form.first_week_parity;
    }

    if (!form.start_date) {
        return undefined;
    }

    const [year, month, day] = form.start_date.split('-').map(Number);
    return getWeekTypeNumber(new Date(year, month - 1, day));
}

function pluralizeRecords(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'запись';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'записи';
    return 'записей';
}

function SearchIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16zM19 19l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

// Shown instead of a progress bar for a plan row that has no hours yet — e.g.
// one auto-created from an imported schedule, before the specialist has
// entered what the department actually assigned.
function HoursEditor({ onSave }) {
    const [value, setValue] = useState('');

    return (
        <form
            className="load-hours-editor"
            onSubmit={(event) => {
                event.preventDefault();
                onSave(value);
            }}
        >
            <span className="load-hours-editor-label">часы не заданы</span>
            <input
                type="number"
                min="1"
                max="2000"
                placeholder="часы"
                value={value}
                onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="btn-link">задать</button>
        </form>
    );
}

function emptyPlanForm() {
    return {
        teacher_id: '',
        discipline_id: '',
        lesson_type: LESSON_TYPES[0],
        group_id: '',
        subgroup: '0',
        planned_hours: ''
    };
}
