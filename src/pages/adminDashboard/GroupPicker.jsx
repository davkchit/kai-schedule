import { useEffect, useRef, useState } from 'react';

// The builder's group choice: a field that lists every group on focus and
// narrows as you type ("233" → 23301, 23303, 23313), like the pickers in the
// lesson form — a plain <select> of a dozen-plus look-alike numbers had to be
// scrolled through by eye. Arrows and Enter pick, Esc closes; leaving the field
// without a pick keeps the group that was already chosen.
export default function GroupPicker({ groups, value, onChange }) {
    const selected = groups.find((group) => String(group.id) === String(value)) || null;
    // The university only when there is more than one to tell apart —
    // otherwise it is the same prefix on every line and crowds a phone screen.
    const hasSeveralUniversities = new Set(groups.map((group) => group.university)).size > 1;
    const labelOf = (group) => (hasSeveralUniversities ? `${group.university} — ${group.name}` : group.name);

    const [query, setQuery] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const containerRef = useRef(null);
    const listRef = useRef(null);

    const normalizedQuery = query.trim().toLowerCase();
    const matches = normalizedQuery
        ? groups.filter((group) => labelOf(group).toLowerCase().includes(normalizedQuery))
        : groups;

    useEffect(() => {
        function handleOutsideClick(event) {
            if (containerRef.current && !containerRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        }

        document.addEventListener('mousedown', handleOutsideClick);
        return () => document.removeEventListener('mousedown', handleOutsideClick);
    }, []);

    // Keep the highlighted option in view while moving with the arrows.
    useEffect(() => {
        const option = listRef.current?.children[highlight];
        option?.scrollIntoView({ block: 'nearest' });
    }, [highlight, isOpen]);

    function open() {
        setQuery('');
        setIsOpen(true);
        const index = groups.findIndex((group) => String(group.id) === String(value));
        setHighlight(index >= 0 ? index : 0);
    }

    function pick(group) {
        onChange(String(group.id));
        setQuery('');
        setIsOpen(false);
    }

    function handleKeyDown(event) {
        if (!isOpen && (event.key === 'ArrowDown' || event.key === 'Enter')) {
            event.preventDefault();
            open();
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setHighlight((index) => Math.min(index + 1, matches.length - 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setHighlight((index) => Math.max(index - 1, 0));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (matches[highlight]) pick(matches[highlight]);
        } else if (event.key === 'Escape') {
            setQuery('');
            setIsOpen(false);
        }
    }

    return (
        <div className="group-picker" ref={containerRef}>
            <input
                type="text"
                className="group-select group-picker-input"
                placeholder={selected ? labelOf(selected) : 'Выберите группу'}
                aria-label="Группа"
                autoComplete="off"
                value={isOpen ? query : (selected ? labelOf(selected) : '')}
                onFocus={open}
                onClick={() => { if (!isOpen) open(); }}
                onChange={(event) => {
                    setQuery(event.target.value);
                    setHighlight(0);
                    setIsOpen(true);
                }}
                onKeyDown={handleKeyDown}
                // Option clicks prevent the blur (mousedown), so this is only
                // leaving by Tab or a click elsewhere — nothing picked, list closes.
                onBlur={() => setIsOpen(false)}
            />
            <svg className="group-picker-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {isOpen && (
                <div className="dict-picker-list group-picker-list" ref={listRef} role="listbox">
                    {matches.map((group, index) => (
                        <button
                            type="button"
                            key={group.id}
                            role="option"
                            aria-selected={String(group.id) === String(value)}
                            className={`dict-picker-option ${String(group.id) === String(value) ? 'selected' : ''} ${index === highlight ? 'is-highlighted' : ''}`}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                pick(group);
                            }}
                            onMouseEnter={() => setHighlight(index)}
                        >
                            {labelOf(group)}
                        </button>
                    ))}
                    {matches.length === 0 && <p className="dict-picker-empty">Нет такой группы</p>}
                </div>
            )}
        </div>
    );
}
