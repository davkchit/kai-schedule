// The dialog for creating, editing and removing a pair in the constructor.
// Presentational only: moved verbatim from AdminDashboardPage.jsx, every
// value and handler comes from the page as a prop of the same name.
export default function LessonEditModal({
    editContext,
    editForm,
    editMode,
    handleDeleteFromModal,
    handleEditSubmit,
    isEditModalOpen,
    setEditForm,
    setIsEditModalOpen
}) {
    return (
        <div
            className={`modal-overlay ${isEditModalOpen ? 'active' : ''}`}
            id="editModal"
            aria-hidden={!isEditModalOpen}
            onClick={(event) => {
                if (event.target.id === 'editModal') {
                    setIsEditModalOpen(false);
                }
            }}
        >
            <div className="modal-card">
                <h3 className="modal-title">
                    {editMode === 'create'
                        ? (editContext === 'template' ? 'Добавить в шаблон' : 'Добавить занятие')
                        : 'Редактировать занятие'}
                </h3>
                {editContext === 'template' && (
                    <p className="modal-hint">Сохранится как новая версия с текущей недели — прошлые недели не изменятся.</p>
                )}
                <form id="editForm" className="edit-form" onSubmit={handleEditSubmit}>
                    <input type="hidden" id="editId" value={editForm.id} readOnly />
                    <div className="form-row">
                        <label>День недели</label>
                        <select
                            id="editDay"
                            className="form-input"
                            value={editForm.day_of_week}
                            onChange={(event) => setEditForm((previous) => ({ ...previous, day_of_week: event.target.value }))}
                        >
                            <option value="1">Понедельник</option>
                            <option value="2">Вторник</option>
                            <option value="3">Среда</option>
                            <option value="4">Четверг</option>
                            <option value="5">Пятница</option>
                            <option value="6">Суббота</option>
                            <option value="7">{'\u0412\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c\u0435'}</option>
                        </select>
                    </div>
                    <div className="form-row-pair">
                        <div className="form-row">
                            <label>Начало</label>
                            <input
                                type="time"
                                id="editTimeStart"
                                className="form-input"
                                value={editForm.time_start}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, time_start: event.target.value }))}
                            />
                        </div>
                        <div className="form-row">
                            <label>Конец</label>
                            <input
                                type="time"
                                id="editTimeEnd"
                                className="form-input"
                                value={editForm.time_end}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, time_end: event.target.value }))}
                            />
                        </div>
                    </div>
                    <div className="form-row">
                        <label>Предмет</label>
                        <input
                            type="text"
                            id="editSubject"
                            className="form-input"
                            required
                            value={editForm.subject}
                            onChange={(event) => setEditForm((previous) => ({ ...previous, subject: event.target.value }))}
                        />
                    </div>
                    <div className="form-row">
                        <label>Кабинет</label>
                        <input
                            type="text"
                            id="editRoom"
                            className="form-input"
                            value={editForm.room}
                            onChange={(event) => setEditForm((previous) => ({ ...previous, room: event.target.value }))}
                        />
                    </div>
                    <div className="form-row">
                        <label>Преподаватель</label>
                        <input
                            type="text"
                            id="editTeacher"
                            className="form-input"
                            placeholder="Например: Герасимов Н.П."
                            value={editForm.teacher}
                            onChange={(event) => setEditForm((previous) => ({ ...previous, teacher: event.target.value }))}
                        />
                    </div>
                    <div className="form-row-pair">
                        <div className="form-row">
                            <label>Тип</label>
                            <select
                                id="editType"
                                className="form-input"
                                value={editForm.lesson_type}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, lesson_type: event.target.value }))}
                            >
                                <option value="Лекция">Лекция</option>
                                <option value="Практика">Практика</option>
                                <option value="Лаб. работа">Лаб. работа</option>
                            </select>
                        </div>
                        <div className="form-row">
                            <label>Подгруппа</label>
                            <select
                                id="editSubgroup"
                                className="form-input"
                                value={editForm.subgroup}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, subgroup: event.target.value }))}
                            >
                                <option value="0">Обе</option>
                                <option value="1">1-я</option>
                                <option value="2">2-я</option>
                            </select>
                        </div>
                    </div>
                    <div className="modal-actions">
                        {editMode === 'edit' && (
                            <button type="button" className="btn btn-delete" onClick={handleDeleteFromModal}>
                                {editContext === 'template' ? 'Убрать из шаблона' : 'Удалить'}
                            </button>
                        )}
                        <button type="button" className="btn btn-secondary" id="cancelEditBtn" onClick={() => setIsEditModalOpen(false)}>
                            Отмена
                        </button>
                        <button type="submit" className="btn btn-primary">
                            {editMode === 'create'
                                ? 'Добавить'
                                : (editContext === 'template' ? 'Сохранить как новую версию' : 'Сохранить')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
