const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// The campus shares one address. A student's script flooding the public API —
// or knocking on /api/admin without a login — must not lock the specialist,
// behind that same address, out of the admin panel.

process.env.JWT_SECRET = 'test-secret';
process.env.API_RATE_LIMIT_MAX = '5';
process.env.ADMIN_RATE_LIMIT_MAX = '5';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kai-limit-')), 'schedule.db');

const bcrypt = require('bcryptjs');
const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { ADMIN_COOKIE_NAME } = require('../server/config');
const { closeDb, getDb } = require('../server/db');

test('a flood from the shared address leaves the logged-in specialist working', async (t) => {
    const db = getDb();
    db.exec('DELETE FROM admins;');
    db.prepare('INSERT INTO admins (id, username, password_hash) VALUES (1, ?, ?)').run('zhenya', bcrypt.hashSync('x', 4));
    const server = http.createServer(createApp().app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `${ADMIN_COOKIE_NAME}=${createToken({ id: 1, username: 'zhenya' })}`;

    // The student: public reads until refused, then the admin area without a login, and with a made-up cookie.
    let publicStatus = 200;
    for (let i = 0; i < 8; i += 1) publicStatus = (await fetch(`${base}/api/universities`)).status;
    assert.equal(publicStatus, 429, 'the public flood ceiling works');
    let strangerStatus = 401;
    for (let i = 0; i < 8; i += 1) strangerStatus = (await fetch(`${base}/api/admin/settings`, { headers: { Cookie: `${ADMIN_COOKIE_NAME}=made-up-${i}` } })).status;
    assert.equal(strangerStatus, 429, 'made-up cookies do not buy a fresh budget');

    // The specialist, same address, her own session.
    const own = await fetch(`${base}/api/admin/settings`, { headers: { Cookie: cookie } });
    assert.equal(own.status, 200);
});
