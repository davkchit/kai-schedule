const crypto = require('crypto');

// Admin sessions kept on the server. The signed cookie alone could not be
// taken back: «Выйти» only deleted it from one browser, and a copied token,
// or one left on a shared computer, stayed valid for a day even after the
// password was changed. Now each login is a row here, the token names it, and
// a request is let in only while the row exists and has not timed out.
//
// Timeouts follow the usual guidance for an admin area: ended after a few
// idle hours, and in any case after a working day, whatever the activity.

const SESSION_IDLE_MS = 4 * 60 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
// last_seen is written at most this often, not on every request.
const TOUCH_EVERY_MS = 60 * 1000;

function createSession(db, adminId, { ip = null, userAgent = null } = {}) {
    const id = crypto.randomBytes(24).toString('hex');
    const now = Date.now();

    pruneSessions(db, now);
    db.prepare(`
        INSERT INTO admin_sessions (id, admin_id, created_at, last_seen_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, adminId, now, now, ip, userAgent ? String(userAgent).slice(0, 200) : null);

    return id;
}

/** The live session row for this token, or null (missing, revoked or timed out). */
function findLiveSession(db, sessionId, adminId) {
    if (typeof sessionId !== 'string' || !sessionId) {
        return null;
    }

    const session = db.prepare('SELECT * FROM admin_sessions WHERE id = ? AND admin_id = ?').get(sessionId, adminId);
    const now = Date.now();

    if (!session || now - session.created_at > SESSION_MAX_MS || now - session.last_seen_at > SESSION_IDLE_MS) {
        if (session) deleteSession(db, sessionId);
        return null;
    }

    if (now - session.last_seen_at > TOUCH_EVERY_MS) {
        db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(now, sessionId);
    }

    return session;
}

function deleteSession(db, sessionId) {
    db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(sessionId);
}

function deleteAdminSessions(db, adminId) {
    return db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(adminId).changes;
}

function pruneSessions(db, now = Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE created_at < ? OR last_seen_at < ?')
        .run(now - SESSION_MAX_MS, now - SESSION_IDLE_MS);
}

module.exports = {
    SESSION_IDLE_MS,
    SESSION_MAX_MS,
    createSession,
    deleteAdminSessions,
    deleteSession,
    findLiveSession
};
