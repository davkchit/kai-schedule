import { formatIsoDay, formatWeekRange, parityLabel, resolveNewSemesterParity } from './format';

// The semester card of the load page: which semester is viewed, its dates,
// and the forms to change them or add a new one. Presentational only: moved
// verbatim from AdminLoadSection.jsx, every value and handler is a prop of the same name.
export default function SemesterCard({ semesters, viewedSemester, setViewedSemesterId, isEditingSemester, setIsEditingSemester, isAddingSemester, setIsAddingSemester, semesterEdit, setSemesterEdit, newSemester, setNewSemester, startEditSemester, saveSemesterEdit, activateSemester, reopenSemester, closeSemester, addSemester }) {
    return (
        <>
        <h3 className="subsection-title">Семестр</h3>
        <div className="sem-card">
            <div className="sem-head">
                <label className="sem-picker">
                    <span className="sem-field-label">Просматриваемый семестр</span>
                    <select
                        className="form-input sem-select"
                        value={viewedSemester ? String(viewedSemester.id) : ''}
                        onChange={(event) => {
                            setViewedSemesterId(Number(event.target.value) || null);
                            setIsEditingSemester(false);
                        }}
                    >
                        {semesters.length === 0 && <option value="">Семестров пока нет</option>}
                        {semesters.map((semester) => (
                            <option key={semester.id} value={semester.id}>
                                {semester.label}{semester.is_active ? ' — рабочий' : ''}{semester.closed ? ' — закрыт' : ''}
                            </option>
                        ))}
                    </select>
                </label>
                {viewedSemester && (
                    <div className="sem-badges">
                        {viewedSemester.is_active && <span className="sem-badge is-active">Рабочий</span>}
                        {viewedSemester.closed && <span className="sem-badge is-closed">Закрыт {viewedSemester.closed_at}</span>}
                    </div>
                )}
                {!isAddingSemester && semesters.length > 0 && (
                    <button type="button" className="btn btn-secondary btn-sm sem-new-btn" onClick={() => setIsAddingSemester(true)}>
                        + Новый семестр
                    </button>
                )}
            </div>

            {viewedSemester && !isEditingSemester && (
                <>
                    <dl className="sem-facts">
                        <div><dt>Начало</dt><dd>{formatIsoDay(viewedSemester.start_date)}</dd></div>
                        <div><dt>Длительность</dt><dd>{viewedSemester.weeks_count} нед.</dd></div>
                        <div><dt>1-я неделя</dt><dd>{parityLabel(viewedSemester.first_week_parity)}</dd></div>
                        <div><dt>Последняя неделя</dt><dd>{formatWeekRange(viewedSemester.start_date, viewedSemester.weeks_count)}</dd></div>
                    </dl>
                    <div className="sem-actions">
                        {!viewedSemester.closed && (
                            <button type="button" className="btn btn-secondary btn-sm" onClick={startEditSemester}>Изменить даты</button>
                        )}
                        {!viewedSemester.is_active && !viewedSemester.closed && (
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => activateSemester(viewedSemester)}>
                                Сделать рабочим
                            </button>
                        )}
                        {viewedSemester.closed ? (
                            <button type="button" className="btn btn-secondary btn-sm" onClick={reopenSemester}>Открыть заново</button>
                        ) : (
                            <button type="button" className="btn btn-delete btn-sm sem-close-btn" onClick={closeSemester}>Закрыть семестр</button>
                        )}
                    </div>
                </>
            )}

            {viewedSemester && isEditingSemester && !viewedSemester.closed && (
                <form className="sem-form" onSubmit={saveSemesterEdit}>
                    <div className="sem-form-grid">
                        <label>
                            <span className="sem-field-label">Начало</span>
                            <input
                                type="date"
                                className="form-input"
                                value={semesterEdit.start_date}
                                onChange={(event) => setSemesterEdit((previous) => ({ ...previous, start_date: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">Недель</span>
                            <input
                                type="number"
                                min="1"
                                max="52"
                                className="form-input"
                                value={semesterEdit.weeks_count}
                                onChange={(event) => setSemesterEdit((previous) => ({ ...previous, weeks_count: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">1-я неделя</span>
                            <select
                                className="form-input"
                                title="Чётная или нечётная первая неделя семестра — смотрите шапку расписания"
                                value={String(semesterEdit.first_week_parity)}
                                onChange={(event) => setSemesterEdit((previous) => ({ ...previous, first_week_parity: Number(event.target.value) }))}
                            >
                                <option value="1">нечётная</option>
                                <option value="2">чётная</option>
                            </select>
                        </label>
                    </div>
                    <p className="sem-hint">
                        Последняя неделя: {formatWeekRange(semesterEdit.start_date, Number(semesterEdit.weeks_count))}
                    </p>
                    <div className="sem-actions">
                        <button type="submit" className="btn btn-primary btn-sm">Сохранить</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsEditingSemester(false)}>Отмена</button>
                    </div>
                </form>
            )}

            {(isAddingSemester || semesters.length === 0) && (
                <form className="sem-form sem-add" onSubmit={addSemester}>
                    <p className="sem-form-title">Новый семестр</p>
                    <div className="sem-form-grid is-four">
                        <label>
                            <span className="sem-field-label">Название</span>
                            <input
                                type="text"
                                className="form-input"
                                placeholder="Например Осень 2026-2027"
                                value={newSemester.label}
                                onChange={(event) => setNewSemester((previous) => ({ ...previous, label: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">Начало (понедельник)</span>
                            <input
                                type="date"
                                className="form-input"
                                value={newSemester.start_date}
                                onChange={(event) => setNewSemester((previous) => ({ ...previous, start_date: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">Недель</span>
                            <input
                                type="number"
                                min="1"
                                max="52"
                                className="form-input"
                                value={newSemester.weeks_count}
                                onChange={(event) => setNewSemester((previous) => ({ ...previous, weeks_count: event.target.value }))}
                            />
                        </label>
                        <label>
                            <span className="sem-field-label">1-я неделя</span>
                            <select
                                className="form-input"
                                title="Чётная или нечётная первая неделя семестра — смотрите шапку расписания"
                                value={String(resolveNewSemesterParity(newSemester) || '')}
                                onChange={(event) => setNewSemester((previous) => ({ ...previous, first_week_parity: Number(event.target.value) }))}
                            >
                                {!resolveNewSemesterParity(newSemester) && <option value="">выберите</option>}
                                <option value="1">нечётная</option>
                                <option value="2">чётная</option>
                            </select>
                        </label>
                    </div>
                    <div className="sem-actions">
                        <button type="submit" className="btn btn-primary btn-sm">Добавить семестр</button>
                        {semesters.length > 0 && (
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIsAddingSemester(false)}>Отмена</button>
                        )}
                    </div>
                </form>
            )}
        </div>
        </>
    );
}
