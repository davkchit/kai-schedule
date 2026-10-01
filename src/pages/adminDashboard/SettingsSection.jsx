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
    handleJoinGroup,
    handleSaveGroupDirection,
    isCreatingGroup,
    newGroupDirection,
    newGroupJoinedTo,
    newGroupName,
    newGroupUniversityId,
    saveSettings,
    semesterStartDate,
    setDirectorName,
    setDirectorTitle,
    setGroupDirectionDrafts,
    setNewGroupDirection,
    setNewGroupJoinedTo,
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
            <p className="section-desc">«Объединена с» — для групп, которые учатся вместе (как 23313 с 23303): расписание у них одно, в конструкторе это одна группа «23303 / 23313», студенты каждой видят его под своим номером.</p>

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
                <select
                    className="form-input"
                    value={newGroupJoinedTo}
                    onChange={(event) => setNewGroupJoinedTo(event.target.value)}
                    title="Если группа учится вместе с другой — расписание будет общим"
                >
                    <option value="">Отдельная группа</option>
                    {groups.filter((group) => !group.joined_to).map((group) => (
                        <option key={group.id} value={group.id}>Объединить с {group.name}</option>
                    ))}
                </select>
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
                            <th>Объединена с</th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map((group) => {
                            const course = getCourseFromGroupName(group.name);
                            const draft = groupDirectionDrafts[group.id] ?? group.direction ?? '';
                            const members = groups.filter((other) => other.joined_to === group.id).map((other) => other.name);

                            return (
                                <tr key={group.id}>
                                    <td>{group.university}</td>
                                    <td><strong>{group.name}</strong></td>
                                    <td>{course ?? '—'}</td>
                                    <td>
                                        {/* «Сохранить» belongs to the direction alone, so it sits
                                            next to it and shows only once the text was changed;
                                            «Объединена с» applies on its own, after a confirm. */}
                                        <div className="group-direction-cell">
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
                                            {draft !== (group.direction ?? '') && (
                                                <button className="btn-edit" onClick={() => handleSaveGroupDirection(group.id)}>
                                                    Сохранить
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                    <td>
                                        {group.joined_label ? (
                                            <span className="setting-hint">с ней: {members.join(', ')}</span>
                                        ) : (
                                            <select
                                                className="form-input"
                                                value={group.joined_to ?? ''}
                                                onChange={(event) => handleJoinGroup(group.id, event.target.value)}
                                            >
                                                <option value="">—</option>
                                                {groups
                                                    .filter((other) => other.id !== group.id && !other.joined_to)
                                                    .map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
                                            </select>
                                        )}
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
