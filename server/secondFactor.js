const { decryptSecret, generateRecoveryCodes, hashRecoveryCode, verifyCode } = require('./utils/totp');

/**
 * Checks a second-factor code for an admin: a 6-digit code from the app, or
 * one of the recovery codes. Marks what it used (the app code's step, the
 * recovery code itself) so neither works twice.
 *
 * Returns { ok, method: 'totp' | 'recovery', unreadable } — unreadable is set
 * when the stored secret cannot be decrypted here (another JWT_SECRET):
 * recovery codes still work then.
 */
function checkSecondFactor(db, admin, code) {
    const secret = admin.totp_secret ? decryptSecret(admin.totp_secret) : null;

    if (secret) {
        const step = verifyCode(secret, code, admin.totp_last_step);

        if (step !== null) {
            db.prepare('UPDATE admins SET totp_last_step = ? WHERE id = ?').run(step, admin.id);
            return { ok: true, method: 'totp' };
        }
    }

    const recovery = db.prepare('SELECT id FROM admin_recovery_codes WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL')
        .get(admin.id, hashRecoveryCode(code));

    if (recovery) {
        db.prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE id = ?').run(Date.now(), recovery.id);
        return { ok: true, method: 'recovery' };
    }

    return { ok: false, unreadable: Boolean(admin.totp_secret) && !secret };
}

/** New recovery codes for an admin (the old ones stop working); returns them in plain text, once. */
function replaceRecoveryCodes(db, adminId) {
    const codes = generateRecoveryCodes();
    const insert = db.prepare('INSERT INTO admin_recovery_codes (admin_id, code_hash) VALUES (?, ?)');

    db.transaction(() => {
        db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(adminId);
        codes.forEach((code) => insert.run(adminId, hashRecoveryCode(code)));
    })();

    return codes;
}

function recoveryCodesLeft(db, adminId) {
    return db.prepare('SELECT COUNT(*) AS c FROM admin_recovery_codes WHERE admin_id = ? AND used_at IS NULL').get(adminId).c;
}

module.exports = { checkSecondFactor, recoveryCodesLeft, replaceRecoveryCodes };
