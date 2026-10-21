const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

// A backup only counts if it can be put back. These go through the panel's own
// endpoints: take a copy, make the kind of mistake it exists for, restore, and
// check that bad files are refused without touching the live database.

process.env.JWT_SECRET = 'test-secret';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-restore-'));
process.env.DB_PATH = path.join(tempDir, 'schedule.db');
process.env.BACKUPS_DIR = path.join(tempDir, 'backups');

const { createApp } = require('../server/app');
const { createToken } = require('../server/middleware/auth');
const { closeDb, getDb } = require('../server/db');

test('backup → mistake → restore, and refusing files that would break the app', async (t) => {
    const db = getDb(); // bootstraps from the committed seed snapshot and migrates it
    const admin = db.prepare('SELECT id, username FROM admins ORDER BY id LIMIT 1').get();
    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise((resolve) => server.close(() => { closeDb(); resolve(); })));

    // A restore ends every session saved in either database (old ones must not
    // come back to life); the browser gets a fresh cookie, a script a new token.
    const auth = {};
    const login = () => { auth.Authorization = `Bearer ${createToken({ id: admin.id, username: admin.username })}`; };
    login();
    const post = async (url, body, headers = {}) => {
        const response = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { ...auth, ...headers }, body });
        return { status: response.status, data: await response.json() };
    };
    const counts = () => ({
        groups: getDb().prepare('SELECT COUNT(*) AS c FROM groups_').get().c,
        lessons: getDb().prepare('SELECT COUNT(*) AS c FROM lessons').get().c
    });

    const original = counts();
    assert.ok(original.groups > 0 && original.lessons > 0);

    const created = await post('/api/admin/backups');
    assert.equal(created.status, 200);
    const backupName = created.data.backup.file_name;

    // The mistake: a group deleted with all its lessons.
    const victim = getDb().prepare('SELECT id FROM groups_ ORDER BY id LIMIT 1').get().id;
    getDb().prepare('DELETE FROM groups_ WHERE id = ?').run(victim);
    const damaged = counts();
    assert.ok(damaged.lessons < original.lessons);

    const restored = await post(`/api/admin/backups/${encodeURIComponent(backupName)}/restore`);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(counts(), original, 'the deleted group and its lessons are back');
    assert.equal((await post('/api/admin/backups')).status, 401, 'the session from before the restore is over');
    login();

    // The state being replaced was kept, so a wrong restore is itself undoable.
    const safety = new Database(path.join(process.env.BACKUPS_DIR, restored.data.safety_backup), { readonly: true });
    assert.equal(safety.prepare('SELECT COUNT(*) AS c FROM lessons').get().c, damaged.lessons);
    safety.close();

    const octet = { 'Content-Type': 'application/octet-stream' };

    // Not a database at all.
    const garbage = await post('/api/admin/backups/upload-restore', Buffer.from('definitely not sqlite'.repeat(100)), octet);
    assert.equal(garbage.status, 400);
    assert.deepEqual(counts(), original, 'a refused file leaves the live database untouched');

    // A real database of this app, but with nobody able to log in.
    const noAdminsPath = path.join(tempDir, 'no-admins.db');
    getDb().prepare('VACUUM INTO ?').run(noAdminsPath);
    const noAdmins = new Database(noAdminsPath);
    noAdmins.exec('DELETE FROM admins');
    noAdmins.close();
    const lockedOut = await post('/api/admin/backups/upload-restore', fs.readFileSync(noAdminsPath), octet);
    assert.equal(lockedOut.status, 400);
    assert.match(lockedOut.data.error, /администратор/);

    // A file from before semester scoping (the seed snapshot's schema) comes
    // back migrated: every lesson belongs to a semester.
    const legacy = await post('/api/admin/backups/upload-restore', fs.readFileSync(path.join(__dirname, '..', 'seed', 'schedule.seed.db')), octet);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
    assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM lessons WHERE semester_id IS NULL').get().c, 0);

    // And the app keeps serving from the restored file.
    const universities = await fetch(`${baseUrl}/api/universities`);
    assert.equal(universities.status, 200);
});
