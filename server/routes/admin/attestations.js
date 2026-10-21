// Экзамены, зачёты и консультации: list, create, edit, delete, and export to
// the branch's two Excel documents. See server/utils/attestations.js.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { formatLocalDate } = require('../../utils/date');
const { joinedLabels, joinedMemberError, scheduleGroupId } = require('../../utils/groupJoin');
const { hidePairsOnDate, restorePairsHiddenBy } = require('../../utils/weekRows');
const { getActiveSemester, getSemesterById, getSemesterForDate } = require('../../utils/semesters');
const { countByTeacher, insertAttestation, selectAttestations } = require('../../utils/attestations');
const { buildConsultationWorkbook, buildSessionWorkbook } = require('../../exportAttestations');
const { getCourseFromGroupName } = require('../../utils/course');
const { createDayIndex, findAttestationConflicts } = require('../../utils/attestationConflicts');
const { validateAttestationBody } = require('../../validation');
const { SEMESTER_CLOSED, findClosedSemester, getClientAddress } = require('./shared');

const router = express.Router();

router.get('/attestations', (req, res) => {
    const db = getDb();
    let semester;

    if (req.query.semester_id) {
        semester = getSemesterById(db, Number.parseInt(req.query.semester_id, 10));

        if (!semester) {
            return res.status(404).json({ error: 'Семестр не найден' });
        }
    } else {
        // The session belongs to the semester in effect today: in June that is
        // still spring, even when autumn is already the working semester.
        semester = getSemesterForDate(db, formatLocalDate()) || getActiveSemester(db);
    }

    if (!semester) {
        return res.json({ semester: null, items: [], by_teacher: [] });
    }

    // Rechecked on every read: a pair added later in the constructor, or a
    // semester's dates moved, shows up here on the row it now collides with.
    const items = selectAttestations(db, 'a.semester_id = ?', [semester.id]);
    const dayIndex = createDayIndex(db);

    res.json({
        semester: { id: semester.id, label: semester.label, closed: Boolean(semester.closed_at) },
        items: items.map((item) => {
            const { duplicate, warnings } = findAttestationConflicts(db, item, items, dayIndex);
            return { ...item, warnings: duplicate ? [duplicate, ...warnings] : warnings };
        }),
        by_teacher: countByTeacher(db, semester.id)
    });
});

/**
 * Checks a validated body against the database and returns the row to write.
 * The semester is the one in effect on the date — a June exam belongs to
 * spring however the working semester is set — and a closed one is refused.
 */
function prepareRecord(db, payload) {
    const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

    if (!db.prepare('SELECT 1 FROM groups_ WHERE id = ?').get(payload.group_id)) {
        throw fail('Группа не найдена', 404);
    }

    const memberError = joinedMemberError(db, payload.group_id);
    if (memberError) throw fail(memberError, 409);

    const semester = getSemesterForDate(db, payload.date);
    if (!semester) throw fail('На эту дату нет семестра — сначала создайте его в разделе «Нагрузка»', 400);
    if (semester.closed_at) throw fail(SEMESTER_CLOSED, 409);

    if (payload.discipline_id && !db.prepare('SELECT 1 FROM disciplines WHERE id = ?').get(payload.discipline_id)) {
        throw fail('Дисциплина не найдена', 404);
    }

    if (payload.teacher_id && !db.prepare('SELECT 1 FROM teachers WHERE id = ?').get(payload.teacher_id)) {
        throw fail('Преподаватель не найден', 404);
    }

    // An id makes the typed text redundant: the dictionary's name is shown.
    return {
        ...payload,
        semester_id: semester.id,
        discipline_text: payload.discipline_id ? null : payload.discipline_text,
        teacher_text: payload.teacher_id ? null : payload.teacher_text
    };
}

/**
 * Refuses the very same record twice; anything else that collides (a pair,
 * the teacher or the room busy, a consultation after its exam…) is sent back
 * as warnings until the specialist confirms with `confirm: true`.
 */
function checkConflicts(db, record, { ignoreId = null, confirmed = false } = {}) {
    const subject = record.discipline_id
        ? db.prepare('SELECT name FROM disciplines WHERE id = ?').get(record.discipline_id).name
        : record.discipline_text;
    const teacher = record.teacher_id
        ? db.prepare('SELECT full_name FROM teachers WHERE id = ?').get(record.teacher_id).full_name
        : record.teacher_text;
    const others = selectAttestations(db, 'a.semester_id = ? AND (a.date = ? OR a.group_id = ?)', [record.semester_id, record.date, record.group_id])
        .filter((other) => other.id !== ignoreId);
    const { duplicate, warnings, covered } = findAttestationConflicts(db, { ...record, id: ignoreId, subject, teacher }, others);

    if (duplicate) {
        throw Object.assign(new Error(duplicate), { statusCode: 409 });
    }

    if (warnings.length > 0 && !confirmed) {
        throw Object.assign(new Error('Есть пересечения'), {
            statusCode: 409,
            // covered_pairs: the group's own pairs at that time, which the
            // specialist can take out of that day (remove_pairs: true).
            body: { needs_confirm: true, warnings, covered_pairs: covered.map(({ subject: name, time_start, time_end }) => ({ subject: name, time_start, time_end })) }
        });
    }

    return covered;
}

/**
 * With remove_pairs: the pairs the record lands on are taken out of that one
 * date (utils/weekRows.js), so the exam replaces them for students and they
 * stop counting toward the teacher's hours. Returns how many were hidden.
 */
function removeCoveredPairs(db, record, recordId, covered, requested) {
    if (!requested || covered.length === 0) {
        return 0;
    }

    const semester = getSemesterById(db, record.semester_id);
    return hidePairsOnDate(db, semester, scheduleGroupId(db, record.group_id), record.date, covered, recordId);
}

/** Whether an edit moves the record off the pairs it took out (another date, time, group or subgroup). */
function leavesItsPlace(before, after) {
    return ['date', 'time_start', 'time_end', 'group_id', 'subgroup'].some((field) => (before[field] ?? null) !== (after[field] ?? null));
}

function sendError(res, error, fallback) {
    if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message, ...(error.body || {}) });
    }

    console.error(fallback, error);
    return res.status(500).json({ error: fallback });
}

router.post('/attestations', (req, res) => {
    const db = getDb();

    try {
        const record = prepareRecord(db, validateAttestationBody(req.body));
        const covered = checkConflicts(db, record, { confirmed: req.body?.confirm === true });
        const { id, removedPairs } = db.transaction(() => {
            const newId = insertAttestation(db, record);
            return { id: newId, removedPairs: removeCoveredPairs(db, record, newId, covered, req.body?.remove_pairs === true) };
        })();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'attestation.create',
            entityType: 'attestation',
            entityId: id,
            ipAddress: getClientAddress(req),
            details: { ...record, removed_pairs: removedPairs }
        });

        res.status(201).json({ ...selectAttestations(db, 'a.id = ?', [id])[0], removed_pairs: removedPairs });
    } catch (error) {
        sendError(res, error, 'Не удалось сохранить');
    }
});

router.put('/attestations/:id', (req, res) => {
    const db = getDb();
    const id = Number.parseInt(req.params.id, 10);
    const existing = Number.isInteger(id) ? db.prepare('SELECT * FROM attestations WHERE id = ?').get(id) : null;

    if (!existing) {
        return res.status(404).json({ error: 'Запись не найдена' });
    }

    if (findClosedSemester(db, existing.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    try {
        const record = prepareRecord(db, validateAttestationBody(req.body));
        // Moved elsewhere: the pairs it took out of its old place come back
        // first, so the conflict check below sees the day as it will be.
        const { removedPairs, restoredPairs } = db.transaction(() => {
            const restored = leavesItsPlace(existing, record) ? restorePairsHiddenBy(db, id) : 0;
            const covered = checkConflicts(db, record, { ignoreId: id, confirmed: req.body?.confirm === true });
            db.prepare(`
                UPDATE attestations SET
                    semester_id = ?, group_id = ?, subgroup = ?, kind = ?, date = ?, time_start = ?, time_end = ?, room = ?,
                    discipline_id = ?, discipline_text = ?, teacher_id = ?, teacher_text = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                record.semester_id, record.group_id, record.subgroup, record.kind, record.date, record.time_start,
                record.time_end, record.room, record.discipline_id, record.discipline_text, record.teacher_id,
                record.teacher_text, id
            );
            return { removedPairs: removeCoveredPairs(db, record, id, covered, req.body?.remove_pairs === true), restoredPairs: restored };
        })();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'attestation.update',
            entityType: 'attestation',
            entityId: id,
            ipAddress: getClientAddress(req),
            details: { before: existing, after: record, removed_pairs: removedPairs, restored_pairs: restoredPairs }
        });

        res.json({ ...selectAttestations(db, 'a.id = ?', [id])[0], removed_pairs: removedPairs, restored_pairs: restoredPairs });
    } catch (error) {
        sendError(res, error, 'Не удалось сохранить');
    }
});

router.delete('/attestations/:id', (req, res) => {
    const db = getDb();
    const id = Number.parseInt(req.params.id, 10);
    const existing = Number.isInteger(id) ? db.prepare('SELECT * FROM attestations WHERE id = ?').get(id) : null;

    if (!existing) {
        return res.status(404).json({ error: 'Запись не найдена' });
    }

    if (findClosedSemester(db, existing.semester_id)) {
        return res.status(409).json({ error: SEMESTER_CLOSED });
    }

    const restoredPairs = db.transaction(() => {
        db.prepare('DELETE FROM attestations WHERE id = ?').run(id);
        return restorePairsHiddenBy(db, id);
    })();

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'attestation.delete',
        entityType: 'attestation',
        entityId: id,
        ipAddress: getClientAddress(req),
        details: { ...existing, restored_pairs: restoredPairs }
    });

    res.json({ success: true, restored_pairs: restoredPairs });
});

// The two documents the branch publishes, built from what is entered here:
// ?type=session — зачёты и экзамены, ?type=consultations — консультации.
router.get('/attestations/export', async (req, res) => {
    const db = getDb();
    const type = req.query.type === 'consultations' ? 'consultations' : 'session';
    const semester = req.query.semester_id
        ? getSemesterById(db, Number.parseInt(req.query.semester_id, 10))
        : getSemesterForDate(db, formatLocalDate()) || getActiveSemester(db);

    if (!semester) {
        return res.status(404).json({ error: 'Семестр не найден' });
    }

    const kinds = type === 'session' ? ['credit', 'exam'] : ['consultation'];
    const items = selectAttestations(db, `a.semester_id = ? AND a.kind IN (${kinds.map(() => '?').join(', ')})`, [semester.id, ...kinds]);

    if (items.length === 0) {
        return res.status(400).json({ error: type === 'session' ? 'Зачётов и экзаменов в этом семестре пока нет' : 'Консультаций в этом семестре пока нет' });
    }

    // One block per group (a joined pair prints as «23303 / 23313»), one sheet
    // per course. Inside a group зачёты come first, then экзамены, each by date.
    const labels = joinedLabels(db);
    const byGroup = new Map();
    for (const item of items) {
        const entry = byGroup.get(item.group_id) || { name: item.group_name, label: labels.get(item.group_id) || item.group_name, items: [] };
        entry.items.push(item);
        byGroup.set(item.group_id, entry);
    }

    const kindOrder = { credit: 0, exam: 1, consultation: 0 };
    const byCourse = new Map();
    for (const group of [...byGroup.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))) {
        group.items.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.date.localeCompare(b.date) || a.time_start.localeCompare(b.time_start));
        const course = getCourseFromGroupName(group.name) ?? 0;
        byCourse.set(course, [...(byCourse.get(course) || []), group]);
    }
    const courseSheets = [...byCourse.entries()].sort(([a], [b]) => a - b).map(([course, groups]) => ({ course: course || '?', groups }));

    const settings = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
    const [startYear, startMonth] = semester.start_date.split('-').map(Number);
    const isAutumn = startMonth >= 7;

    try {
        const workbook = type === 'session'
            ? buildSessionWorkbook({
                courseSheets,
                termLabel: isAutumn ? 'осенний' : 'весенний',
                academicYear: isAutumn ? `${startYear}/${startYear + 1}` : `${startYear - 1}/${startYear}`,
                studyForm: settings.study_form || 'очная форма обучения',
                directorTitle: settings.director_title || 'Директор филиала',
                directorName: settings.director_name || 'ФИО директора',
                approvalYear: isAutumn ? startYear + 1 : startYear
            })
            : buildConsultationWorkbook({ courseSheets });

        const fileName = type === 'session' ? 'raspisanie_attestatsii.xlsx' : 'raspisanie_konsultatsiy.xlsx';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Attestation export error:', error);
        res.status(500).json({ error: 'Не удалось сформировать файл' });
    }
});

module.exports = router;
