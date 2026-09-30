import { getCourseFromGroupName } from './builderUtils';

// Settings: director and study details for exports, and the list of groups.
// Presentational only: moved verbatim from AdminDashboardPage.jsx, every
// value and handler comes from the page as a prop of the same name.
export default function SettingsSection({
    activeSection,
    directorName,
    directorTitle,
    groupDirectionDrafts,
    groups,
    handleCreateGroup,
    handleSaveGroupDirection,
    isCreatingGroup,
    newGroupDirection,
    newGroupName,
    newGroupUniversityId,
    saveSettings,
    semesterStartDate,
    setDirectorName,
    setDirectorTitle,
    setGroupDirectionDrafts,
    setNewGroupDirection,
    setNewGroupName,
    setNewGroupUniversityId,
    setSemesterStartDate,
    setStudyForm,
    settingsStatus,
    studyForm,
    universities
}) {
    return (
        <section className={`content-section ${activeSection === 'settings' ? 'active' : ''}`} id="sectionSettings">
            <h2 className="section-title">Настройки</h2>
            <div className="settings-form">
                <div className="setting-row">
                    <label htmlFor="semesterStart">Дата начала семестра</label>
                    <p className="setting-hint">Используется для расчёта чётной/нечётной недели</p>
                    <input
                        type="date"
                        id="semesterStart"
                        className="setting-input"
                        value={semesterStartDate}
                        onChange={(event) => setSemesterStartDate(event.target.value)}
                    />
                </div>
                <div className="setting-row">
                    <label htmlFor="studyForm">Форма обучения</label>
                    <p className="setting-hint">Номер семестра и учебный год в шапке Excel берутся из дат рабочего семестра</p>
                    <input
                        type="text"
                        id="studyForm"
                        className="setting-input"
                        placeholder="очная форма обучения"
                        value={studyForm}
                        onChange={(event) => setStudyForm(event.target.value)}
                    />
                </div>
                <div className="setting-row">
                    <label htmlFor="directorTitle">Должность подписанта</label>
                    <input
                        type="text"
                        id="directorTitle"
                        className="setting-input"
                        placeholder="Директор филиала"
                        value={directorTitle}
                        onChange={(event) => setDirectorTitle(event.target.value)}
                    />
                </div>
                <div className="setting-row">
                    <label htmlFor="directorName">ФИО подписанта</label>
                    <p className="setting-hint">Появляется в шапке экспортированного расписания рядом со строкой подписи</p>
                    <input
                        type="text"
                        id="directorName"
                        className="setting-input"
                        placeholder="А.Ф. Федоров"
                        value={directorName}
                        onChange={(event) => setDirectorName(event.target.value)}
                    />
                </div>
                <button className="btn btn-primary" id="saveSettingsBtn" onClick={saveSettings}>
                    Сохранить настройки
                </button>
                <span className={`upload-status ${settingsStatus.type}`} id="settingsStatus">
                    {settingsStatus.message}
                </span>
            </div>

            <h3 className="subsection-title">Группы и направления</h3>
            <p className="section-desc">Курс определяется автоматически по номеру группы (23<strong>1</strong>01 — 1 курс). Направление появляется в шапке при экспорте расписания.</p>

            <div className="add-group-row">
                <select
                    className="form-input"
                    value={newGroupUniversityId}
                    onChange={(event) => setNewGroupUniversityId(event.target.value)}
                >
                    <option value="">Вуз</option>
                    {universities.map((university) => (
                        <option key={university.id} value={university.id}>{university.short_name}</option>
                    ))}
                </select>
                <input
                    type="text"
                    className="form-input"
                    placeholder="Номер группы, например 23101"
                    value={newGroupName}
                    onChange={(event) => setNewGroupName(event.target.value)}
                />
                <input
                    type="text"
                    className="form-input"
                    placeholder="Направление (необязательно)"
                    value={newGroupDirection}
                    onChange={(event) => setNewGroupDirection(event.target.value)}
                />
                <button type="button" className="btn btn-primary" onClick={handleCreateGroup} disabled={isCreatingGroup}>
                    {isCreatingGroup ? 'Добавление...' : 'Добавить группу'}
                </button>
            </div>

            <div className="lessons-table-wrapper">
                <table className="lessons-table">
                    <thead>
                        <tr>
                            <th>Университет</th>
                            <th>Группа</th>
                            <th>Курс</th>
                            <th>Направление</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map((group) => {
                            const course = getCourseFromGroupName(group.name);
                            const draft = groupDirectionDrafts[group.id] ?? group.direction ?? '';

                            return (
                                <tr key={group.id}>
                                    <td>{group.university}</td>
                                    <td><strong>{group.name}</strong></td>
                                    <td>{course ?? '—'}</td>
                                    <td>
                                        <input
                                            type="text"
                                            className="form-input"
                                            placeholder="09.03.01 Информатика и вычислительная техника"
                                            value={draft}
                                            onChange={(event) => setGroupDirectionDrafts((previous) => ({
                                                ...previous,
                                                [group.id]: event.target.value
                                            }))}
                                        />
                                    </td>
                                    <td>
                                        <button className="btn-edit" onClick={() => handleSaveGroupDirection(group.id)}>
                                            Сохранить
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                {groups.length === 0 && (
                    <p className="empty-message">Групп пока нет</p>
                )}
            </div>
        </section>
    );
}
