import { LESSON_TYPES } from './builderUtils';
import DictionaryPicker from './DictionaryPicker';

// The dialog for creating, editing and removing a pair in the constructor.
// teachers/disciplines and onCreateTeacher/onCreateDiscipline come from the
// page so a picker can add a new dictionary entry without leaving the modal.
export default function LessonEditModal({
    disciplines,
    editContext,
    editForm,
    editMode,
    handleDeleteFromModal,
    handleEditSubmit,
    isEditModalOpen,
    onCreateDiscipline,
    onCreateTeacher,
    setEditForm,
    setIsEditModalOpen,
    teachers
}) {
    const teacherOptions = teachers.map((teacher) => ({ id: teacher.id, label: teacher.full_name }));
    const disciplineOptions = disciplines.map((discipline) => ({ id: discipline.id, label: discipline.name }));
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
                    <DictionaryPicker
                        id="editSubject"
                        label="Предмет"
                        placeholder="Начните вводить название"
                        options={disciplineOptions}
                        valueId={editForm.discipline_id}
                        valueText={editForm.subject}
                        onChange={(picked) => setEditForm((previous) => ({
                            ...previous,
                            discipline_id: picked ? picked.id : null,
                            subject: picked ? picked.label : ''
                        }))}
                        onCreate={onCreateDiscipline}
                    />
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
                    <DictionaryPicker
                        id="editTeacher"
                        label="Преподаватель"
                        placeholder="Например: Герасимов Н.П."
                        options={teacherOptions}
                        valueId={editForm.teacher_id}
                        valueText={editForm.teacher}
                        onChange={(picked) => setEditForm((previous) => ({
                            ...previous,
                            teacher_id: picked ? picked.id : null,
                            teacher: picked ? picked.label : ''
                        }))}
                        onCreate={onCreateTeacher}
                    />
                    <div className="form-row-pair">
                        <div className="form-row">
                            <label>Тип</label>
                            <select
                                id="editType"
                                className="form-input"
                                value={editForm.lesson_type}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, lesson_type: event.target.value }))}
                            >
                                {LESSON_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
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
