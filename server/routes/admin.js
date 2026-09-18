const express = require('express');
const bcrypt = require('bcryptjs');
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

const accountRoutes = require('./admin/account');
const groupsRoutes = require('./admin/groups');
const scheduleRoutes = require('./admin/schedule');
const lessonsRoutes = require('./admin/lessons');
const settingsRoutes = require('./admin/settings');
const backupsRoutes = require('./admin/backups');
const referencesRoutes = require('./admin/references');
const semestersRoutes = require('./admin/semesters');
const loadPlanRoutes = require('./admin/loadPlan');

const router = express.Router();

router.post('/login', (req, res) => {
    let credentials;

    try {
        credentials = validateLoginBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const clientKey = getClientAddress(req);
    const rateLimitInfo = getRateLimitInfo(clientKey);

    if (rateLimitInfo.isBlocked) {
        return res.status(429).json({
            error: 'Слишком много попыток входа. Попробуйте позже.',
            retry_after_sec: Math.ceil(rateLimitInfo.retryAfterMs / 1000)
        });
    }

    const db = getDb();
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(credentials.username);

    if (!admin || !bcrypt.compareSync(credentials.password, admin.password_hash)) {
        registerFailedLogin(clientKey);
        return res.status(401).json({ error: 'Неправильный логин или пароль' });
    }

    clearFailedLoginAttempts(clientKey);

    const token = createToken(admin);
    setAdminAuthCookie(res, token);
    writeAuditLog(db, {
        adminId: admin.id,
        action: 'login.success',
        entityType: 'admin_session',
        entityId: admin.id,
        ipAddress: clientKey,
        details: {
            username: admin.username
        }
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, username: admin.username });
});

router.post('/logout', requireAuth, requireCsrf, (req, res) => {
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
router.use(lessonsRoutes);
router.use(settingsRoutes);
router.use(backupsRoutes);
router.use(referencesRoutes);
router.use(semestersRoutes);
router.use(loadPlanRoutes);

module.exports = router;
