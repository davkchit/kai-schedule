const crypto = require('crypto');
const { JWT_SECRET } = require('../config');

// The second factor: 6-digit codes from an authenticator app (Яндекс Ключ,
// Google Authenticator…) — RFC 6238, SHA-1, 30-second steps, the parameters
// every such app expects. Written out here with node's crypto rather than
// pulled in as a package: it is a few lines, and this is the login.

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either way, for a phone clock that is a little off.
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
    let bits = '';
    for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
    let out = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[Number.parseInt(bits.slice(i, i + 5), 2)];
    return out;
}

function base32Decode(text) {
    let bits = '';
    for (const char of text.replace(/[\s=-]/g, '').toUpperCase()) {
        const index = BASE32.indexOf(char);
        if (index < 0) throw new Error('bad base32');
        bits += index.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}

function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
    return String(value).padStart(DIGITS, '0');
}

function currentStep(now = Date.now()) {
    return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * The step a code belongs to, or null. A code is accepted once: a step at or
 * before `lastUsedStep` is refused, so a code seen over someone's shoulder
 * cannot be replayed within its 30 seconds.
 */
function verifyCode(secret, code, lastUsedStep = null, now = Date.now()) {
    const normalized = String(code || '').replace(/\s/g, '');

    if (!/^\d{6}$/.test(normalized)) {
        return null;
    }

    const step = currentStep(now);

    for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
        const candidate = step + drift;
        const expected = codeAt(secret, candidate);

        if ((lastUsedStep === null || candidate > lastUsedStep)
            && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
            return candidate;
        }
    }

    return null;
}

function otpauthUrl(secret, account, issuer = 'КАИ Расписание') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// The secret is stored encrypted, so a downloaded copy of the database alone
// does not hand out the second factor. The key comes from JWT_SECRET: a
// server with another JWT_SECRET cannot read it — then the second factor is
// reset with `node server/admin-tool.js reset-2fa <login>`.
function encryptionKey() {
    return crypto.createHash('sha256').update(`kai-totp:${JWT_SECRET}`).digest();
}

function encryptSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** The plain secret, or null when it cannot be read (another JWT_SECRET). */
function decryptSecret(stored) {
    try {
        const [version, iv, tag, data] = String(stored).split(':');
        if (version !== 'v1') return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// Recovery codes: for a lost or reset phone. Ten random characters each,
// shown once, stored only as hashes, each usable once.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateRecoveryCodes(count = 8) {
    return Array.from({ length: count }, () => {
        const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join('');
        return `${chars.slice(0, 5)}-${chars.slice(5)}`;
    });
}

function hashRecoveryCode(code) {
    const normalized = String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return crypto.createHash('sha256').update(`kai-recovery:${normalized}`).digest('hex');
}

module.exports = {
    codeAt,
    currentStep,
    decryptSecret,
    encryptSecret,
    generateRecoveryCodes,
    generateSecret,
    hashRecoveryCode,
    otpauthUrl,
    verifyCode
};
