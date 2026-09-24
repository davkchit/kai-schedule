import { LESSON_TYPES } from './constants';
import { pluralizeKinds, pluralizePairs, pluralizeRecords } from './format';
import PlanRow from './PlanRow';

// The plan table of the viewed semester, with its warnings, the add form and
// the filters. Presentational only: moved verbatim from AdminLoadSection.jsx.
export default function PlanSection({ viewedSemester, isLoading, semesters, planStats, unconfirmedWeeks, unmatchedPairs, planForm, setPlanForm, submitPlanForm, teachers, disciplines, groups, filterQuery, setFilterQuery, filterGroupId, setFilterGroupId, visibleRows, loadPlan, editingPlanId, saveEditRow, cancelEditRow, startEditRow, updatePlannedHours, openMenuId, toggleRowMenu, scheduleMenuClose, deletePlanRow }) {
    return (
        <>
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

                {unmatchedPairs.length > 0 && (
                    <div className="load-unmatched-note">
                        <p className="load-unmatched-title">
                            Часы по этим парам не идут никому — {unmatchedPairs.length} {pluralizeKinds(unmatchedPairs.length)}:
                        </p>
                        <ul className="load-unmatched-list">
                            {unmatchedPairs.map((item) => (
                                <li key={`${item.group_id}|${item.subject}|${item.teacher}|${item.lesson_type}|${item.subgroup}|${item.reason}`}>
                                    <b>{item.group_name}</b> · {item.subject || 'без предмета'} · {item.teacher || 'без преподавателя'}
                                    {item.lesson_type ? ` · ${item.lesson_type}` : ''}
                                    {item.subgroup > 0 ? `, ${item.subgroup}-я подгруппа` : ''}
                                    {' — '}
                                    {item.reason === 'no_plan_row'
                                        ? 'в плане нет строки с таким преподавателем, предметом, типом и группой'
                                        : 'предмет или преподаватель вписаны вручную, а не выбраны из списка'}
                                    {` (${item.lessons_count} ${pluralizePairs(item.lessons_count)} в расписании)`}
                                </li>
                            ))}
                        </ul>
                    </div>
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
        </>
    );
}

function SearchIcon() {
    return (
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16zM19 19l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
