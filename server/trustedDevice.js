const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { DEVICE_COOKIE_OPTIONS, JWT_SECRET } = require('./config');
const { parseCookieHeader } = require('./utils/cookies');

// A browser that has logged in successfully gets a signed, year-long mark
// naming the login and a random device id. It grants nothing by itself — the
// password (and the second factor) are still asked — it only changes whose
// failures can pause this browser: with a mark, only its own
// (login-rate-limit.js). An attacker hammering the login from elsewhere
// therefore cannot lock the specialist out of her own computer. The mark
// can't be forged without JWT_SECRET; a stolen one throttles itself.

const DEVICE_COOKIE_NAME = 'kai_device';

function normalizeLogin(username) {
    return String(username || '').trim().toLowerCase();
}

/** The device id of a valid mark issued for this login, or null. */
function readTrustedDevice(req, username) {
    const token = parseCookieHeader(req.headers.cookie)[DEVICE_COOKIE_NAME];

    if (!token) {
        return null;
    }

    try {
        const mark = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        return mark.purpose === 'device' && mark.u === normalizeLogin(username) && typeof mark.d === 'string' ? mark.d : null;
    } catch {
        return null;
    }
}

/** Sets (or renews for another year) the mark after a successful login. */
function issueTrustedDevice(res, username, device = null) {
    const token = jwt.sign(
        { purpose: 'device', u: normalizeLogin(username), d: device || crypto.randomBytes(16).toString('hex') },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '365d' }
    );
    res.cookie(DEVICE_COOKIE_NAME, token, DEVICE_COOKIE_OPTIONS);
}

module.exports = { DEVICE_COOKIE_NAME, issueTrustedDevice, readTrustedDevice };
