const jwt = require('jsonwebtoken');
const {
    ADMIN_COOKIE_CLEAR_OPTIONS,
    ADMIN_COOKIE_NAME,
    ADMIN_COOKIE_OPTIONS,
    JWT_SECRET
} = require('../config');
const { getDb } = require('../db');
const { createSession, findLiveSession } = require('../sessions');
const { parseCookieHeader } = require('../utils/cookies');

// The token only carries which session it is; whether that session is still
// alive (not logged out, not revoked by a password change, not timed out) is
// asked of the server on every request — see server/sessions.js.
const JWT_EXPIRES_IN = '12h';

function requireAuth(req, res, next) {
    const auth = getAuthFromRequest(req);

    if (!auth.token) {
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    let payload;

    try {
        payload = jwt.verify(auth.token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        clearAdminAuthCookie(res);
        return res.status(401).json({ error: 'Недействительный или просроченный токен' });
    }

    if (!findLiveSession(getDb(), payload.sid, payload.id)) {
        clearAdminAuthCookie(res);
        return res.status(401).json({ error: 'Сессия завершена — войдите снова' });
    }

    req.admin = { id: payload.id, username: payload.username };
    req.sessionId = payload.sid;
    req.authTokenSource = auth.source;
    next();
}

function getAuthFromRequest(req) {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        return {
            token: authHeader.slice(7),
            source: 'bearer'
        };
    }

    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[ADMIN_COOKIE_NAME] || null;

    return {
        token,
        source: token ? 'cookie' : null
    };
}

/** Opens a new server-side session for the admin and returns its signed token. */
function createToken(admin, meta = {}) {
    const sid = createSession(getDb(), admin.id, meta);

    return jwt.sign(
        { id: admin.id, username: admin.username, sid },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN }
    );
}

function setAdminAuthCookie(res, token) {
    res.cookie(ADMIN_COOKIE_NAME, token, ADMIN_COOKIE_OPTIONS);
}

function clearAdminAuthCookie(res) {
    res.clearCookie(ADMIN_COOKIE_NAME, ADMIN_COOKIE_CLEAR_OPTIONS);
}

module.exports = {
    clearAdminAuthCookie,
    createToken,
    requireAuth,
    setAdminAuthCookie
};
