const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { ensureAdminAccessAllowed } = require('./access-control');
const { ADMIN_RATE_LIMIT_MAX, API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MS, TRUST_PROXY, isProduction } = require('./config');
const { getDb } = require('./db');
const { notify } = require('./alerts');
const { getActiveSemester } = require('./utils/semesters');

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

function createApp() {
    const app = express();
    const distDir = path.join(__dirname, '..', 'dist');
    const hasFrontendBuild = fs.existsSync(path.join(distDir, 'index.html'));
    const appEntryFile = path.join(distDir, 'index.html');

    app.disable('x-powered-by');

    if (TRUST_PROXY !== false) {
        app.set('trust proxy', TRUST_PROXY);
    }

    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

        // HTTPS only from here on: a browser that once saw the site never
        // lets itself be talked into plain HTTP (a café Wi-Fi stripping TLS).
        if (isProduction) {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        res.setHeader(
            'Content-Security-Policy',
            [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                "font-src 'self' https://fonts.gstatic.com data:",
                "img-src 'self' data:",
                "connect-src 'self'",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'self'",
                "frame-ancestors 'none'"
            ].join('; ')
        );

        if (req.path.startsWith('/api/admin') || req.path.startsWith('/admin')) {
            res.setHeader('Cache-Control', 'no-store');
        }

        next();
    });

    // Public endpoints take tiny bodies (only the error report); the admin's
    // largest JSON is a whole-branch schedule upload.
    app.use('/api/admin', express.json({ limit: '2mb' }));
    app.use(express.json({ limit: '16kb' }));

    // Deliberately before the rate limiter and before every route: an uptime
    // monitor has to be able to ask "are you alive?" even while the server is
    // being hammered, and the answer has to touch the database — a process
    // that answers but cannot read the schedule is not actually up.
    app.get('/api/health', (req, res) => {
        try {
            const db = getDb();
            const groups = db.prepare('SELECT COUNT(*) AS count FROM groups_').get().count;
            const semester = getActiveSemester(db);

            res.set('Cache-Control', 'no-store').json({
                status: 'ok',
                database: 'ok',
                groups,
                working_semester: semester ? semester.label : null,
                uptime_seconds: Math.round(process.uptime()),
                time: new Date().toISOString()
            });
        } catch (error) {
            notify(`Проверка живости не прошла: база не отвечает (${error.message})`, { key: 'health-db' });
            res.status(503).set('Cache-Control', 'no-store').json({ status: 'error', database: 'error' });
        }
    });

    // Coarse volumetric guard over public reads. The whole campus shares one
    // address, so this is a flood ceiling rather than a per-person quota.
    app.use('/api', rateLimit({
        windowMs: API_RATE_LIMIT_WINDOW_MS,
        limit: API_RATE_LIMIT_MAX,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Слишком много запросов. Попробуйте позже.' }
    }));

    // Writing requires a login, and one specialist never makes hundreds of
    // requests a minute — so the admin area keeps the tight limit.
    app.use('/api/admin', rateLimit({
        windowMs: API_RATE_LIMIT_WINDOW_MS,
        limit: ADMIN_RATE_LIMIT_MAX,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Слишком много запросов. Попробуйте позже.' }
    }));

    // Anyone can post an error report, and each one goes to the alert
    // webhook: a handful a minute per address is plenty for real crashes.
    app.use('/api/client-error', rateLimit({
        windowMs: API_RATE_LIMIT_WINDOW_MS,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { error: 'Слишком много запросов. Попробуйте позже.' }
    }));

    app.use('/api/admin', ensureAdminAccessAllowed, adminRoutes);
    app.use('/admin', ensureAdminAccessAllowed);
    app.use('/api', apiRoutes);

    if (hasFrontendBuild) {
        app.use(express.static(distDir));
    }

    app.use((req, res, next) => {
        if (req.path.startsWith('/api')) {
            return next();
        }

        if (req.method !== 'GET') {
            return next();
        }

        if (!hasFrontendBuild) {
            return res.status(503).send('Frontend build not found. Run "npm run build" or "npm run dev".');
        }

        res.sendFile(appEntryFile);
    });

    app.use((error, req, res, next) => {
        if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
            return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
        }

        if (res.headersSent) {
            return next(error);
        }

        console.error('Unhandled server error:', error);
        notify(`Ошибка 500 на ${req.method} ${req.originalUrl}: ${error.message}`, { key: `500:${req.path}` });
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    });

    getDb();

    return { app, hasFrontendBuild };
}

module.exports = {
    createApp
};
