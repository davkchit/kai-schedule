// Экзамены, зачёты и консультации ("attestations"): one-off events on a date,
// kept apart from the weekly timetable (see the table in server/db.js).
// Students see them among their pairs, teachers see them on their page, and
// the admin «Сессия» section counts them per teacher. They never add to a plan row's hours:
// the norms a department uses for them are not pair hours.

const { getSemesterForDate } = require('./semesters');

const KIND_LABELS = { exam: 'Экзамен', credit: 'Зачёт', consultation: 'Консультация' };

/**
 * A record belongs to the semester in effect on its date, fixed when it is
 * saved. Creating a semester or moving one's dates can change that answer
 * (spring now starting before a late January consultation), so records follow
 * — except into or out of a closed semester, whose contents are frozen.
 * Returns how many moved.
 */
function resyncAttestationSemesters(db) {
    const rows = db.prepare(`
        SELECT a.id, a.date, a.semester_id, s.closed_at FROM attestations a JOIN semesters s ON s.id = a.semester_id
    `).all();
    const move = db.prepare('UPDATE attestations SET semester_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    let moved = 0;

    for (const row of rows) {
        const target = row.closed_at ? null : getSemesterForDate(db, row.date);

        if (target && target.id !== row.semester_id && !target.closed_at) {
            move.run(target.id, row.id);
            moved += 1;
        }
    }

    return moved;
}

/** Rows with their display text resolved: the dictionary's current name wins over typed text. */
function selectAttestations(db, where, params) {
    return db.prepare(`
        SELECT a.id, a.semester_id, a.group_id, g.name AS group_name, a.subgroup, a.kind, a.date,
               a.time_start, a.time_end, a.room, a.discipline_id, a.teacher_id,
               COALESCE(d.name, a.discipline_text) AS subject,
               COALESCE(t.full_name, a.teacher_text) AS teacher
        FROM attestations a
        JOIN groups_ g ON g.id = a.group_id
        LEFT JOIN disciplines d ON d.id = a.discipline_id
        LEFT JOIN teachers t ON t.id = a.teacher_id
        WHERE ${where}
        ORDER BY a.date, a.time_start, g.name, a.subgroup
    `).all(...params);
}

/**
 * Per teacher: how many exams, credits and consultations in a semester.
 * A name typed by hand that matches no dictionary entry is still listed (by
 * its text), so nothing goes missing from the count, but it is marked so the
 * specialist can see why the teacher's own page doesn't show it.
 */
function countByTeacher(db, semesterId) {
    const rows = selectAttestations(db, 'a.semester_id = ?', [semesterId]);
    const byTeacher = new Map();

    for (const row of rows) {
        const name = row.teacher || '';
        const key = row.teacher_id ? `id:${row.teacher_id}` : `text:${name}`;
        const entry = byTeacher.get(key) || {
            teacher_id: row.teacher_id, teacher: name, exam: 0, credit: 0, consultation: 0, total: 0
        };
        entry[row.kind] += 1;
        entry.total += 1;
        byTeacher.set(key, entry);
    }

    return [...byTeacher.values()].sort((a, b) => a.teacher.localeCompare(b.teacher, 'ru'));
}

function insertAttestation(db, record) {
    return db.prepare(`
        INSERT INTO attestations (
            semester_id, group_id, subgroup, kind, date, time_start, time_end, room,
            discipline_id, discipline_text, teacher_id, teacher_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        record.semester_id, record.group_id, record.subgroup, record.kind, record.date, record.time_start,
        record.time_end, record.room, record.discipline_id, record.discipline_text, record.teacher_id, record.teacher_text
    ).lastInsertRowid;
}

module.exports = {
    KIND_LABELS,
    countByTeacher,
    insertAttestation,
    resyncAttestationSemesters,
    selectAttestations
};
