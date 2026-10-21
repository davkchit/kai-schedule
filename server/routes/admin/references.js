// Reference lists: teachers and disciplines (deletion refused while plan rows use them).
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { validateDisciplineCreateBody, validateTeacherCreateBody } = require('../../validation');
const { getClientAddress } = require('./shared');

const router = express.Router();

// ---------------------------------------------------------------------------
// Teaching-load tracking: teachers, disciplines, semesters, and the load plan
// itself. All of this sits behind the same admin auth as everything else in
// this router — there is no separate, unauthenticated write path for
// teachers. The "either the specialist or the teacher can enter the plan"
// flexibility the department asked for is expressed by the entered_by tag
// on each row (who the number came from), not by a second login system;
// teachers only ever get read access, via the public search endpoint in
// routes/api.js.
// ---------------------------------------------------------------------------

router.get('/teachers', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM teachers ORDER BY full_name').all();
    res.json(rows);
});

router.post('/teachers', (req, res) => {
    let payload;

    try {
        payload = validateTeacherCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();

    try {
        const result = db.prepare('INSERT INTO teachers (full_name) VALUES (?)').run(payload.full_name);
        const created = db.prepare('SELECT * FROM teachers WHERE id = ?').get(result.lastInsertRowid);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'teacher.create',
            entityType: 'teacher',
            entityId: created.id,
            ipAddress: getClientAddress(req),
            details: { full_name: created.full_name }
        });

        res.status(201).json(created);
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такой преподаватель уже есть в справочнике' });
        }

        console.error('Teacher create error:', error);
        res.status(500).json({ error: 'Не удалось добавить преподавателя' });
    }
});

// Rename — the fix for "one letter wrong", so a typo doesn't force a
// delete-and-recreate that would also detach every load_plan row already
// entered against the old (mistyped) name.
router.put('/teachers/:id', (req, res) => {
    const teacherId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID преподавателя' });
    }

    let payload;

    try {
        payload = validateTeacherCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);

    if (!existing) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    try {
        // The pairs carry the name as text too (what students, the builder and
        // the schedule export show): renaming only the dictionary left them on
        // the old spelling while the load pages showed the new one.
        db.transaction(() => {
            db.prepare('UPDATE teachers SET full_name = ? WHERE id = ?').run(payload.full_name, teacherId);
            db.prepare('UPDATE lessons SET teacher = ?, updated_at = CURRENT_TIMESTAMP WHERE teacher_id = ?')
                .run(payload.full_name, teacherId);
        })();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'teacher.update',
            entityType: 'teacher',
            entityId: teacherId,
            ipAddress: getClientAddress(req),
            details: { before: existing.full_name, after: payload.full_name }
        });

        res.json(db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId));
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такой преподаватель уже есть в справочнике' });
        }

        console.error('Teacher update error:', error);
        res.status(500).json({ error: 'Не удалось переименовать преподавателя' });
    }
});

// Blocked while any load_plan row still references this teacher — deleting
// through that would silently cascade-delete those rows (and whatever hours
// were already tracked in them). Reassign or remove those rows first.
router.delete('/teachers/:id', (req, res) => {
    const teacherId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID преподавателя' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);

    if (!existing) {
        return res.status(404).json({ error: 'Преподаватель не найден' });
    }

    const planCount = db.prepare('SELECT COUNT(*) c FROM load_plan WHERE teacher_id = ?').get(teacherId).c;

    if (planCount > 0) {
        return res.status(409).json({
            error: `У этого преподавателя ${planCount} ${pluralizePlanRows(planCount)} в плане нагрузки. Удалите или измените их, затем удаляйте преподавателя.`
        });
    }

    // Every schedule pair this teacher was ever chosen for, in any semester —
    // not just the working one. Hours are matched live against teacher_id
    // now, so deleting a teacher who still has schedule history would either
    // fail at the database's own foreign key (if somehow reached) or, worse,
    // silently null it out and erase what weeks actually happened.
    const lessonCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE teacher_id = ?').get(teacherId).c;

    if (lessonCount > 0) {
        return res.status(409).json({
            error: `Этот преподаватель стоит в расписании — пар (включая прошлые недели): ${lessonCount}. Такого преподавателя удалить нельзя, чтобы не потерять историю занятий; можно переименовать.`
        });
    }

    // Exams, credits and consultations name the teacher by id the same way.
    const attestationCount = db.prepare('SELECT COUNT(*) c FROM attestations WHERE teacher_id = ?').get(teacherId).c;

    if (attestationCount > 0) {
        return res.status(409).json({
            error: `Этот преподаватель стоит в сессии — экзаменов, зачётов и консультаций: ${attestationCount}. Удалить нельзя; можно переименовать.`
        });
    }

    db.prepare('DELETE FROM teachers WHERE id = ?').run(teacherId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'teacher.delete',
        entityType: 'teacher',
        entityId: teacherId,
        ipAddress: getClientAddress(req),
        details: { full_name: existing.full_name }
    });

    res.json({ success: true });
});

router.get('/disciplines', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM disciplines ORDER BY name').all();
    res.json(rows);
});

router.post('/disciplines', (req, res) => {
    let payload;

    try {
        payload = validateDisciplineCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();

    try {
        const result = db.prepare('INSERT INTO disciplines (name) VALUES (?)').run(payload.name);
        const created = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(result.lastInsertRowid);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'discipline.create',
            entityType: 'discipline',
            entityId: created.id,
            ipAddress: getClientAddress(req),
            details: { name: created.name }
        });

        res.status(201).json(created);
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такая дисциплина уже есть в справочнике' });
        }

        console.error('Discipline create error:', error);
        res.status(500).json({ error: 'Не удалось добавить дисциплину' });
    }
});

router.put('/disciplines/:id', (req, res) => {
    const disciplineId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(disciplineId) || disciplineId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID дисциплины' });
    }

    let payload;

    try {
        payload = validateDisciplineCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(disciplineId);

    if (!existing) {
        return res.status(404).json({ error: 'Дисциплина не найдена' });
    }

    try {
        // Same as a teacher rename: the pairs' own subject text follows the dictionary.
        db.transaction(() => {
            db.prepare('UPDATE disciplines SET name = ? WHERE id = ?').run(payload.name, disciplineId);
            db.prepare('UPDATE lessons SET subject = ?, updated_at = CURRENT_TIMESTAMP WHERE discipline_id = ?')
                .run(payload.name, disciplineId);
        })();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'discipline.update',
            entityType: 'discipline',
            entityId: disciplineId,
            ipAddress: getClientAddress(req),
            details: { before: existing.name, after: payload.name }
        });

        res.json(db.prepare('SELECT * FROM disciplines WHERE id = ?').get(disciplineId));
    } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
            return res.status(409).json({ error: 'Такая дисциплина уже есть в справочнике' });
        }

        console.error('Discipline update error:', error);
        res.status(500).json({ error: 'Не удалось переименовать дисциплину' });
    }
});

router.delete('/disciplines/:id', (req, res) => {
    const disciplineId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(disciplineId) || disciplineId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID дисциплины' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT * FROM disciplines WHERE id = ?').get(disciplineId);

    if (!existing) {
        return res.status(404).json({ error: 'Дисциплина не найдена' });
    }

    const planCount = db.prepare('SELECT COUNT(*) c FROM load_plan WHERE discipline_id = ?').get(disciplineId).c;

    if (planCount > 0) {
        return res.status(409).json({
            error: `Эта дисциплина используется в ${planCount} ${pluralizePlanRows(planCount)} плана нагрузки. Удалите или измените их, затем удаляйте дисциплину.`
        });
    }

    // Same reasoning as deleting a teacher: schedule history references this
    // discipline by id now, in every semester, not only the working one.
    const lessonCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE discipline_id = ?').get(disciplineId).c;

    if (lessonCount > 0) {
        return res.status(409).json({
            error: `Эта дисциплина стоит в расписании — пар (включая прошлые недели): ${lessonCount}. Удалить нельзя, чтобы не потерять историю занятий; можно переименовать.`
        });
    }

    const attestationCount = db.prepare('SELECT COUNT(*) c FROM attestations WHERE discipline_id = ?').get(disciplineId).c;

    if (attestationCount > 0) {
        return res.status(409).json({
            error: `Эта дисциплина стоит в сессии — экзаменов, зачётов и консультаций: ${attestationCount}. Удалить нельзя; можно переименовать.`
        });
    }

    db.prepare('DELETE FROM disciplines WHERE id = ?').run(disciplineId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'discipline.delete',
        entityType: 'discipline',
        entityId: disciplineId,
        ipAddress: getClientAddress(req),
        details: { name: existing.name }
    });

    res.json({ success: true });
});

function pluralizePlanRows(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'строка';
    if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'строки';
    return 'строк';
}

module.exports = router;
