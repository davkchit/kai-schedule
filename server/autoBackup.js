const fs = require('fs');
const path = require('path');

// Automatic safety copies, next to the manual ones the admin panel lists and
// lets you download (same directory, so both show up there).
//
// - boot: taken every time the server opens an existing database, BEFORE any
//   migration runs. A deploy that brings a schema change migrates the live
//   data; if that goes wrong, the state right before it is on disk.
// - daily: one per calendar day while the server runs, so a bad edit (a whole
//   group deleted, a semester rebuilt by mistake) can be undone to yesterday
//   without anyone having remembered to press "create backup".
//
// Copies live on the same volume as the database: they protect against bad
// writes and bad migrations, not against losing the volume itself — for that,
// download one from the admin panel now and then.

const RETENTION = { boot: 10, daily: 30 };
const DAY_CHECK_INTERVAL_MS = 60 * 60 * 1000;

function resolveBackupsDir(dbPath) {
    // Read lazily: config.js pulls in dotenv, and db.js must not depend on it.
    return process.env.BACKUPS_DIR
        ? path.resolve(process.cwd(), process.env.BACKUPS_DIR)
        : path.join(path.dirname(dbPath), 'backups');
}

function isDisabled() {
    // Test runs open hundreds of throwaway databases.
    return process.env.AUTO_BACKUP === '0' || Boolean(process.env.NODE_TEST_CONTEXT);
}

function stamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Consistent copy (includes anything still in the WAL) via SQLite itself. */
function writeSnapshot(db, dbPath, kind, fileStamp) {
    const dir = resolveBackupsDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `schedule-${kind}-${fileStamp}.db`);

    if (fs.existsSync(target)) {
        return null;
    }

    db.prepare('VACUUM INTO ?').run(target);
    prune(dir, kind);
    return target;
}

function prune(dir, kind) {
    const prefix = `schedule-${kind}-`;
    const files = fs.readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
        .sort();

    for (const name of files.slice(0, Math.max(0, files.length - RETENTION[kind]))) {
        fs.rmSync(path.join(dir, name), { force: true });
    }
}

function snapshotBeforeMigrations(db, dbPath) {
    if (isDisabled()) return;

    try {
        const target = writeSnapshot(db, dbPath, 'boot', stamp());
        if (target) console.log(`[backup] Snapshot before migrations: ${target}`);
    } catch (error) {
        // Never block startup on a backup; say so loudly instead.
        console.error('[backup] Could not snapshot the database before migrations:', error);
    }
}

function startDailyBackups(getDb, getDbPath) {
    if (isDisabled()) return null;

    const runOnce = () => {
        try {
            const today = stamp().slice(0, 8);
            const target = writeSnapshot(getDb(), getDbPath(), 'daily', today);
            if (target) console.log(`[backup] Daily backup: ${target}`);
        } catch (error) {
            console.error('[backup] Daily backup failed:', error);
        }
    };

    runOnce();
    const timer = setInterval(runOnce, DAY_CHECK_INTERVAL_MS);
    timer.unref();
    return timer;
}

module.exports = { snapshotBeforeMigrations, startDailyBackups };
