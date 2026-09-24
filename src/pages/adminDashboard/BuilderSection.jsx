import { getWeekTypeForSemesterWeek } from '../../lib/date';
import { resolveTemplateLessons } from '../../lib/templateResolve';
import { BUILDER_DAYS, BUILDER_TIME_SLOTS, DAY_NAMES, formatDayMonth } from './builderUtils';
import GroupPicker from './GroupPicker';

// The schedule builder: toolbar, week/template grid and its cells. Which pairs
// a cell shows is decided here; saving, moving and deleting stay in the page.
// Moved verbatim from AdminDashboardPage.jsx, every value and handler is a prop
// of the same name.
export default function BuilderSection({ activeSection, workingSemester, groups, selectedGroupId, setSelectedGroupId, lessons, builderMode, setBuilderMode, builderWeekStart, setBuilderWeekStart, builderWeekEnd, builderTemplateWeekType, setBuilderTemplateWeekType, builderWeekNumber, builderWeekMaterialized, isBuilderWeekBeforeSemester, todayWeekNumber, isExporting, handleClearWeek, handleExport, draggedLesson, setDraggedLesson, dragOverCellKey, setDragOverCellKey, handleDropOnCell, openEditModal, openCreateModal }) {
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
                    className={`builder-lesson-card ${draggedLesson?.id === full.id ? 'is-dragging' : ''}`}
                    onClick={() => openEditModal(full, context)}
                    draggable
                    onDragStart={() => setDraggedLesson(full)}
                    onDragEnd={() => {
                        setDraggedLesson(null);
                        setDragOverCellKey(null);
                    }}
                >
                    <span className="builder-lesson-subject">{full.subject}</span>
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
                            <span className="builder-lesson-subject">{sub1.subject}</span>
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
                            <span className="builder-lesson-subject">{sub2.subject}</span>
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
            <h2 className="section-title">Конструктор расписания</h2>
            <p className="section-desc">
                Добавляйте и редактируйте занятия прямо на сетке недели — так они лягут и в само расписание.
                {workingSemester && (
                    <>
                        {' '}Сейчас редактируется семестр <strong>{workingSemester.label}</strong>
                        {' '}(с {workingSemester.start_date}); сменить — в разделе «Нагрузка».
                    </>
                )}
            </p>

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
            </div>

            {builderMode === 'week' && builderWeekNumber !== null && (
                <div className="builder-export-row">
                    {selectedGroupId && builderWeekMaterialized && (
                        <button type="button" className="btn btn-delete" onClick={handleClearWeek}>
                            Очистить и вернуть к шаблону
                        </button>
                    )}
                    <button type="button" className="btn btn-secondary" onClick={handleExport} disabled={isExporting}>
                        {isExporting ? 'Формирование...' : 'Скачать расписание всех курсов (.xlsx)'}
                    </button>
                </div>
            )}

            {builderMode === 'week' && selectedGroupId && builderWeekNumber !== null && !builderWeekMaterialized && (
                <p className="builder-hint">
                    Сейчас показан шаблон для этой недели. Любое изменение сохранит всю неделю как отдельную копию — прошлые и другие недели не затронет.
                </p>
            )}

            {builderMode === 'template' && (
                <p className="builder-hint">
                    Изменения в шаблоне вступают в силу с текущей недели. Уже прошедшие недели останутся такими, какими были показаны.
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
                        {BUILDER_TIME_SLOTS.map(([start, end]) => (
                            <div className="builder-row" key={`${start}-${end}`}>
                                <div className="builder-slot-label">{start}–{end}</div>
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
