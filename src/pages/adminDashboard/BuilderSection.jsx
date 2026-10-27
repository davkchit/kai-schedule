import { getWeekTypeForSemesterWeek } from '../../lib/date';
import { resolveTemplateLessons } from '../../lib/templateResolve';
import { BUILDER_DAYS, BUILDER_TIME_SLOTS, DAY_NAMES, formatDayMonth, softHyphenate } from './builderUtils';
import GroupPicker from './GroupPicker';

// The schedule builder: toolbar, week/template grid and its cells. Which pairs
// a cell shows is decided here; saving, moving and deleting stay in the page.
// Moved verbatim from AdminDashboardPage.jsx, every value and handler is a prop
// of the same name.
export default function BuilderSection({ activeSection, workingSemester, groups, selectedGroupId, setSelectedGroupId, lessons, builderMode, setBuilderMode, builderWeekStart, setBuilderWeekStart, builderWeekEnd, builderTemplateWeekType, setBuilderTemplateWeekType, builderWeekNumber, builderWeekMaterialized, isBuilderWeekBeforeSemester, todayWeekNumber, isExporting, handleClearWeek, handleCopyWeek, handleExport, draggedLesson, setDraggedLesson, dragOverCellKey, setDragOverCellKey, handleDropOnCell, openEditModal, openCreateModal, justSavedCell }) {
    // The usual slots, plus a row for every other time a pair of this view
    // has (entered with «Своё время»): a cell only shows pairs of its exact
    // time, so without its own row such a pair could not be seen, opened or
    // removed — the Excel export lays those out the same way.
    const inThisView = (lesson) => !lesson.is_removed && (builderMode === 'week' && builderWeekMaterialized
        ? lesson.specific_week === builderWeekNumber
        : lesson.specific_week == null);
    const extraSlots = [...new Map(lessons.filter(inThisView)
        .filter((lesson) => !BUILDER_TIME_SLOTS.some(([start, end]) => start === lesson.time_start && end === lesson.time_end))
        .map((lesson) => [`${lesson.time_start}-${lesson.time_end}`, [lesson.time_start, lesson.time_end]])).values()];
    // «Внести неделю как в шаблоне» only when the draft has pairs that week.
    const draftHasPairs = builderWeekNumber !== null && workingSemester && builderWeekNumber <= workingSemester.weeks_count
        && resolveTemplateLessons(lessons.filter((lesson) => lesson.specific_week == null && (lesson.week_type === 0
            || lesson.week_type === getWeekTypeForSemesterWeek(workingSemester.first_week_parity, builderWeekNumber))), builderWeekNumber).length > 0;
    const gridSlots = [...BUILDER_TIME_SLOTS.map((slot) => [...slot, false]), ...extraSlots.map((slot) => [...slot, true])]
        .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));

    function getBuilderCellLessons(day, timeStart, timeEnd) {
        if (builderWeekNumber === null) {
            return [];
        }

        if (builderWeekMaterialized) {
            return lessons.filter((lesson) =>
                lesson.day_of_week === day &&
                lesson.time_start === timeStart &&
                lesson.time_end === timeEnd &&
                lesson.specific_week === builderWeekNumber &&
                // A removed marker only keeps the week "its own"; the cell is free.
                !lesson.is_removed
            );
        }

        if (builderWeekNumber > workingSemester.weeks_count) {
            // After the last teaching week the template stops, as it does for
            // students and for the hour counter.
            return [];
        }

        // The working semester's stored parity — the same rule the server and
        // the student schedule resolve with.
        const weekTypeNumber = getWeekTypeForSemesterWeek(workingSemester.first_week_parity, builderWeekNumber);
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
                    className={`builder-lesson-card ${draggedLesson?.id === full.id ? 'is-dragging' : ''} ${justSavedCell === `${day}|${timeStart}` ? 'just-saved' : ''}`}
                    onClick={() => openEditModal(full, context)}
                    draggable
                    onDragStart={() => setDraggedLesson(full)}
                    onDragEnd={() => {
                        setDraggedLesson(null);
                        setDragOverCellKey(null);
                    }}
                >
                    <span className="builder-lesson-subject">{softHyphenate(full.subject)}</span>
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
                            <span className="builder-lesson-subject">{softHyphenate(sub1.subject)}</span>
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
                            <span className="builder-lesson-subject">{softHyphenate(sub2.subject)}</span>
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

    return (
        <section className={`content-section ${activeSection === 'builder' ? 'active' : ''}`} id="sectionBuilder">
            {/* The working semester as a badge instead of a paragraph: the
                person here every day needs to see it, not re-read how it works. */}
            <div className="section-heading">
                <h2 className="section-title">Конструктор расписания</h2>
                {workingSemester && (
                    <span className="semester-badge" title="Сменить семестр — в разделе «Нагрузка»">
                        {workingSemester.label}
                    </span>
                )}
            </div>

            <div className="builder-toolbar">
                <GroupPicker groups={groups} value={selectedGroupId} onChange={setSelectedGroupId} />

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

                {builderMode === 'week' && builderWeekNumber !== null && (
                    <button type="button" className="btn btn-secondary builder-export-btn" onClick={handleExport} disabled={isExporting} title="Расписание всех курсов на эту неделю">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
                        </svg>
                        {isExporting ? 'Формирование...' : 'Скачать Excel'}
                    </button>
                )}
            </div>

            {builderMode === 'week' && builderWeekNumber !== null && selectedGroupId && builderWeekMaterialized && (
                <div className="builder-export-row">
                    <button type="button" className="btn btn-delete" onClick={handleClearWeek}>
                        Очистить неделю
                    </button>
                </div>
            )}

            {builderMode === 'week' && selectedGroupId && builderWeekNumber !== null && !builderWeekMaterialized && (
                <div className="builder-not-entered">
                    <p className="builder-hint">
                        {draftHasPairs
                            ? 'Неделя не внесена — студенты её не видят. Ниже показан шаблон как заготовка: внесите неделю как есть или поменяйте нужные пары — любое изменение внесёт всю неделю.'
                            : 'Неделя не внесена — студенты видят «Расписание не внесено». Добавьте пары — неделя внесётся с первой же.'}
                    </p>
                    {draftHasPairs && (
                        <button type="button" className="btn btn-primary" onClick={handleCopyWeek}>
                            Внести неделю как в шаблоне
                        </button>
                    )}
                </div>
            )}

            {workingSemester?.closed && (
                <p className="load-unconfirmed-note">
                    Семестр «{workingSemester.label}» закрыт — его расписание не меняется. Чтобы что-то поправить, откройте его заново в разделе «Нагрузка».
                </p>
            )}

            {builderMode === 'template' && (
                <p className="builder-hint">
                    Изменения в шаблоне вступают в силу с текущей недели, а если пара в этой ячейке на этой неделе уже прошла — со следующей. Прошедшие пары останутся такими, какими были показаны.
                </p>
            )}

            {!selectedGroupId ? (
                <p className="empty-message">Выберите группу, чтобы начать редактирование</p>
            ) : !workingSemester ? (
                <p className="empty-message">Создайте семестр в разделе «Нагрузка» — расписание ведётся внутри семестра</p>
            ) : builderMode === 'week' && isBuilderWeekBeforeSemester ? (
                <p className="empty-message">Эта неделя раньше начала семестра «{workingSemester.label}» ({workingSemester.start_date}). Прошлые семестры правятся, если сделать их рабочими в разделе «Нагрузка».</p>
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
                        {gridSlots.map(([start, end, isExtra]) => (
                            <div className={`builder-row ${isExtra ? 'is-extra-slot' : ''}`} key={`${start}-${end}`}>
                                <div className="builder-slot-label" title={isExtra ? 'Нестандартное время — строка есть, пока в ней стоит пара' : undefined}>{start}–{end}</div>
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
    );
}
