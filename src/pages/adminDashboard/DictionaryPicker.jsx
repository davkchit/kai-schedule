import { useEffect, useRef, useState } from 'react';

// A search-as-you-type picker backed by a dictionary table (teachers or
// disciplines). Picking from the list (or adding a new entry) is what lets
// hours match automatically, with no separate "link this pair" step — the
// schedule and the load plan then point at the very same row, so they can
// never show the same person under two different spellings.
//
// Typing is still free text, kept live in this component's own state rather
// than pushed to the parent on every keystroke — an id/text pair that drifted
// apart mid-typing would be meaningless anyway. It resolves on blur: an exact
// match (case-insensitive) is picked automatically, anything else is kept as
// plain text with no id — same as before, just untracked — rather than
// silently reverting to whatever was selected before this edit.
//
// listOnly: typing only searches. A value is what was picked from the list
// (or typed exactly as a list entry); anything else is dropped on blur, so a
// pair can never carry a misspelt subject or teacher that counts for nobody.
export default function DictionaryPicker({
    id, label, placeholder, options, valueId, valueText, onChange, onCreate, listOnly = false,
    untrackedHint = 'Часы по этой паре не посчитаются, пока не выбрано из списка'
}) {
    const [query, setQuery] = useState(valueText || '');
    const [isOpen, setIsOpen] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const containerRef = useRef(null);

    useEffect(() => {
        setQuery(valueText || '');
    }, [valueId, valueText]);

    useEffect(() => {
        function handleOutsideClick(event) {
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        }

        document.addEventListener('mousedown', handleOutsideClick);
        return () => document.removeEventListener('mousedown', handleOutsideClick);
    }, []);

    const normalizedQuery = query.trim().toLowerCase();
    const matches = normalizedQuery
        ? options.filter((option) => option.label.toLowerCase().includes(normalizedQuery))
        : options;
    const exactMatch = options.find((option) => option.label.toLowerCase() === normalizedQuery);
    // Nothing left to choose once the text is exactly an entry (just picked,
    // or a filled field focused again): an open list then only lies over the
    // form below it — «Сохранить» right under it took the first click as a
    // pick. Typing anything else opens it again.
    const showList = isOpen && !(normalizedQuery && exactMatch);

    function pick(option) {
        onChange(option);
        setQuery(option.label);
        setIsOpen(false);
    }

    async function handleCreate() {
        const name = query.trim();

        if (!name || isCreating) {
            return;
        }

        setIsCreating(true);

        try {
            const created = await onCreate(name);

            if (created) {
                pick(created);
            }
        } finally {
            setIsCreating(false);
        }
    }

    function handleBlur() {
        // A click on an option or "add new" fires its own mousedown (with
        // preventDefault, so this blur never even happens for those); this is
        // only reached by tabbing or clicking elsewhere with no pick made.
        // Resolved right away, not after a delay: the blur of a click on the
        // form's «Добавить» comes just before its submit, and a delayed
        // resolve lost the typed text — «Предмет не должно быть пустым».
        const trimmed = query.trim();

        if (!trimmed) {
            if (valueId !== null || (valueText || '') !== '') onChange(null);
            return;
        }

        if (exactMatch) {
            if (exactMatch.id !== valueId) pick(exactMatch);
            return;
        }

        if (listOnly) {
            // Not a list entry: back to what was picked before, or empty.
            setQuery(valueId !== null && valueId !== undefined ? valueText || '' : '');
            if (valueId === null || valueId === undefined) {
                if ((valueText || '') !== '') onChange(null);
            }
            return;
        }

        // No match: keep it as plain text, same as typing always used to
        // work — just with no id, so it won't be matched for hours.
        if (valueId !== null || trimmed !== (valueText || '')) {
            onChange({ id: null, label: trimmed });
        }
    }

    return (
        <div className="form-row dict-picker" ref={containerRef}>
            <label htmlFor={id}>{label}</label>
            <input
                type="text"
                id={id}
                className="form-input"
                placeholder={placeholder}
                autoComplete="off"
                value={query}
                onFocus={() => setIsOpen(true)}
                onBlur={handleBlur}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') setIsOpen(false);
                }}
                onChange={(event) => {
                    setQuery(event.target.value);
                    setIsOpen(true);
                }}
            />
            {!valueId && (
                <span className="dict-picker-hint">
                    {listOnly
                        ? 'Начните вводить и выберите из списка'
                        : (query.trim() ? untrackedHint : 'Начните вводить имя')}
                </span>
            )}
            {showList && (
                <div className="dict-picker-list">
                    {matches.slice(0, 30).map((option) => (
                        <button
                            type="button"
                            key={option.id}
                            className={`dict-picker-option ${option.id === valueId ? 'selected' : ''}`}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                pick(option);
                            }}
                        >
                            {option.label}
                        </button>
                    ))}
                    {matches.length === 0 && !normalizedQuery && (
                        <p className="dict-picker-empty">Список пуст — начните вводить, чтобы добавить</p>
                    )}
                    {normalizedQuery && !exactMatch && (
                        <button
                            type="button"
                            className="dict-picker-option dict-picker-create"
                            disabled={isCreating}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                handleCreate();
                            }}
                        >
                            {isCreating ? 'Добавляем…' : `+ Добавить «${query.trim()}»`}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
