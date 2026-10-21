const { getDb } = require('./db');

// Slowing down password guessing without letting anyone lock the admin out
// for good.
//
// Failures are counted twice: per username (guessing one account from many
// addresses) and per address (one address trying many accounts). Counting
// per address alone missed the first; and the whole campus shares one NAT
// address, so the per-address allowance is larger. A username that does not
// exist is counted like one that does, so the answer never tells which exist.
//
// Every block is temporary: after a few free attempts the pause doubles with
// each further failure, from 30 seconds up to 15 minutes, and is never
// permanent — a lockout an attacker can extend forever would be a way to keep
// the specialist out. Failures are forgotten an hour after the last one.
// If the admin is ever stuck, `node server/admin-tool.js unlock` clears it.
//
// Still, anyone who knows the login could keep it paused by failing on
// purpose. A browser that has logged in before carries a signed device mark
// (server/trustedDevice.js); from it, failures are counted for that device
// alone, so strangers' failures never pause the specialist's own computer.

const FORGET_AFTER_MS = 60 * 60 * 1000;
const FIRST_PAUSE_MS = 30 * 1000;
const MAX_PAUSE_MS = 15 * 60 * 1000;
const FREE_ATTEMPTS = { user: 5, ip: 20, device: 5 };

function loginKeys(clientAddress, username, device = null) {
    if (device) {
        return [{ key: `device:${device}`, free: FREE_ATTEMPTS.device }];
    }

    return [
        { key: `ip:${clientAddress}`, free: FREE_ATTEMPTS.ip },
        { key: `user:${String(username || '').trim().toLowerCase()}`, free: FREE_ATTEMPTS.user }
    ];
}

function pauseFor(failures, free) {
    if (failures < free) {
        return 0;
    }

    return Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** (failures - free));
}

/** { isBlocked, retryAfterMs } for this address + username, or for a trusted device. */
function getRateLimitInfo(clientAddress, username, device = null) {
    const db = getDb();
    const now = Date.now();

    pruneExpiredAttempts(db, now);

    let retryAfterMs = 0;
    const read = db.prepare('SELECT failure_count, window_started_at FROM login_attempts WHERE client_key = ?');

    for (const { key, free } of loginKeys(clientAddress, username, device)) {
        const record = read.get(key);

        if (record) {
            // window_started_at holds the time of the latest failure.
            const remaining = record.window_started_at + pauseFor(record.failure_count, free) - now;
            retryAfterMs = Math.max(retryAfterMs, remaining);
        }
    }

    return { isBlocked: retryAfterMs > 0, retryAfterMs: Math.max(0, retryAfterMs) };
}

function registerFailedLogin(clientAddress, username, device = null) {
    const db = getDb();
    const now = Date.now();
    const upsert = db.prepare(`
        INSERT INTO login_attempts (client_key, failure_count, window_started_at, updated_at)
        VALUES (?, 1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(client_key) DO UPDATE SET
            failure_count = failure_count + 1,
            window_started_at = excluded.window_started_at,
            updated_at = CURRENT_TIMESTAMP
    `);

    pruneExpiredAttempts(db, now);

    for (const { key } of loginKeys(clientAddress, username, device)) {
        upsert.run(key, now);
    }
}

function clearFailedLoginAttempts(clientAddress, username, device = null) {
    const remove = getDb().prepare('DELETE FROM login_attempts WHERE client_key = ?');

    // From a trusted device only its own count is cleared: strangers' failures
    // keep counting, or each of her logins would hand them fresh attempts.
    for (const { key } of loginKeys(clientAddress, username, device)) {
        remove.run(key);
    }
}

function pruneExpiredAttempts(db, now) {
    db.prepare('DELETE FROM login_attempts WHERE window_started_at <= ?').run(now - FORGET_AFTER_MS);
}

module.exports = {
    clearFailedLoginAttempts,
    getRateLimitInfo,
    registerFailedLogin
};
