// Groups: create, rename, set the direction, delete (refused while lessons exist).
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { validateGroupCreateBody, validateGroupUpdateBody } = require('../../validation');
const { joinGroup, joinedLabels, unjoinGroup } = require('../../utils/groupJoin');
const { getClientAddress } = require('./shared');

const GROUP_FIELDS = `
    SELECT g.id, g.name, g.direction, g.joined_to, l.name AS joined_to_name, u.short_name as university
    FROM groups_ g
    JOIN universities u ON u.id = g.university_id
    LEFT JOIN groups_ l ON l.id = g.joined_to
`;

// joined_label: "23303 / 23313" on the group the others are joined to.
function withJoinedLabel(db, rows) {
    const labels = joinedLabels(db);
    return rows.map((row) => ({ ...row, joined_label: labels.get(row.id) || null }));
}

function readGroup(db, groupId) {
    return withJoinedLabel(db, [db.prepare(`${GROUP_FIELDS} WHERE g.id = ?`).get(groupId)])[0];
}

const router = express.Router();

router.get('/groups', (req, res) => {
    const db = getDb();
    res.json(withJoinedLabel(db, db.prepare(`${GROUP_FIELDS} ORDER BY u.short_name, g.name`).all()));
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

    let result;

    try {
        result = db.transaction(() => {
            const inserted = db.prepare('INSERT INTO groups_ (university_id, name, direction) VALUES (?, ?, ?)')
                .run(payload.university_id, payload.name, payload.direction);

            if (payload.joined_to) {
                joinGroup(db, Number(inserted.lastInsertRowid), payload.joined_to);
            }

            return inserted;
        })();
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message });
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'group.create',
        entityType: 'group',
        entityId: result.lastInsertRowid,
        ipAddress: getClientAddress(req),
        details: { name: payload.name, university_id: payload.university_id, joined_to: payload.joined_to }
    });

    res.status(201).json(readGroup(db, result.lastInsertRowid));
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

    if (payload.direction !== undefined) {
        db.prepare('UPDATE groups_ SET direction = ? WHERE id = ?').run(payload.direction, groupId);

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'group.update',
            entityType: 'group',
            entityId: groupId,
            ipAddress: getClientAddress(req),
            details: { direction: payload.direction }
        });
    }

    if (payload.joined_to !== undefined) {
        const current = db.prepare('SELECT joined_to FROM groups_ WHERE id = ?').get(groupId).joined_to;

        if (current !== payload.joined_to) {
            let outcome;

            try {
                // Re-pointing to another leader goes through "on its own" first.
                outcome = db.transaction(() => {
                    const split = current ? unjoinGroup(db, groupId) : { copied: 0 };
                    const joined = payload.joined_to ? joinGroup(db, groupId, payload.joined_to) : { removed: 0 };
                    return { ...split, ...joined };
                })();
            } catch (error) {
                return res.status(error.statusCode || 500).json({ error: error.message });
            }

            writeAuditLog(db, {
                adminId: req.admin.id,
                action: payload.joined_to ? 'group.join' : 'group.unjoin',
                entityType: 'group',
                entityId: groupId,
                ipAddress: getClientAddress(req),
                details: { joined_to: payload.joined_to, previous: current, ...outcome }
            });
        }
    }

    res.json(readGroup(db, groupId));
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

    const members = db.prepare('SELECT name FROM groups_ WHERE joined_to = ? ORDER BY name').all(groupId);

    if (members.length > 0) {
        return res.status(409).json({
            error: `С группой «${group.name}» объединены: ${members.map((row) => row.name).join(', ')}. Сначала разъедините их.`
        });
    }

    const lessonCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE group_id = ?').get(groupId).c;
    const planCount = db.prepare(`
        SELECT COUNT(*) c FROM load_plan
        WHERE group_id = ? OR id IN (SELECT plan_id FROM load_plan_extra_groups WHERE group_id = ?)
    `).get(groupId, groupId).c;

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
