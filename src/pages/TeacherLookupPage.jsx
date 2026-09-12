import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import usePageAssets from '../hooks/usePageAssets';

// Short badge + colour tone per lesson type. Keys match LESSON_TYPES in
// AdminLoadSection.jsx — anything the specialist types that isn't on this
// list still renders, just abbreviated and in the neutral tone.
const TYPE_META = {
    'Лекция': { short: 'Лек', tone: 'lec' },
    'Практика': { short: 'Пр', tone: 'pr' },
    'Лаб': { short: 'Лаб', tone: 'lab' },
    'Лабораторная': { short: 'Лаб', tone: 'lab' },
    'Консультация': { short: 'Конс', tone: 'kons' },
    'Зачёт': { short: 'Зач', tone: 'zach' },
    'Экзамен': { short: 'Экз', tone: 'exam' }
};

const WEEKDAY_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

export default function TeacherLookupPage() {
    const isAssetsReady = usePageAssets({
        title: 'Проверить свои часы',
        description: 'Преподаватель ищет себя по фамилии и видит, сколько часов по каждой дисциплине уже проведено.',
        stylesheets: ['/css/welcome.css', '/css/teacher-lookup.css']
    });

    const navigate = useNavigate();
    const debounceRef = useRef(null);

    const [inputValue, setInputValue] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [isInvalid, setIsInvalid] = useState(false);
    const [selectedTeacher, setSelectedTeacher] = useState(null);
    const [loadData, setLoadData] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [dayFilter, setDayFilter] = useState('all');
    const [listQuery, setListQuery] = useState('');

    useEffect(() => {
        if (selectedTeacher) {
            return undefined;
        }

        if (debounceRef.current) {
            window.clearTimeout(debounceRef.current);
        }

        const trimmed = inputValue.trim();

        if (!trimmed) {
            setSuggestions([]);
            return undefined;
        }

        debounceRef.current = window.setTimeout(async () => {
            try {
                const response = await fetch(`/api/teachers/search?q=${encodeURIComponent(trimmed)}`);
                const data = await response.json();
                setSuggestions(Array.isArray(data) ? data : []);
            } catch {
                setSuggestions([]);
            }
        }, 250);

        return () => {
            if (debounceRef.current) {
                window.clearTimeout(debounceRef.current);
            }
        };
    }, [inputValue, selectedTeacher]);

    // Mon–Sat of the calendar week the teacher is looking at this page in.
    // Derived from the browser clock alone: the day tabs only ever filter the
    // plan rows already fetched, so they need no extra server round-trip.
    const weekDays = useMemo(buildCurrentWeekDays, []);

    const planRows = loadData?.plan ?? [];

    const visibleRows = useMemo(() => {
        const normalizedQuery = listQuery.trim().toLowerCase();

        return planRows.filter((row) => {
            if (dayFilter !== 'all' && !row.occurrences.some((occurrence) => occurrence.date === dayFilter)) {
                return false;
            }

            if (!normalizedQuery) {
                return true;
            }

            const haystack = `${row.discipline_name} ${row.group_name} ${row.lesson_type}`.toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [planRows, dayFilter, listQuery]);

    const totals = useMemo(() => visibleRows.reduce(
        (accumulator, row) => ({
            occurred: accumulator.occurred + row.occurred_hours,
            // A row with no plan hours yet doesn't contribute to the planned
            // total — otherwise one unset row (auto-created from an imported
            // schedule, awaiting the specialist) would make the whole totals
            // line a meaningless partial number instead of just excluding it.
            planned: accumulator.planned + (row.planned_hours ?? 0),
            hasUnplanned: accumulator.hasUnplanned || row.planned_hours === null
        }),
        { occurred: 0, planned: 0, hasUnplanned: false }
    ), [visibleRows]);

    function flashValidationError() {
        setIsInvalid(true);
        window.setTimeout(() => setIsInvalid(false), 500);
    }

    async function selectTeacher(teacher) {
        setInputValue(teacher.full_name);
        setShowSuggestions(false);
        setSelectedTeacher(teacher);
        setIsLoading(true);
        setErrorMessage('');
        setDayFilter('all');
        setListQuery('');

        try {
            const response = await fetch(`/api/teachers/${teacher.id}/load`);

            if (!response.ok) {
                throw new Error('load-fetch-failed');
            }

            const data = await response.json();
            setLoadData(data);
        } catch {
            setErrorMessage('Не удалось загрузить данные. Попробуйте ещё раз.');
            setLoadData(null);
        } finally {
            setIsLoading(false);
        }
    }

    function handleSubmit(event) {
        event.preventDefault();
        const trimmed = inputValue.trim();

        if (!trimmed) {
            flashValidationError();
            return;
        }

        const exactMatch = suggestions.find(
            (teacher) => teacher.full_name.toLowerCase() === trimmed.toLowerCase()
        );

        if (exactMatch) {
            selectTeacher(exactMatch);
            return;
        }

        if (suggestions.length === 1) {
            selectTeacher(suggestions[0]);
            return;
        }

        flashValidationError();
    }

    function resetSearch() {
        setSelectedTeacher(null);
        setLoadData(null);
        setErrorMessage('');
        setInputValue('');
        setSuggestions([]);
        setDayFilter('all');
        setListQuery('');
    }

    if (!isAssetsReady) {
        return null;
    }

    const hasTable = Boolean(!isLoading && !errorMessage && loadData?.semester && planRows.length > 0);

    return (
        <div className={`tl-page ${hasTable ? 'is-wide' : ''}`}>
            <header className="tl-page-header">
                <img src="/assets/logo.png" alt="Логотип КАИ" />
            </header>

            <div className="background-circles">
                <div className="circle circle-1"></div>
                <div className="circle circle-2"></div>
                <div className="circle circle-3"></div>
                <div className="circle circle-4"></div>
            </div>

            <div className="container">
                <div className={`card ${selectedTeacher ? 'tl-card-results' : ''}`}>
                    {!selectedTeacher ? (
                        <>
                            <h1 className="title">Проверить свои часы</h1>
                            <p className="subtitle">Введите вашу фамилию</p>

                            <form onSubmit={handleSubmit}>
                                <button
                                    type="button"
                                    className="back-button"
                                    onClick={() => navigate('/')}
                                >
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M10 12L6 8L10 4" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                    На главную
                                </button>

                                <div className="search-container">
                                    <input
                                        type="text"
                                        className="search-input"
                                        placeholder="Например Хамидуллин"
                                        autoComplete="off"
                                        value={inputValue}
                                        onChange={(event) => {
                                            setInputValue(event.target.value);
                                            setShowSuggestions(true);
                                        }}
                                        onFocus={() => setShowSuggestions(true)}
                                        onBlur={() => {
                                            window.setTimeout(() => setShowSuggestions(false), 200);
                                        }}
                                        style={isInvalid ? { borderColor: '#EF4444' } : undefined}
                                    />
                                    <button type="submit" className="search-button" aria-label="Найти">
                                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                            <path d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16zM19 19l-4.35-4.35" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                    </button>
                                    <div className={`suggestions-list ${!showSuggestions || suggestions.length === 0 ? 'hidden' : ''}`}>
                                        {suggestions.map((teacher) => (
                                            <div
                                                key={teacher.id}
                                                className="suggestion-item"
                                                onMouseDown={(event) => {
                                                    event.preventDefault();
                                                    selectTeacher(teacher);
                                                }}
                                            >
                                                {teacher.full_name}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </form>
                        </>
                    ) : (
                        <div className="tl-results">
                            <div className="tl-results-top">
                                <div className="tl-identity">
                                    <h1 className="tl-teacher-name">{selectedTeacher.full_name}</h1>
                                    {loadData?.semester && (
                                        <span className="tl-semester-label">{loadData.semester.label}</span>
                                    )}
                                </div>
                                <button type="button" className="back-button tl-back" onClick={resetSearch}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M10 12L6 8L10 4" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                    Искать другого
                                </button>
                            </div>

                            {isLoading && <p className="tl-note">Загружаем данные...</p>}

                            {!isLoading && errorMessage && <p className="tl-note tl-error">{errorMessage}</p>}

                            {!isLoading && !errorMessage && loadData && !loadData.semester && (
                                <p className="tl-note">Активный семестр ещё не назначен — обратитесь к специалисту.</p>
                            )}

                            {!isLoading && !errorMessage && loadData?.semester && planRows.length === 0 && (
                                <p className="tl-note">На {loadData.semester.label} для вас пока не внесён план нагрузки.</p>
                            )}

                            {hasTable && (
                                <>
                                    <div className="tl-toolbar">
                                        <div className="tl-day-tabs" role="tablist" aria-label="Фильтр по дню недели">
                                            <button
                                                type="button"
                                                role="tab"
                                                aria-selected={dayFilter === 'all'}
                                                className={`tl-day-tab tl-day-tab-all ${dayFilter === 'all' ? 'is-active' : ''}`}
                                                onClick={() => setDayFilter('all')}
                                            >
                                                ВСЕ
                                            </button>
                                            {weekDays.map((day, index) => {
                                                // Dim the days this teacher has nothing on, so the
                                                // week's actual teaching days read at a glance
                                                // instead of after six clicks.
                                                const isEmpty = !planRows.some(
                                                    (row) => row.occurrences.some((occurrence) => occurrence.date === day)
                                                );

                                                return (
                                                    <button
                                                        key={day}
                                                        type="button"
                                                        role="tab"
                                                        aria-selected={dayFilter === day}
                                                        className={`tl-day-tab ${dayFilter === day ? 'is-active' : ''} ${isEmpty ? 'is-empty' : ''}`}
                                                        onClick={() => setDayFilter(day)}
                                                    >
                                                        <span className="tl-day-name">{WEEKDAY_SHORT[index]}</span>
                                                        <span className="tl-day-date">{formatIsoDate(day)}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>

                                        <div className="tl-list-search">
                                            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                                                <path d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16zM19 19l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                            <input
                                                type="search"
                                                placeholder="Поиск по списку"
                                                aria-label="Поиск по списку дисциплин"
                                                value={listQuery}
                                                onChange={(event) => setListQuery(event.target.value)}
                                            />
                                        </div>
                                    </div>

                                    {visibleRows.length === 0 ? (
                                        <p className="tl-note tl-note-empty">
                                            {dayFilter === 'all'
                                                ? 'По этому запросу ничего не найдено.'
                                                : 'В этот день занятий нет.'}
                                        </p>
                                    ) : (
                                        <>
                                            <div className="tl-table-scroll">
                                                <table className="tl-table">
                                                    <thead>
                                                        <tr>
                                                            <th scope="col">Вид занятий</th>
                                                            <th scope="col">Дисциплина</th>
                                                            <th scope="col">Группа</th>
                                                            <th scope="col">Дата посл. занятия</th>
                                                            <th scope="col">Часов</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {visibleRows.map((row) => (
                                                            <LoadRow key={row.id} row={row} />
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>

                                            <div className="tl-totals">
                                                <span className="tl-totals-caption">
                                                    Итого{dayFilter === 'all' && !listQuery.trim() ? '' : ' по отфильтрованным'}
                                                </span>
                                                <span className="tl-totals-value">
                                                    {totals.occurred} / {totals.planned}{totals.hasUnplanned ? '+' : ''} ч
                                                </span>
                                            </div>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function LoadRow({ row }) {
    const typeMeta = TYPE_META[row.lesson_type] || { short: row.lesson_type.slice(0, 4), tone: 'default' };
    const lastDate = lastOccurredDate(row.occurrences);
    const hasPlan = row.planned_hours !== null;
    const percent = hasPlan && row.planned_hours > 0
        ? Math.min(100, Math.round((row.occurred_hours / row.planned_hours) * 100))
        : 0;
    const isComplete = hasPlan && row.occurred_hours >= row.planned_hours;

    return (
        <tr>
            <td data-label="Вид занятий">
                <span className={`tl-type-badge tone-${typeMeta.tone}`}>{typeMeta.short}</span>
            </td>
            <td data-label="Дисциплина">
                <span className="tl-discipline">{row.discipline_name}</span>
            </td>
            <td data-label="Группа">
                {row.group_name}
                {row.subgroup ? <span className="tl-subgroup"> · {row.subgroup} п/г</span> : null}
            </td>
            <td data-label="Дата посл. занятия">
                {lastDate ? formatIsoDate(lastDate, true) : <span className="tl-muted">—</span>}
            </td>
            <td data-label="Часов">
                <div className="tl-hours-cell">
                    <span className={`tl-hours-value ${isComplete ? 'is-complete' : ''}`}>
                        {hasPlan ? `${row.occurred_hours}/${row.planned_hours}` : `${row.occurred_hours}/—`}
                    </span>
                    <span className="tl-progress-track">
                        <span
                            className={`tl-progress-fill ${isComplete ? 'is-complete' : ''}`}
                            style={{ width: `${percent}%` }}
                        />
                    </span>
                </div>
            </td>
        </tr>
    );
}

/** Latest occurrence that has already happened — occurrences come back in week order. */
function lastOccurredDate(occurrences) {
    for (let index = occurrences.length - 1; index >= 0; index -= 1) {
        if (occurrences[index].has_occurred) {
            return occurrences[index].date;
        }
    }

    return null;
}

function buildCurrentWeekDays() {
    const today = new Date();
    const mondayOffset = (today.getDay() + 6) % 7;
    const days = [];

    for (let index = 0; index < 6; index += 1) {
        const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset + index);
        days.push(toIsoDate(day));
    }

    return days;
}

function toIsoDate(date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function formatIsoDate(isoDate, withYear = false) {
    const [year, month, day] = isoDate.split('-');
    return withYear ? `${day}.${month}.${year}` : `${day}.${month}`;
}
