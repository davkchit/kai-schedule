const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// Login and session protection: sessions that can be ended, guessing slowed
// down without a permanent lockout, the second factor, and the server-side
// tool that gets the admin back in.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.ADMIN_RATE_LIMIT_MAX = '100000';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-security-'));
process.env.DB_PATH = path.join(tempDir, 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { closeDb, getDb } = require('../server/db');
const { codeAt, currentStep } = require('../server/utils/totp');

const PASSWORD = 'correct horse battery';
let server;
let baseUrl;

test.before(async () => {
    const db = getDb();
    db.exec('DELETE FROM admin_sessions; DELETE FROM login_attempts; DELETE FROM admins;');
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('zhenya', bcrypt.hashSync(PASSWORD, 4));
    const { app } = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));

const resetAttempts = () => getDb().prepare('DELETE FROM login_attempts').run();

/** A browser: keeps cookies, sends the CSRF token on writes. */
function browser() {
    const jar = new Map();
    let csrf = null;

    async function call(method, url, body, extra = {}) {
        const headers = { 'Content-Type': 'application/json', ...extra };
        if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
        const response = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(';');
            const [name, ...rest] = pair.split('=');
            const value = rest.join('=');
            if (value) jar.set(name, value); else jar.delete(name);
        }
        const data = await response.json().catch(() => null);
        return { status: response.status, data };
    }

    return {
        call,
        async login(password = PASSWORD, username = 'zhenya') {
            const result = await call('POST', '/api/admin/login', { username, password });
            if (result.status === 200 && result.data.success) await this.session();
            return result;
        },
        async session() {
            const result = await call('GET', '/api/admin/session');
            csrf = result.data?.csrf_token || csrf;
            return result;
        }
    };
}

test('TOTP codes match the RFC 6238 test vectors', () => {
    // Secret "12345678901234567890" (ASCII), SHA-1: at 59 s → 94287082, at 1111111109 s → 07081804 (8 digits).
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
    assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');
});

test('logging out ends the session itself; a password change ends the others; «выйти везде» ends all', async () => {
    resetAttempts();
    const office = browser();
    const home = browser();
    assert.equal((await office.login()).status, 200);
    assert.equal((await home.login()).status, 200);
    assert.equal((await home.call('GET', '/api/admin/settings')).status, 200);

    // A copied cookie does not outlive the logout.
    const stolen = browser();
    await office.call('POST', '/api/admin/logout');
    assert.equal((await office.call('GET', '/api/admin/settings')).status, 401);
    void stolen;

    // New password: other sessions end, this one goes on.
    const changer = browser();
    await changer.login();
    const changed = await changer.call('PUT', '/api/admin/account', { current_password: PASSWORD, new_password: 'a much longer password' });
    assert.equal(changed.status, 200);
    assert.equal((await home.call('GET', '/api/admin/settings')).status, 401, 'the other browser is logged out');
    assert.equal((await changer.call('GET', '/api/admin/settings')).status, 200, 'the one that changed it stays in');

    await changer.call('POST', '/api/admin/account/logout-everywhere');
    assert.equal((await changer.call('GET', '/api/admin/settings')).status, 401);

    // Back to the original password for the next tests.
    getDb().prepare('UPDATE admins SET password_hash = ? WHERE id = 1').run(bcrypt.hashSync(PASSWORD, 4));
});

test('a session ends after hours without activity, and in any case after a working day', async () => {
    resetAttempts();
    const office = browser();
    await office.login();
    const db = getDb();

    db.prepare('UPDATE admin_sessions SET last_seen_at = ? ').run(Date.now() - 5 * 60 * 60 * 1000);
    assert.equal((await office.call('GET', '/api/admin/settings')).status, 401, 'idle for 5 hours');

    await office.login();
    db.prepare('UPDATE admin_sessions SET created_at = ?, last_seen_at = ?').run(Date.now() - 13 * 60 * 60 * 1000, Date.now());
    assert.equal((await office.call('GET', '/api/admin/settings')).status, 401, 'older than 12 hours, though active');
});

test('guessing is slowed per login and per address, never forever, and an unknown login answers the same way', async () => {
    resetAttempts();
    const attacker = browser();

    for (let i = 0; i < 5; i += 1) {
        assert.equal((await attacker.login('wrong password')).status, 401);
    }
    const blocked = await attacker.login();
    assert.equal(blocked.status, 429, 'even the right password waits out the pause');
    assert.ok(blocked.data.retry_after_sec > 0 && blocked.data.retry_after_sec <= 30);

    // Temporary: once the pause is over (moved into the past here), the right password works.
    getDb().prepare('UPDATE login_attempts SET window_started_at = window_started_at - 31000').run();
    assert.equal((await attacker.login()).status, 200);

    // An unknown login: the same 401, and it is counted all the same.
    resetAttempts();
    for (let i = 0; i < 5; i += 1) {
        const result = await attacker.login('x', 'nobody');
        assert.equal(result.status, 401);
        assert.equal(result.data.error, 'Неправильный логин или пароль');
    }
    assert.equal((await attacker.login('x', 'nobody')).status, 429);
    // …while the real admin from the same (campus) address is not locked by it.
    assert.equal((await browser().login()).status, 200);

    const failures = getDb().prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'login.failed'").get().c;
    assert.ok(failures >= 10, 'failed logins are in the journal');
    resetAttempts();
});

test('strangers failing on purpose cannot lock the specialist out of a browser she has logged in from', async () => {
    resetAttempts();
    const office = browser();
    assert.equal((await office.login()).status, 200, 'the office browser gets its device mark');

    const attacker = browser();
    for (let i = 0; i < 10; i += 1) await attacker.login('wrong password');
    assert.equal((await attacker.login()).status, 429, 'the login is paused for unknown browsers');
    assert.equal((await browser().login()).status, 429, 'a new browser waits too');
    assert.equal((await office.login()).status, 200, 'the office browser still gets in');

    // The mark is for one login and cannot be made up.
    const forged = browser();
    const otherLogin = await forged.call('POST', '/api/admin/login', { username: 'zhenya', password: PASSWORD }, { Cookie: 'kai_device=not-a-real-mark' });
    assert.equal(otherLogin.status, 429);

    // A marked browser that keeps failing pauses itself.
    for (let i = 0; i < 5; i += 1) await office.login('wrong password');
    assert.equal((await office.login()).status, 429);
    resetAttempts();
});

test('second factor: set up with the password and a code, then the login asks for it; codes and recovery codes work once', async () => {
    resetAttempts();
    const owner = browser();
    await owner.login();

    assert.equal((await owner.call('POST', '/api/admin/account/totp/setup', { current_password: 'wrong' })).status, 401, 'an open session alone cannot turn it on');
    const setup = await owner.call('POST', '/api/admin/account/totp/setup', { current_password: PASSWORD });
    assert.equal(setup.status, 200);
    assert.match(setup.data.qr_svg, /<svg/);
    assert.match(setup.data.otpauth_url, /^otpauth:\/\/totp\//);
    const secret = setup.data.secret.replace(/\s/g, '');

    assert.equal((await owner.call('POST', '/api/admin/account/totp/enable', { code: '000000' })).status, 400);
    const enabled = await owner.call('POST', '/api/admin/account/totp/enable', { code: codeAt(secret, currentStep()) });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.recovery_codes.length, 8);
    assert.equal(getDb().prepare('SELECT totp_secret FROM admins WHERE id = 1').get().totp_secret.includes(secret), false, 'stored encrypted');

    // The password alone no longer opens a session.
    const phone = browser();
    const first = await phone.login();
    assert.equal(first.data.needs_second_factor, true);
    assert.equal((await phone.call('GET', '/api/admin/settings')).status, 401);

    const wrong = await phone.call('POST', '/api/admin/login/second-factor', { ticket: first.data.ticket, code: '123456' });
    assert.equal(wrong.status, 401);

    // The code just used to enable is spent: the next step's code is needed.
    const nextCode = codeAt(secret, currentStep() + 1);
    const ok = await phone.call('POST', '/api/admin/login/second-factor', { ticket: first.data.ticket, code: nextCode });
    assert.equal(ok.status, 200);
    await phone.session();
    assert.equal((await phone.call('GET', '/api/admin/settings')).status, 200);

    const replay = browser();
    const again = await replay.login();
    assert.equal((await replay.call('POST', '/api/admin/login/second-factor', { ticket: again.data.ticket, code: nextCode })).status, 401, 'a code works once');

    // A recovery code instead of the phone, once.
    const [recovery] = enabled.data.recovery_codes;
    const lostPhone = browser();
    const ticket = (await lostPhone.login()).data.ticket;
    assert.equal((await lostPhone.call('POST', '/api/admin/login/second-factor', { ticket, code: recovery.toUpperCase() })).status, 200);
    const ticket2 = (await browser().login()).data.ticket;
    assert.equal((await browser().call('POST', '/api/admin/login/second-factor', { ticket: ticket2, code: recovery })).status, 401);
    assert.equal((await phone.call('GET', '/api/admin/account/security')).data.recovery_codes_left, 7);

    // A forged or stale ticket is refused.
    assert.equal((await browser().call('POST', '/api/admin/login/second-factor', { ticket: 'nonsense', code: nextCode })).data.restart, true);

    // Turning it off takes the password and a code.
    resetAttempts();
    assert.equal((await phone.call('POST', '/api/admin/account/totp/disable', { current_password: PASSWORD, code: '000000' })).status, 400);
    assert.equal((await phone.call('POST', '/api/admin/account/totp/disable', { current_password: PASSWORD, code: enabled.data.recovery_codes[1] })).status, 200);
    assert.equal((await browser().login()).data.success, true, 'the password alone works again');
});

test('the server-side tool gets the admin back in: unlock, reset the second factor, list', () => {
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO login_attempts (client_key, failure_count, window_started_at) VALUES ('user:zhenya', 50, ?)").run(Date.now());
    db.prepare("UPDATE admins SET totp_enabled = 1, totp_secret = 'v1:x:y:z' WHERE id = 1").run();

    const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, '..', 'server', 'admin-tool.js'), ...args], {
        env: { ...process.env }, encoding: 'utf8'
    });

    assert.match(run('list'), /zhenya\s+второй фактор: включён/);
    assert.match(run('unlock'), /сняты/);
    assert.match(run('reset-2fa', 'zhenya'), /выключен/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM login_attempts').get().c, 0);
    assert.equal(db.prepare('SELECT totp_enabled FROM admins WHERE id = 1').get().totp_enabled, 0);

    // Pointed at a database that does not exist, it refuses instead of creating one.
    assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'server', 'admin-tool.js'), 'list'], {
        env: { ...process.env, DB_PATH: path.join(tempDir, 'missing.db') }, encoding: 'utf8', stdio: 'pipe'
    }));
    assert.equal(fs.existsSync(path.join(tempDir, 'missing.db')), false);
});

test('error reports from browsers are limited per address', async () => {
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
        const response = await fetch(`${baseUrl}/api/client-error`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `boom ${i}`, path: '/x' })
        });
        if (response.status === 429) limited += 1;
    }
    assert.ok(limited >= 2);
});

test('the server-side tool adds a separate admin (who can log in) and never removes the last one', async () => {
    const tool = path.join(__dirname, '..', 'server', 'admin-tool.js');
    const run = (args, input = '') => execFileSync(process.execPath, [tool, ...args], { env: { ...process.env }, encoding: 'utf8', input, stdio: 'pipe' });

    assert.match(run(['add-admin', 'second'], 'another long phrase\nanother long phrase\n'), /добавлен/);
    assert.throws(() => run(['add-admin', 'second'], 'x\nx\n'), 'a taken login is refused');
    assert.throws(() => run(['add-admin', 'third'], 'short\nshort\n'), 'a short password is refused');

    resetAttempts();
    assert.equal((await browser().login('another long phrase', 'second')).status, 200, 'the new admin logs in with their own password');

    assert.match(run(['remove-admin', 'second']), /удалён/);
    assert.throws(() => run(['remove-admin', 'zhenya']), 'the last admin stays');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM admins').get().c, 1);
});
