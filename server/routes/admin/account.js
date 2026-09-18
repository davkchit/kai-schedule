// Account: the logged-in admin changes their own login or password.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const bcrypt = require('bcryptjs');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { createToken, setAdminAuthCookie } = require('../../middleware/auth');
const { validateAccountUpdateBody } = require('../../validation');
const { getClientAddress } = require('./shared');

const router = express.Router();

router.put('/account', (req, res) => {
    let payload;

    try {
        payload = validateAccountUpdateBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);

    if (!admin || !bcrypt.compareSync(payload.current_password, admin.password_hash)) {
        return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    if (payload.new_username && payload.new_username !== admin.username) {
        const usernameTaken = db.prepare('SELECT id FROM admins WHERE username = ? AND id != ?')
            .get(payload.new_username, admin.id);

        if (usernameTaken) {
            return res.status(409).json({ error: 'Этот логин уже занят' });
        }
    }

    const nextUsername = payload.new_username || admin.username;
    const nextPasswordHash = payload.new_password
        ? bcrypt.hashSync(payload.new_password, 10)
        : admin.password_hash;

    db.prepare('UPDATE admins SET username = ?, password_hash = ? WHERE id = ?')
        .run(nextUsername, nextPasswordHash, admin.id);

    writeAuditLog(db, {
        adminId: admin.id,
        action: 'admin.update_credentials',
        entityType: 'admin_account',
        entityId: admin.id,
        ipAddress: getClientAddress(req),
        details: {
            username_changed: Boolean(payload.new_username && payload.new_username !== admin.username),
            password_changed: Boolean(payload.new_password)
        }
    });

    // Refresh the session so the cookie reflects the new username immediately —
    // otherwise the current browser session would keep showing the old one
    // until the next login.
    const token = createToken({ id: admin.id, username: nextUsername });
    setAdminAuthCookie(res, token);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, username: nextUsername });
});

module.exports = router;
