import { useEffect, useMemo, useRef, useState } from 'react';
import DictionaryPicker from './DictionaryPicker';

// Сессия: экзамены, зачёты и консультации (server/utils/attestations.js).
// Students see them on their dates in orange, teachers on their own page;
// here the specialist enters them, sees how many each teacher has, and downloads the
// two Excel documents the branch publishes. They are counted, never turned into hours.
// Keeps its own state, like AdminLoadSection: nothing else on the page needs it.

export const ATTESTATION_KINDS = [
    { kind: 'exam', label: 'Экзамен', plural: 'Экзамены' },
    { kind: 'credit', label: 'Зачёт', plural: 'Зачёты' },
    { kind: 'consultation', label: 'Консультация', plural: 'Консультации' }
];
const KIND_LABEL = Object.fromEntries(ATTESTATION_KINDS.map(({ kind, label }) => [kind, label]));

const EMPTY_FORM = {
    id: null, kind: 'exam', group_id: '', subgroup: 0, date: '', time_start: '', time_end: '', room: '',
    discipline_id: null, subject: '', teacher_id: null, teacher: ''
};

function formatDay(isoDate) {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
}

export default function AttestationsSection({
    activeSection, api, groups, teachers, disciplines, onCreateTeacher, onCreateDiscipline, setToastMessage
}) {
    const [semesters, setSemesters] = useState([]);
    const [semester, setSemester] = useState(null);
    const [items, setItems] = useState([]);
    const [byTeacher, setByTeacher] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);

    const [form, setForm] = useState(null);
    const [isSaving, setIsSaving] = useState(false);

    const [kindFilter, setKindFilter] = useState('all');
    const [groupFilter, setGroupFilter] = useState('');
    const [query, setQuery] = useState('');

    const [exporting, setExporting] = useState(null);
    const formRef = useRef(null);

    // The form opens above the list: bring it into view when a row far below is edited.
    useEffect(() => {
        if (form) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [form?.id, Boolean(form)]); // eslint-disable-line react-hooks/exhaustive-deps

    const isActive = activeSection === 'session';

    useEffect(() => {
        if (isActive && !hasLoaded) {
            setHasLoaded(true);
            loadSemesters();
            load(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive]);

    async function loadSemesters() {
        try {
            const response = await api('/api/admin/semesters');
            const data = await response.json();
            setSemesters(Array.isArray(data) ? data : []);
        } catch {
            // The list only feeds the semester switch; the section works without it.
        }
    }

    async function load(semesterId) {
        setIsLoading(true);

        try {
            const response = await api(`/api/admin/attestations${semesterId ? `?semester_id=${semesterId}` : ''}`);
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось загрузить сессию');
                return;
            }

            setSemester(data.semester);
            setItems(data.items || []);
            setByTeacher(data.by_teacher || []);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Не удалось загрузить сессию');
        } finally {
            setIsLoading(false);
        }
    }

    const reload = () => load(semester?.id || null);

    const visibleItems = useMemo(() => {
        const needle = query.trim().toLowerCase();

        return items.filter((item) => (kindFilter === 'all' || item.kind === kindFilter)
            && (!groupFilter || String(item.group_id) === groupFilter)
            && (!needle || `${item.subject} ${item.teacher || ''} ${item.group_name}`.toLowerCase().includes(needle)));
    }, [items, kindFilter, groupFilter, query]);

    const groupOptions = useMemo(() => {
        const ids = new Set(items.map((item) => item.group_id));
        return groups.filter((group) => ids.has(group.id));
    }, [groups, items]);

    const withWarnings = useMemo(() => items.filter((item) => item.warnings?.length).length, [items]);

    const kindCounts = useMemo(() => Object.fromEntries(
        ATTESTATION_KINDS.map(({ kind }) => [kind, items.filter((item) => item.kind === kind).length])
    ), [items]);

    function startCreate() {
        setForm({ ...EMPTY_FORM, group_id: groupFilter || '' });
    }

    function startEdit(item) {
        setForm({
            id: item.id,
            kind: item.kind,
            group_id: String(item.group_id),
            subgroup: item.subgroup,
            date: item.date,
            time_start: item.time_start,
            time_end: item.time_end || '',
            room: item.room || '',
            discipline_id: item.discipline_id,
            subject: item.subject || '',
            teacher_id: item.teacher_id,
            teacher: item.teacher || ''
        });
    }

    async function submitForm(event, confirm = false, removePairs = false) {
        event?.preventDefault();
        setIsSaving(true);

        try {
            const response = await api(form.id ? `/api/admin/attestations/${form.id}` : '/api/admin/attestations', {
                method: form.id ? 'PUT' : 'POST',
                body: JSON.stringify({
                    kind: form.kind,
                    group_id: Number(form.group_id),
                    subgroup: Number(form.subgroup) || 0,
                    date: form.date,
                    time_start: form.time_start,
                    time_end: form.time_end || null,
                    room: form.room,
                    discipline_id: form.discipline_id,
                    discipline_text: form.subject,
                    teacher_id: form.teacher_id,
                    teacher_text: form.teacher,
                    confirm,
                    remove_pairs: removePairs
                })
            });
            const data = await response.json();

            // A pair at that time, the teacher or the room busy…: the server
            // names it, and saving anyway is the specialist's call.
            if (response.status === 409 && data.needs_confirm) {
                if (!window.confirm(`Обратите внимание:\n\n• ${data.warnings.join('\n• ')}\n\nСохранить всё равно?`)) {
                    return;
                }

                // A pair left under the exam would still count toward the
                // teacher's hours. Taking it out of that one day is offered,
                // never done silently.
                const pairs = data.covered_pairs || [];
                const removePairsToo = pairs.length > 0 && window.confirm(
                    `У группы в это время ${pairs.length > 1 ? 'пары' : 'пара'}: ${pairs.map((pair) => `${pair.subject} ${pair.time_start}`).join(', ')}.\n\n`
                    + 'Убрать её в этот день? Тогда студенты увидят только запись сессии, а пара не засчитается преподавателю.\n\n'
                    + 'ОК — убрать пару, Отмена — оставить её.'
                );
                await submitForm(null, true, removePairsToo);
                return;
            }

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось сохранить');
                return;
            }

            setToastMessage((form.id ? 'Изменения сохранены' : `${KIND_LABEL[form.kind]} добавлен${form.kind === 'consultation' ? 'а' : ''}`)
                + (data.restored_pairs > 0 ? ` — пара на прежнем месте возвращена (${data.restored_pairs})` : '')
                + (data.removed_pairs > 0 ? ` — пара в этот день убрана (${data.removed_pairs})` : ''));
            setForm(null);
            // The date may have moved it into another semester: show that one.
            await load(data.semester_id);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
        } finally {
            setIsSaving(false);
        }
    }

    async function remove(item) {
        if (!window.confirm(`Удалить: ${KIND_LABEL[item.kind].toLowerCase()} «${item.subject}», ${item.group_name}, ${formatDay(item.date)}?`)) return;

        try {
            const response = await api(`/api/admin/attestations/${item.id}`, { method: 'DELETE' });
            const data = await response.json();

            if (!response.ok) {
                setToastMessage(data.error || 'Не удалось удалить');
                return;
            }

            if (form?.id === item.id) setForm(null);
            if (data.restored_pairs > 0) setToastMessage(`Удалено — пара в этот день возвращена (${data.restored_pairs})`);
            await reload();
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
        }
    }

    // The same two documents the branch has always published, built from what is entered here.
    async function downloadExport(type) {
        setExporting(type);

        try {
            const params = new URLSearchParams({ type });
            if (semester) params.set('semester_id', semester.id);
            const response = await api(`/api/admin/attestations/export?${params}`);

            if (!response.ok) {
                const data = await response.json();
                setToastMessage(data.error || 'Не удалось сформировать файл');
                return;
            }

            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = type === 'session' ? 'Расписание промежуточной аттестации.xlsx' : 'Расписание консультаций.xlsx';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
        } finally {
            setExporting(null);
        }
    }

    const teacherOptions = useMemo(() => teachers.map((teacher) => ({ id: teacher.id, label: teacher.full_name })), [teachers]);
    const disciplineOptions = useMemo(() => disciplines.map((discipline) => ({ id: discipline.id, label: discipline.name })), [disciplines]);

    return (
        <section className={`content-section ${isActive ? 'active' : ''}`} id="sectionSession">
            <div className="audit-header">
                <div>
                    <div className="section-heading att-heading">
                        <h2 className="section-title">Сессия</h2>
                        {semesters.length > 1 && semester ? (
                            <select
                                className="form-input att-semester-select"
                                aria-label="Семестр"
                                value={String(semester.id)}
                                onChange={(event) => load(Number(event.target.value))}
                            >
                                {semesters.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}
                            </select>
                        ) : semester && <span className="semester-badge">{semester.label}</span>}
                        {semester?.closed && <span className="sem-badge is-closed">Закрыт</span>}
                    </div>
                    <p className="section-desc">
                        Экзамены, зачёты и консультации. Студенты видят их в расписании, преподаватели — на своей странице.
                        В часы нагрузки они не входят: здесь считается, сколько их у каждого преподавателя.
                    </p>
                </div>
                <div className="section-actions">
                    <button type="button" className="btn btn-secondary" disabled={!kindCounts.exam && !kindCounts.credit || exporting !== null} onClick={() => downloadExport('session')}>
                        {exporting === 'session' ? 'Готовим…' : 'Экспорт зачётов и экзаменов'}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={!kindCounts.consultation || exporting !== null} onClick={() => downloadExport('consultations')}>
                        {exporting === 'consultations' ? 'Готовим…' : 'Экспорт консультаций'}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={semester?.closed} onClick={startCreate}>
                        + Добавить
                    </button>
                </div>
            </div>

            {form && (
                <form className="att-card" ref={formRef} onSubmit={submitForm}>
                    <p className="sem-form-title">{form.id ? 'Изменить' : 'Новая запись'}</p>
                    <div className="att-kind-switch" role="radiogroup" aria-label="Вид">
                        {ATTESTATION_KINDS.map(({ kind, label }) => (
                            <button
                                key={kind}
                                type="button"
                                role="radio"
                                aria-checked={form.kind === kind}
                                className={`att-kind-option ${form.kind === kind ? 'is-active' : ''}`}
                                onClick={() => setForm((previous) => ({ ...previous, kind }))}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="sem-form-grid att-form-grid">
                        <label>
                            <span className="sem-field-label">Группа</span>
                            <select
                                className="form-input"
                                required
                                value={form.group_id}
                                onChange={(event) => setForm((previous) => ({ ...previous, group_id: event.target.value }))}
                            >
                                <option value="">Выберите группу</option>
                                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                            </select>
                        </label>
                        <label>
                            <span className="sem-field-label">Подгруппа</span>
                            <select
                                className="form-input"
                                value={form.subgroup}
                                onChange={(event) => setForm((previous) => ({ ...previous, subgroup: Number(event.target.value) }))}
                            >
                                <option value={0}>Вся группа</option>
                                <option value={1}>1 подгруппа</option>
                                <option value={2}>2 подгруппа</option>
                            </select>
                        </label>
                        <label>
                            <span className="sem-field-label">Дата</span>
                            <input
                                type="date"
                                className="form-input"
                                required
                                value={form.date}
                                onChange={(event) => setForm((previous) => ({ ...previous, date: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">Начало</span>
                            <input
                                type="time"
                                className="form-input"
                                required
                                value={form.time_start}
                                onChange={(event) => setForm((previous) => ({ ...previous, time_start: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">Конец (необязательно)</span>
                            <input
                                type="time"
                                className="form-input"
                                value={form.time_end}
                                onChange={(event) => setForm((previous) => ({ ...previous, time_end: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">Аудитория</span>
                            <input
                                type="text"
                                className="form-input"
                                value={form.room}
                                onChange={(event) => setForm((previous) => ({ ...previous, room: event.target.value }))}
                            />
                        </label>
                    </div>
                    <div className="att-pickers">
                        <DictionaryPicker
                            id="attestationDiscipline"
                            label="Дисциплина"
                            placeholder="Начните вводить название"
                            options={disciplineOptions}
                            valueId={form.discipline_id}
                            valueText={form.subject}
                            onChange={(picked) => setForm((previous) => ({
                                ...previous,
                                discipline_id: picked ? picked.id : null,
                                subject: picked ? picked.label : ''
                            }))}
                            onCreate={onCreateDiscipline}
                            untrackedHint="Нет в справочнике — сохранится текстом"
                        />
                        <DictionaryPicker
                            id="attestationTeacher"
                            label="Преподаватель"
                            placeholder="Например: Кузнецов Н.П."
                            options={teacherOptions}
                            valueId={form.teacher_id}
                            valueText={form.teacher}
                            onChange={(picked) => setForm((previous) => ({
                                ...previous,
                                teacher_id: picked ? picked.id : null,
                                teacher: picked ? picked.label : ''
                            }))}
                            onCreate={onCreateTeacher}
                            untrackedHint="Не выбран из списка — преподаватель не увидит это на своей странице"
                        />
                    </div>
                    <div className="sem-actions">
                        <button type="submit" className="btn btn-primary btn-sm" disabled={isSaving}>
                            {isSaving ? 'Сохраняем…' : 'Сохранить'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(null)}>Отмена</button>
                    </div>
                </form>
            )}

            {byTeacher.length > 0 && (
                <>
                    <h3 className="subsection-title att-subtitle">По преподавателям</h3>
                    <div className="lessons-table-wrapper att-table-wrapper">
                        <table className="lessons-table att-teachers-table">
                            <thead>
                                <tr>
                                    <th>Преподаватель</th>
                                    {ATTESTATION_KINDS.map(({ kind, plural }) => <th key={kind} className="att-num">{plural}</th>)}
                                    <th className="att-num">Всего</th>
                                </tr>
                            </thead>
                            <tbody>
                                {byTeacher.map((row) => (
                                    <tr key={row.teacher_id ? `id-${row.teacher_id}` : `text-${row.teacher}`}>
                                        <td>
                                            {row.teacher || <span className="att-muted">Не указан</span>}
                                            {!row.teacher_id && row.teacher && (
                                                <span className="att-text-badge" title="Записан текстом, не из справочника — на странице преподавателя этого не видно">текстом</span>
                                            )}
                                        </td>
                                        {ATTESTATION_KINDS.map(({ kind }) => (
                                            <td key={kind} className="att-num">{row[kind] || <span className="att-muted">—</span>}</td>
                                        ))}
                                        <td className="att-num"><strong>{row.total}</strong></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            <h3 className="subsection-title att-subtitle">Все записи</h3>
            {withWarnings > 0 && (
                <p className="load-unconfirmed-note">
                    ⚠ Пересечений: {withWarnings}. Наведите на значок у записи, чтобы увидеть, с чем она пересекается
                    (пара в расписании группы, занятый преподаватель или аудитория, консультация после экзамена).
                </p>
            )}
            <div className="att-toolbar">
                <div className="att-kind-switch" role="tablist" aria-label="Вид">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={kindFilter === 'all'}
                        className={`att-kind-option ${kindFilter === 'all' ? 'is-active' : ''}`}
                        onClick={() => setKindFilter('all')}
                    >
                        Все <span className="att-count">{items.length}</span>
                    </button>
                    {ATTESTATION_KINDS.map(({ kind, plural }) => (
                        <button
                            key={kind}
                            type="button"
                            role="tab"
                            aria-selected={kindFilter === kind}
                            className={`att-kind-option ${kindFilter === kind ? 'is-active' : ''}`}
                            onClick={() => setKindFilter(kind)}
                        >
                            {plural} <span className="att-count">{kindCounts[kind]}</span>
                        </button>
                    ))}
                </div>
                <select className="form-input att-group-filter" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="Группа">
                    <option value="">Все группы</option>
                    {groupOptions.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
                <input
                    type="search"
                    className="form-input att-search"
                    placeholder="Дисциплина или преподаватель"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>

            <div className="lessons-table-wrapper att-table-wrapper">
                <table className="lessons-table att-table">
                    <thead>
                        <tr>
                            <th>Дата</th>
                            <th>Время</th>
                            <th>Группа</th>
                            <th>Вид</th>
                            <th>Дисциплина</th>
                            <th>Преподаватель</th>
                            <th>Ауд.</th>
                            <th aria-label="Действия" />
                        </tr>
                    </thead>
                    <tbody>
                        {visibleItems.map((item) => (
                            <tr key={item.id} className={form?.id === item.id ? 'is-editing' : ''}>
                                <td className="att-date">
                                    {formatDay(item.date)}
                                    {item.warnings?.length > 0 && (
                                        <span className="att-warning" title={item.warnings.join('\n')} aria-label={`Пересечения: ${item.warnings.join('; ')}`}>⚠</span>
                                    )}
                                </td>
                                <td className="att-num-left">{item.time_end ? `${item.time_start}–${item.time_end}` : item.time_start}</td>
                                <td>
                                    {item.group_name}
                                    {item.subgroup ? <span className="att-muted"> · {item.subgroup} п/г</span> : null}
                                </td>
                                <td><span className="att-kind-badge">{KIND_LABEL[item.kind]}</span></td>
                                <td>{item.subject}</td>
                                <td>
                                    {item.teacher || <span className="att-muted">—</span>}
                                    {item.teacher && !item.teacher_id && <span className="att-text-badge" title="Записан текстом, не из справочника">текстом</span>}
                                </td>
                                <td>{item.room || <span className="att-muted">—</span>}</td>
                                <td className="att-actions">
                                    {!semester?.closed && (
                                        <>
                                            <button type="button" className="btn-edit" onClick={() => startEdit(item)}>Изменить</button>
                                            <button type="button" className="btn-danger" onClick={() => remove(item)}>Удалить</button>
                                        </>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {visibleItems.length === 0 && (
                    <p className="empty-message">
                        {isLoading
                            ? 'Загрузка…'
                            : !semester
                                ? 'Семестра пока нет — создайте его в разделе «Нагрузка».'
                                : items.length === 0
                                    ? 'Записей пока нет — нажмите «+ Добавить».'
                                    : 'По этому фильтру ничего не найдено.'}
                    </p>
                )}
            </div>
        </section>
    );
}
