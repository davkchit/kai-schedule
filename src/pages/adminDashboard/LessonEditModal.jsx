import { useEffect, useRef } from 'react';
import { LESSON_TYPES } from './builderUtils';
import DictionaryPicker from './DictionaryPicker';
import GroupsField from '../adminLoad/GroupsField';

// What the «Онлайн» box stores as the room; the schedule page shows it as the orange tag.
const ONLINE_ROOM = 'онлайн';

// The dialog for creating, editing and removing a pair in the constructor.
// teachers/disciplines and onCreateTeacher/onCreateDiscipline come from the
// page so a picker can add a new dictionary entry without leaving the modal.
export default function LessonEditModal({
    disciplines,
    editContext,
    editForm,
    editMode,
    groups,
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
    const isOnline = /^\s*(онлайн|online|дистанционно)\s*$/i.test(editForm.room || '');
    const isEvent = editForm.kind === 'event';
    const cardRef = useRef(null);
    const lastPressRef = useRef(null);

    useEffect(() => {
        function remember(event) {
            lastPressRef.current = { x: event.clientX, y: event.clientY };
        }

        document.addEventListener('pointerdown', remember, true);
        return () => document.removeEventListener('pointerdown', remember, true);
    }, []);

    useEffect(() => {
        const card = cardRef.current;
        const press = lastPressRef.current;

        if (!isEditModalOpen || !card || !press) {
            return;
        }

        card.style.transformOrigin = `${press.x - card.offsetLeft}px ${press.y - card.offsetTop}px`;
    }, [isEditModalOpen]);

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
            <div className="modal-card" ref={cardRef}>
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
                    {/* A pair takes its subject and teacher from the dictionaries
                        only — that is what makes its hours count. Anything else
                        (линейка, кураторский час, спартакиада) is an event: any
                        title, no teacher, never counted toward anyone's hours. */}
                    <label className="online-toggle event-toggle">
                        <input
                            type="checkbox"
                            id="editIsEvent"
                            checked={isEvent}
                            onChange={(event) => setEditForm((previous) => ({
                                ...previous,
                                kind: event.target.checked ? 'event' : 'lesson',
                                subject: '',
                                discipline_id: null,
                                teacher: '',
                                teacher_id: null,
                                lesson_type: event.target.checked ? '' : 'Лекция'
                            }))}
                        />
                        Мероприятие, а не занятие (не идёт в часы)
                    </label>
                    {isEvent ? (
                        <div className="form-row">
                            <label htmlFor="editSubject">Название</label>
                            <input
                                type="text"
                                id="editSubject"
                                className="form-input"
                                placeholder="Например: Торжественная линейка"
                                value={editForm.subject}
                                required
                                onChange={(event) => setEditForm((previous) => ({ ...previous, subject: event.target.value }))}
                            />
                        </div>
                    ) : (
                        <>
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
                                listOnly
                            />
                            <DictionaryPicker
                                id="editTeacher"
                                label="Преподаватель"
                                placeholder="Например: Кузнецов Н.П."
                                options={teacherOptions}
                                valueId={editForm.teacher_id}
                                valueText={editForm.teacher}
                                onChange={(picked) => setEditForm((previous) => ({
                                    ...previous,
                                    teacher_id: picked ? picked.id : null,
                                    teacher: picked ? picked.label : ''
                                }))}
                                onCreate={onCreateTeacher}
                                listOnly
                            />
                        </>
                    )}
                    <div className="form-row-pair">
                        {!isEvent && (
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
                        )}
                        <div className="form-row">
                            <div className="room-label-row">
                                <label htmlFor="editRoom">Кабинет</label>
                                {/* An online pair has no room: «онлайн» is stored in its
                                    place, and students see an orange «Онлайн» tag. */}
                                <label className="online-toggle">
                                    <input
                                        type="checkbox"
                                        checked={isOnline}
                                        onChange={(event) => setEditForm((previous) => ({
                                            ...previous,
                                            room: event.target.checked ? ONLINE_ROOM : ''
                                        }))}
                                    />
                                    Онлайн
                                </label>
                            </div>
                            <input
                                type="text"
                                id="editRoom"
                                className="form-input"
                                value={isOnline ? '' : editForm.room}
                                placeholder={isOnline ? 'Пара проходит онлайн' : ''}
                                disabled={isOnline}
                                onChange={(event) => setEditForm((previous) => ({ ...previous, room: event.target.value }))}
                            />
                        </div>
                    </div>
                    {/* Students no longer pick subgroups, so the field shows only for
                        a pair that already has one — old data stays editable. */}
                    {Number(editForm.subgroup) > 0 && (
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
                    )}
                    {/* When: usually already right — it comes from the clicked cell —
                        so it sits last, in one compact row. */}
                    <div className="form-row-when">
                        <div className="form-row">
                            <label>День</label>
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
                    {editMode === 'create' && (
                        <div className="form-row modal-extra-groups">
                            <label>Ещё группы</label>
                            <p className="modal-hint">Если пара общая на поток — та же пара сразу добавится и в эти группы.</p>
                            <GroupsField
                                groups={(groups || []).filter((group) => String(group.id) !== String(editForm.group_id))}
                                value={(editForm.extra_group_ids || []).map(String)}
                                onChange={(groupIds) => setEditForm((previous) => ({ ...previous, extra_group_ids: groupIds }))}
                                allowEmpty
                            />
                        </div>
                    )}
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
