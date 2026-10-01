import { Fragment, memo, useEffect, useState } from 'react';
import { LESSON_TYPES } from './constants';
import GroupsField from './GroupsField';

// Memoized so opening/closing one row's kebab menu or edit form
// doesn't re-render the other 100+ rows in the table — before this, every
// click on any row's "⋯" re-rendered the entire plan (132 rows on a real
// semester), which is exactly the visible lag that prompted this split.
function buildEditFormFromRow(row) {
    return {
        teacher_id: String(row.teacher_id),
        discipline_id: String(row.discipline_id),
        lesson_type: row.lesson_type,
        group_ids: (row.group_ids || [row.group_id]).map(String),
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
                            <GroupsField
                                groups={groups}
                                value={form.group_ids}
                                onChange={(groupIds) => setDraft({ ...form, group_ids: groupIds })}
                            />
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

export default PlanRow;

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
