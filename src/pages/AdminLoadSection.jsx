import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LESSON_TYPES, REF_PREVIEW_COUNT } from './adminLoad/constants';
import { resolveNewSemesterParity } from './adminLoad/format';
import SemesterCard from './adminLoad/SemesterCard';
import ReferenceCards from './adminLoad/ReferenceCards';
import PlanSection from './adminLoad/PlanSection';

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
    // Pairs the schedule shows that no plan row claims — their hours are lost silently.
    const [unmatchedPairs, setUnmatchedPairs] = useState([]);
    // Plan rows that look like one stream entered per group — the teacher is paid twice for each pair.
    const [likelyStreams, setLikelyStreams] = useState([]);
    const [isEditingSemester, setIsEditingSemester] = useState(false);
    const [isAddingSemester, setIsAddingSemester] = useState(false);
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
    // Falling back to the first semester matters when none is the working one
    // — right after the very first one is created. Without it the select shows
    // that semester (the browser picks the first option) while the page holds
    // none, and re-picking the option fires no change event: the plan stays
    // behind "выберите семестр" with no way forward.
    const viewedSemester = semesters.find((semester) => semester.id === viewedSemesterId)
        || activeSemester
        || semesters[0]
        || null;

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

            const unmatched = await (await api(`/api/admin/load-plan/unmatched?semester_id=${semesterId}`)).json();
            setUnmatchedPairs(Array.isArray(unmatched.items) ? unmatched.items : []);
            setLikelyStreams(Array.isArray(unmatched.streams) ? unmatched.streams : []);
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
        // loadPlanForSemester closes over api/setToastMessage/setLoadPlan, none
        // of which change for the interactions this is memoized against (see PlanRow).
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            setViewedSemesterId(data.id);
            setNewSemester({ label: '', start_date: '', weeks_count: 18, first_week_parity: '' });
            setIsAddingSemester(false);
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

        const { teacher_id, discipline_id, lesson_type, planned_hours } = planForm;
        const groupIds = planForm.group_ids.filter(Boolean);

        if (!teacher_id || !discipline_id || groupIds.length === 0) {
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
                    group_ids: groupIds.map(Number),
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
                    group_ids: form.group_ids.filter(Boolean).map(Number),
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

    async function mergeStream(stream) {
        const label = `${stream.discipline_name} (${stream.lesson_type}), ${stream.teacher_name}`;
        const hours = stream.planned_hours.filter((value) => value !== null);
        const hoursNote = new Set(hours).size > 1
            ? `\n\nПлановые часы у строк разные (${hours.join(' и ')}) — останутся ${stream.planned_hours[0] ?? hours[0]}, поправьте при необходимости.`
            : '';

        if (!window.confirm(`Объединить в одну строку плана «${stream.group_names.join(' / ')}»?\n${label}\n\nОбщая пара будет считаться преподавателю один раз.${hoursNote}`)) {
            return;
        }

        try {
            const response = await api('/api/admin/load-plan/merge', {
                method: 'POST',
                body: JSON.stringify({ ids: stream.ids })
            });

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось объединить строки');
                return;
            }

            await refreshPlan();
            setToastMessage('Строки объединены в поток');
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') {
                setToastMessage('Ошибка сети');
            }
        }
    }

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
            if (filterGroupId && !(row.group_ids || [row.group_id]).map(String).includes(filterGroupId)) {
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

            <SemesterCard
                semesters={semesters}
                viewedSemester={viewedSemester}
                setViewedSemesterId={setViewedSemesterId}
                isEditingSemester={isEditingSemester}
                setIsEditingSemester={setIsEditingSemester}
                isAddingSemester={isAddingSemester}
                setIsAddingSemester={setIsAddingSemester}
                semesterEdit={semesterEdit}
                setSemesterEdit={setSemesterEdit}
                newSemester={newSemester}
                setNewSemester={setNewSemester}
                startEditSemester={startEditSemester}
                saveSemesterEdit={saveSemesterEdit}
                activateSemester={activateSemester}
                reopenSemester={reopenSemester}
                closeSemester={closeSemester}
                addSemester={addSemester}
            />

            <ReferenceCards
                teachers={teachers}
                disciplines={disciplines}
                visibleTeachers={visibleTeachers}
                visibleDisciplines={visibleDisciplines}
                newTeacherName={newTeacherName}
                setNewTeacherName={setNewTeacherName}
                newDisciplineName={newDisciplineName}
                setNewDisciplineName={setNewDisciplineName}
                addTeacher={addTeacher}
                addDiscipline={addDiscipline}
                renameTeacher={renameTeacher}
                deleteTeacher={deleteTeacher}
                renameDiscipline={renameDiscipline}
                deleteDiscipline={deleteDiscipline}
                showAllTeachers={showAllTeachers}
                setShowAllTeachers={setShowAllTeachers}
                showAllDisciplines={showAllDisciplines}
                setShowAllDisciplines={setShowAllDisciplines}
            />

            <PlanSection
                viewedSemester={viewedSemester}
                isLoading={isLoading}
                semesters={semesters}
                planStats={planStats}
                unconfirmedWeeks={unconfirmedWeeks}
                unmatchedPairs={unmatchedPairs}
                likelyStreams={likelyStreams}
                mergeStream={mergeStream}
                planForm={planForm}
                setPlanForm={setPlanForm}
                submitPlanForm={submitPlanForm}
                teachers={teachers}
                disciplines={disciplines}
                groups={groups}
                filterQuery={filterQuery}
                setFilterQuery={setFilterQuery}
                filterGroupId={filterGroupId}
                setFilterGroupId={setFilterGroupId}
                visibleRows={visibleRows}
                loadPlan={loadPlan}
                editingPlanId={editingPlanId}
                saveEditRow={saveEditRow}
                cancelEditRow={cancelEditRow}
                startEditRow={startEditRow}
                updatePlannedHours={updatePlannedHours}
                openMenuId={openMenuId}
                toggleRowMenu={toggleRowMenu}
                scheduleMenuClose={scheduleMenuClose}
                deletePlanRow={deletePlanRow}
            />
        </div>
    );
}


function emptyPlanForm() {
    return {
        teacher_id: '',
        discipline_id: '',
        lesson_type: LESSON_TYPES[0],
        group_ids: [''],
        subgroup: '0',
        planned_hours: ''
    };
}
