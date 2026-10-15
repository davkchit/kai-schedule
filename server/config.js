const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');

dotenv.config({ quiet: true });

// Every "has this pair happened yet?" decision parses a naive local datetime
// ("2026-09-15T16:30:00") and compares it to now, so the process timezone IS
// the university's timezone. Hosts default to UTC — on one, a pair ending
// 16:30 in Naberezhnye Chelny would only count as taught at 19:30 local. Pin
// it here rather than relying on the platform, so a fresh deploy anywhere is
// correct out of the box; TZ in the environment still wins if it is set.
process.env.TZ = process.env.TZ || 'Europe/Moscow';

const isProduction = process.env.NODE_ENV === 'production';
const jwtSecretFromEnv = process.env.JWT_SECRET;
const generatedDevSecret = !jwtSecretFromEnv && !isProduction
    ? crypto.randomBytes(32).toString('hex')
    : null;
const trustProxyValue = parseTrustProxy(process.env.TRUST_PROXY);
const adminAllowedIps = parseCommaSeparatedList(process.env.ADMIN_ALLOWED_IPS);
const backupsDir = resolveOptionalPath(process.env.BACKUPS_DIR);

if (!jwtSecretFromEnv && isProduction) {
    throw new Error('JWT_SECRET is required in production.');
}

if (generatedDevSecret) {
    console.warn('[config] JWT_SECRET is not set. Using a generated development secret. Admin sessions will reset after restart.');
}

const JWT_SECRET = jwtSecretFromEnv || generatedDevSecret;
const PORT = Number(process.env.PORT || 3000);
const ADMIN_COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || 'kai_schedule_admin';
// The whole campus leaves through one NAT address, so a per-IP limit counts a
// thousand students as one visitor. The public ceiling is therefore a flood
// guard, not a per-person quota: it has to sit above what a full building
// reading its timetable during one break produces. Writing is a different
// story — every write needs a login, and one logged-in specialist never makes
// hundreds of requests a minute, so that limit stays tight.
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 5000);
const ADMIN_RATE_LIMIT_MAX = Number(process.env.ADMIN_RATE_LIMIT_MAX || 300);
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000);

// Where to shout when the server is in trouble: a Telegram bot, Discord or
// Slack webhook. Empty means alerts go to the log only.
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || '').trim();
const ALERT_CHAT_ID = (process.env.ALERT_CHAT_ID || '').trim();

const baseCookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: '/api/admin'
};

function getSeedAdminCredentials() {
    const username = (process.env.ADMIN_USERNAME || 'admin').trim();
    const passwordFromEnv = process.env.ADMIN_PASSWORD;

    if (!username) {
        throw new Error('ADMIN_USERNAME must not be empty.');
    }

    if (!passwordFromEnv && isProduction) {
        throw new Error('ADMIN_PASSWORD is required in production when seeding admins.');
    }

    const password = passwordFromEnv || 'admin123';

    if (!passwordFromEnv) {
        console.warn('[seed] ADMIN_PASSWORD is not set. Using development default password.');
    }

    return { username, password };
}

function parseTrustProxy(value) {
    if (value === undefined || value === null || value === '') {
        return false;
    }

    const normalized = String(value).trim().toLowerCase();

    // A bare non-negative integer means "trust exactly this many hops" (what
    // Express and express-rate-limit want behind a single reverse proxy like
    // Caddy in production) — checked BEFORE the word-based true/false so "1" and
    // "0" resolve to the hop-count 1/0, not to the fully-permissive boolean
    // `true` (which trusts every hop and lets a client spoof X-Forwarded-For
    // to bypass IP-based rate limiting).
    if (/^\d+$/.test(normalized)) {
        return Number.parseInt(normalized, 10);
    }

    if (['true', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    const asNumber = Number.parseInt(normalized, 10);

    if (Number.isInteger(asNumber) && asNumber >= 0) {
        return asNumber;
    }

    return false;
}

function parseCommaSeparatedList(value) {
    if (value === undefined || value === null || value === '') {
        return [];
    }

    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveOptionalPath(value) {
    if (!value) {
        return null;
    }

    return path.isAbsolute(value)
        ? value
        : path.resolve(process.cwd(), value);
}

module.exports = {
    PORT,
    isProduction,
    JWT_SECRET,
    API_RATE_LIMIT_MAX,
    ADMIN_RATE_LIMIT_MAX,
    API_RATE_LIMIT_WINDOW_MS,
    ALERT_WEBHOOK_URL,
    ALERT_CHAT_ID,
    TRUST_PROXY: trustProxyValue,
    parseTrustProxy,
    ADMIN_ALLOWED_IPS: adminAllowedIps,
    BACKUPS_DIR: backupsDir,
    ADMIN_COOKIE_NAME,
    ADMIN_COOKIE_OPTIONS: {
        ...baseCookieOptions,
        maxAge: 24 * 60 * 60 * 1000
    },
    ADMIN_COOKIE_CLEAR_OPTIONS: baseCookieOptions,
    getSeedAdminCredentials
};
