const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { checkSecondFactor } = require('../secondFactor');
const { writeAuditLog } = require('../audit');
const { getDb } = require('../db');
const {
    clearAdminAuthCookie,
    createToken,
    requireAuth,
    setAdminAuthCookie
} = require('../middleware/auth');
const { ensureCsrfToken, requireCsrf } = require('../middleware/csrf');
const { clearFailedLoginAttempts, getRateLimitInfo, registerFailedLogin } = require('../login-rate-limit');
const { validateLoginBody } = require('../validation');
const { getClientAddress } = require('./admin/shared');
const { deleteSession } = require('../sessions');
const { issueTrustedDevice, readTrustedDevice } = require('../trustedDevice');

// bcrypt hash of a random string nobody knows, compared against when the
// username does not exist (see /login).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(require('crypto').randomBytes(16).toString('hex'), 10);

const accountRoutes = require('./admin/account');
const groupsRoutes = require('./admin/groups');
const scheduleRoutes = require('./admin/schedule');
const scheduleWeekRoutes = require('./admin/scheduleWeek');
const lessonsRoutes = require('./admin/lessons');
const settingsRoutes = require('./admin/settings');
const backupsRoutes = require('./admin/backups');
const referencesRoutes = require('./admin/references');
const semestersRoutes = require('./admin/semesters');
const loadPlanRoutes = require('./admin/loadPlan');
const attestationsRoutes = require('./admin/attestations');

const router = express.Router();

router.post('/login', (req, res) => {
    let credentials;

    try {
        credentials = validateLoginBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const clientKey = getClientAddress(req);
    // A browser that logged in as this user before is throttled on its own.
    const device = readTrustedDevice(req, credentials.username);
    const rateLimitInfo = getRateLimitInfo(clientKey, credentials.username, device);

    if (rateLimitInfo.isBlocked) {
        return res.status(429).json({
            error: 'Слишком много попыток входа. Попробуйте позже.',
            retry_after_sec: Math.ceil(rateLimitInfo.retryAfterMs / 1000)
        });
    }

    const db = getDb();
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(credentials.username);
    // A missing account still costs one bcrypt comparison, so the answer
    // time does not tell whether the username exists.
    const passwordOk = bcrypt.compareSync(credentials.password, admin ? admin.password_hash : DUMMY_PASSWORD_HASH);

    if (!admin || !passwordOk) {
        registerFailedLogin(clientKey, credentials.username, device);
        writeAuditLog(db, {
            adminId: null,
            action: 'login.failed',
            entityType: 'admin_session',
            entityId: null,
            ipAddress: clientKey,
            details: { username: credentials.username.slice(0, 100), ...(device ? { trusted_device: true } : {}) }
        });
        return res.status(401).json({ error: 'Неправильный логин или пароль' });
    }

    // With the second factor on, the right password only earns a short-lived
    // ticket for the code step; no session yet, and the failure counters stay
    // until the whole login succeeds.
    if (admin.totp_enabled) {
        const ticket = jwt.sign({ id: admin.id, purpose: 'second_factor', device }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
        res.set('Cache-Control', 'no-store');
        return res.json({ needs_second_factor: true, ticket });
    }

    completeLogin(req, res, db, admin, 'password', device);
});

router.post('/login/second-factor', (req, res) => {
    const clientKey = getClientAddress(req);
    const db = getDb();
    let ticket;

    try {
        ticket = jwt.verify(String(req.body?.ticket || ''), JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ error: 'Время на ввод кода вышло — войдите снова', restart: true });
    }

    const admin = ticket.purpose === 'second_factor' ? db.prepare('SELECT * FROM admins WHERE id = ?').get(ticket.id) : null;

    if (!admin || !admin.totp_enabled) {
        return res.status(401).json({ error: 'Войдите снова', restart: true });
    }

    const device = typeof ticket.device === 'string' ? ticket.device : null;
    const rateLimitInfo = getRateLimitInfo(clientKey, admin.username, device);

    if (rateLimitInfo.isBlocked) {
        return res.status(429).json({
            error: 'Слишком много попыток входа. Попробуйте позже.',
            retry_after_sec: Math.ceil(rateLimitInfo.retryAfterMs / 1000)
        });
    }

    const result = checkSecondFactor(db, admin, req.body?.code);

    if (!result.ok) {
        registerFailedLogin(clientKey, admin.username, device);
        writeAuditLog(db, {
            adminId: admin.id,
            action: 'login.failed',
            entityType: 'admin_session',
            entityId: admin.id,
            ipAddress: clientKey,
            details: { username: admin.username, stage: 'second_factor' }
        });

        return res.status(401).json({
            error: result.unreadable
                ? 'Код из приложения не читается на этом сервере — войдите резервным кодом или сбросьте второй фактор на сервере'
                : 'Неверный код'
        });
    }

    completeLogin(req, res, db, admin, result.method, device);
});

function completeLogin(req, res, db, admin, method, device = null) {
    const clientKey = getClientAddress(req);
    clearFailedLoginAttempts(clientKey, admin.username, device);
    issueTrustedDevice(res, admin.username, device);

    const token = createToken(admin, { ip: clientKey, userAgent: req.get('user-agent') });
    setAdminAuthCookie(res, token);
    writeAuditLog(db, {
        adminId: admin.id,
        action: method === 'recovery' ? 'login.recovery_code' : 'login.success',
        entityType: 'admin_session',
        entityId: admin.id,
        ipAddress: clientKey,
        details: {
            username: admin.username,
            method
        }
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, username: admin.username });
}

router.post('/logout', requireAuth, requireCsrf, (req, res) => {
    // The session itself ends, not just this browser's cookie.
    deleteSession(getDb(), req.sessionId);
    clearAdminAuthCookie(res);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true });
});

router.get('/session', requireAuth, (req, res) => {
    const csrfToken = ensureCsrfToken(req, res);
    res.set('Cache-Control', 'no-store');
    res.json({ authenticated: true, admin: req.admin, csrf_token: csrfToken });
});

router.use(requireAuth);

router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.use(requireCsrf);

// Everything below runs only for a logged-in admin, with CSRF checked on
// writes. Mounted in the same order the routes were originally declared.
router.use(accountRoutes);
router.use(groupsRoutes);
router.use(scheduleRoutes);
router.use(scheduleWeekRoutes);
router.use(lessonsRoutes);
router.use(settingsRoutes);
router.use(backupsRoutes);
router.use(referencesRoutes);
router.use(semestersRoutes);
router.use(loadPlanRoutes);
router.use(attestationsRoutes);

module.exports = router;
