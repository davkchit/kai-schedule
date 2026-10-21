// Account: the logged-in admin changes their own login or password.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const bcrypt = require('bcryptjs');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { clearAdminAuthCookie, createToken, setAdminAuthCookie } = require('../../middleware/auth');
const QRCode = require('qrcode');
const { deleteAdminSessions } = require('../../sessions');
const { checkSecondFactor, recoveryCodesLeft, replaceRecoveryCodes } = require('../../secondFactor');
const { decryptSecret, encryptSecret, generateSecret, otpauthUrl, verifyCode } = require('../../utils/totp');
const { validateAccountUpdateBody } = require('../../validation');
const { getClientAddress } = require('./shared');

const router = express.Router();

/** The admin row, or a 401 already sent when the current password is wrong. */
function adminWithPassword(req, res) {
    const admin = getDb().prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);

    if (!admin || typeof req.body?.current_password !== 'string' || !bcrypt.compareSync(req.body.current_password, admin.password_hash)) {
        res.status(401).json({ error: 'Неверный текущий пароль' });
        return null;
    }

    return admin;
}

function auditAccount(req, action, details = null) {
    writeAuditLog(getDb(), {
        adminId: req.admin.id,
        action,
        entityType: 'admin_account',
        entityId: req.admin.id,
        ipAddress: getClientAddress(req),
        details
    });
}

router.get('/account/security', (req, res) => {
    const db = getDb();
    const admin = db.prepare('SELECT id, username, totp_enabled FROM admins WHERE id = ?').get(req.admin.id);

    res.json({
        username: admin.username,
        totp_enabled: Boolean(admin.totp_enabled),
        recovery_codes_left: recoveryCodesLeft(db, admin.id),
        sessions_active: db.prepare('SELECT COUNT(*) AS c FROM admin_sessions WHERE admin_id = ?').get(admin.id).c
    });
});

// Turning the second factor on takes the password (a session left open on
// someone else's computer must not be able to lock the owner out with a
// phone of its own) and a working code from the app (it was set up right).
router.post('/account/totp/setup', async (req, res) => {
    const admin = adminWithPassword(req, res);
    if (!admin) return undefined;

    const secret = generateSecret();
    getDb().prepare('UPDATE admins SET totp_pending_secret = ? WHERE id = ?').run(encryptSecret(secret), admin.id);
    const url = otpauthUrl(secret, admin.username);

    res.set('Cache-Control', 'no-store');
    res.json({
        secret: secret.match(/.{1,4}/g).join(' '),
        otpauth_url: url,
        qr_svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    });
});

router.post('/account/totp/enable', (req, res) => {
    const db = getDb();
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    const secret = admin.totp_pending_secret ? decryptSecret(admin.totp_pending_secret) : null;

    if (!secret) {
        return res.status(409).json({ error: 'Начните настройку заново' });
    }

    const step = verifyCode(secret, req.body?.code);

    if (step === null) {
        return res.status(400).json({ error: 'Код не подошёл — проверьте, что время на телефоне верное, и введите новый код' });
    }

    db.prepare(`
        UPDATE admins SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = 1, totp_last_step = ?
        WHERE id = ?
    `).run(step, admin.id);
    const codes = replaceRecoveryCodes(db, admin.id);
    auditAccount(req, 'admin.totp_enable');

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, recovery_codes: codes });
});

router.post('/account/totp/disable', (req, res) => {
    const admin = adminWithPassword(req, res);
    if (!admin) return undefined;

    const db = getDb();

    if (admin.totp_enabled && !checkSecondFactor(db, admin, req.body?.code).ok) {
        return res.status(400).json({ error: 'Неверный код' });
    }

    db.prepare('UPDATE admins SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?').run(admin.id);
    db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(admin.id);
    auditAccount(req, 'admin.totp_disable');
    res.json({ success: true });
});

router.post('/account/totp/recovery-codes', (req, res) => {
    const admin = adminWithPassword(req, res);
    if (!admin) return undefined;

    if (!admin.totp_enabled) {
        return res.status(409).json({ error: 'Сначала включите вход с кодом' });
    }

    const codes = replaceRecoveryCodes(getDb(), admin.id);
    auditAccount(req, 'admin.recovery_codes');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, recovery_codes: codes });
});

// «Выйти на всех устройствах»: a computer left logged in somewhere, a phone
// lost — every session of this admin ends, this one too.
router.post('/account/logout-everywhere', (req, res) => {
    const db = getDb();
    const ended = deleteAdminSessions(db, req.admin.id);

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'admin.logout_everywhere',
        entityType: 'admin_account',
        entityId: req.admin.id,
        ipAddress: getClientAddress(req),
        details: { sessions_ended: ended }
    });

    clearAdminAuthCookie(res);
    res.json({ success: true, sessions_ended: ended });
});

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

    if (payload.new_password && payload.new_password.toLowerCase().includes(nextUsername.toLowerCase())) {
        return res.status(400).json({ error: 'Пароль не должен содержать логин' });
    }
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

    // New credentials end every session (a stolen one included), then this
    // browser gets a fresh one so the specialist stays logged in here.
    deleteAdminSessions(db, admin.id);
    const token = createToken({ id: admin.id, username: nextUsername }, { ip: getClientAddress(req), userAgent: req.get('user-agent') });
    setAdminAuthCookie(res, token);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, username: nextUsername });
});

module.exports = router;
