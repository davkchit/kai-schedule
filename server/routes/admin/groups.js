// Groups: create, rename, set the direction, delete (refused while lessons exist).
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { validateGroupCreateBody, validateGroupUpdateBody } = require('../../validation');
const { getClientAddress } = require('./shared');

const router = express.Router();

router.get('/groups', (req, res) => {
    const db = getDb();
    const rows = db.prepare(`
        SELECT g.id, g.name, g.direction, u.short_name as university
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        ORDER BY u.short_name, g.name
    `).all();

    res.json(rows);
});

router.post('/groups', (req, res) => {
    let payload;

    try {
        payload = validateGroupCreateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const university = db.prepare('SELECT id FROM universities WHERE id = ?').get(payload.university_id);

    if (!university) {
        return res.status(404).json({ error: 'Университет не найден' });
    }

    const existing = db.prepare('SELECT id FROM groups_ WHERE university_id = ? AND name = ?')
        .get(payload.university_id, payload.name);

    if (existing) {
        return res.status(409).json({ error: `Группа «${payload.name}» уже существует в этом вузе` });
    }

    const result = db.prepare('INSERT INTO groups_ (university_id, name, direction) VALUES (?, ?, ?)')
        .run(payload.university_id, payload.name, payload.direction);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.create',
        entityType: 'group',
        entityId: result.lastInsertRowid,
        ipAddress: getClientAddress(req),
        details: { name: payload.name, university_id: payload.university_id }
    });

    const created = db.prepare(`
        SELECT g.id, g.name, g.direction, u.short_name as university
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        WHERE g.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(created);
});

router.put('/groups/:id', (req, res) => {
    const db = getDb();
    const groupId = Number(req.params.id);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID группы' });
    }

    const group = db.prepare('SELECT id FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    let payload;

    try {
        payload = validateGroupUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    db.prepare('UPDATE groups_ SET direction = ? WHERE id = ?').run(payload.direction, groupId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.update',
        entityType: 'group',
        entityId: groupId,
        ipAddress: getClientAddress(req),
        details: { direction: payload.direction }
    });

    const updated = db.prepare(`
        SELECT g.id, g.name, g.direction, u.short_name as university
        FROM groups_ g
        JOIN universities u ON u.id = g.university_id
        WHERE g.id = ?
    `).get(groupId);

    res.json(updated);
});

/**
 * Refuses while the group still holds anything. Both foreign keys pointing at
 * groups_ cascade, so an unguarded delete would take the group's whole
 * timetable AND every load_plan row built on it — including hours already
 * counted — with no way back short of a backup. Clear the group first and the
 * delete becomes the harmless thing it looks like.
 */
router.delete('/groups/:id', (req, res) => {
    const groupId = Number.parseInt(req.params.id, 10);

    if (!Number.isInteger(groupId) || groupId <= 0) {
        return res.status(400).json({ error: 'Некорректный ID группы' });
    }

    const db = getDb();
    const group = db.prepare('SELECT id, name FROM groups_ WHERE id = ?').get(groupId);

    if (!group) {
        return res.status(404).json({ error: 'Группа не найдена' });
    }

    const lessonCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ?').get(groupId).c;
    const planCount = db.prepare('SELECT COUNT(*) c FROM load_plan WHERE group_id = ?').get(groupId).c;

    if (lessonCount > 0 || planCount > 0) {
        const parts = [];
        if (lessonCount > 0) parts.push(`пар в расписании: ${lessonCount}`);
        if (planCount > 0) parts.push(`строк в плане нагрузки: ${planCount}`);

        return res.status(409).json({
            error: `Группу «${group.name}» нельзя удалить — ${parts.join(', ')}. Сначала очистите её, иначе вместе с группой пропадут и эти записи.`
        });
    }

    db.prepare('DELETE FROM groups_ WHERE id = ?').run(groupId);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.delete',
        entityType: 'group',
        entityId: groupId,
        ipAddress: getClientAddress(req),
        details: { name: group.name }
    });

    res.json({ success: true, deleted: groupId });
});

module.exports = router;
