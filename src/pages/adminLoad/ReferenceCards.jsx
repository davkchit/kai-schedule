import { REF_PREVIEW_COUNT } from './constants';

// Teachers and disciplines — the two dictionaries the plan and the schedule
// share. Presentational only: moved verbatim from AdminLoadSection.jsx.
export default function ReferenceCards({ teachers, disciplines, visibleTeachers, visibleDisciplines, newTeacherName, setNewTeacherName, newDisciplineName, setNewDisciplineName, addTeacher, addDiscipline, renameTeacher, deleteTeacher, renameDiscipline, deleteDiscipline, showAllTeachers, setShowAllTeachers, showAllDisciplines, setShowAllDisciplines }) {
    return (
        <>
        <h3 className="subsection-title">Преподаватели и дисциплины</h3>
        <div className="load-refs-row">
            <div className="load-ref-card">
                <form className="load-ref-add-row" onSubmit={addTeacher}>
                    <input
                        type="text"
                        className="form-input"
                        placeholder="ФИО преподавателя"
                        value={newTeacherName}
                        onChange={(event) => setNewTeacherName(event.target.value)}
                    />
                    <button type="submit" className="btn btn-secondary">Добавить</button>
                </form>
                <div className="load-ref-card-header">
                    <span>Преподаватели</span>
                    <span className="load-ref-count">{teachers.length}</span>
                </div>
                <ul className="load-ref-list">
                    {visibleTeachers.map((teacher) => (
                        <li key={teacher.id} className="load-ref-row">
                            <span>{teacher.full_name}</span>
                            <span className="load-ref-row-actions">
                                <button type="button" onClick={() => renameTeacher(teacher)} title="Переименовать">✎</button>
                                <button type="button" onClick={() => deleteTeacher(teacher)} title="Удалить">✕</button>
                            </span>
                        </li>
                    ))}
                    {teachers.length === 0 && <li className="load-ref-empty">Преподавателей пока нет</li>}
                </ul>
                {teachers.length > REF_PREVIEW_COUNT && (
                    <button type="button" className="btn-link load-ref-all" onClick={() => setShowAllTeachers((v) => !v)}>
                        {showAllTeachers ? 'Свернуть' : 'Все'}
                    </button>
                )}
            </div>

            <div className="load-ref-card">
                <form className="load-ref-add-row" onSubmit={addDiscipline}>
                    <input
                        type="text"
                        className="form-input"
                        placeholder="Название дисциплины"
                        value={newDisciplineName}
                        onChange={(event) => setNewDisciplineName(event.target.value)}
                    />
                    <button type="submit" className="btn btn-secondary">Добавить</button>
                </form>
                <div className="load-ref-card-header">
                    <span>Дисциплины</span>
                    <span className="load-ref-count">{disciplines.length}</span>
                </div>
                <ul className="load-ref-list">
                    {visibleDisciplines.map((discipline) => (
                        <li key={discipline.id} className="load-ref-row">
                            <span>{discipline.name}</span>
                            <span className="load-ref-row-actions">
                                <button type="button" onClick={() => renameDiscipline(discipline)} title="Переименовать">✎</button>
                                <button type="button" onClick={() => deleteDiscipline(discipline)} title="Удалить">✕</button>
                            </span>
                        </li>
                    ))}
                    {disciplines.length === 0 && <li className="load-ref-empty">Дисциплин пока нет</li>}
                </ul>
                {disciplines.length > REF_PREVIEW_COUNT && (
                    <button type="button" className="btn-link load-ref-all" onClick={() => setShowAllDisciplines((v) => !v)}>
                        {showAllDisciplines ? 'Свернуть' : 'Все'}
                    </button>
                )}
            </div>
        </div>
        </>
    );
}
