// The groups of one plan row. Usually one; a stream — one pair taught to
// several groups at once, e.g. 23303 / 23313 — gets more through «+ группа».
// `value` is an array of group ids as strings ('' for a group not picked yet);
// with allowEmpty (the constructor's «Ещё группы») it may hold none at all.
export default function GroupsField({ groups, value, onChange, allowEmpty = false }) {
    const setAt = (index, groupId) => onChange(value.map((current, i) => (i === index ? groupId : current)));
    const removeAt = (index) => onChange(value.filter((_, i) => i !== index));

    return (
        <div className="load-groups-field">
            {value.map((groupId, index) => (
                <span key={index} className="load-groups-item">
                    <select
                        className="form-input"
                        value={groupId}
                        aria-label={index === 0 ? 'Группа' : `Группа ${index + 1}`}
                        onChange={(event) => setAt(index, event.target.value)}
                    >
                        <option value="">{index === 0 ? 'Группа' : 'Ещё группа'}</option>
                        {groups
                            .filter((group) => String(group.id) === groupId || !value.includes(String(group.id)))
                            .map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                    </select>
                    {value.length > (allowEmpty ? 0 : 1) && (
                        <button
                            type="button"
                            className="load-groups-remove"
                            aria-label="Убрать группу"
                            title="Убрать группу"
                            onClick={() => removeAt(index)}
                        >
                            ×
                        </button>
                    )}
                </span>
            ))}
            {value.length < 8 && (
                <button
                    type="button"
                    className="btn-link load-groups-add"
                    title="Пара идёт сразу у нескольких групп (поток)"
                    onClick={() => onChange([...value, ''])}
                >
                    + группа
                </button>
            )}
        </div>
    );
}
