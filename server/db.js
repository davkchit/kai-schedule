const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { defaultFirstWeekParity, formatLocalDate, isValidIsoDate, mondayOfWeek } = require('./utils/date');

const { snapshotBeforeMigrations } = require('./autoBackup');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'schedule.db');

// Lives outside data/ on purpose: when a persistent volume is mounted at
// data/, the volume shadows whatever was baked into the image there — this
// snapshot sits at a separate path so it survives that and can still seed a
// brand-new (empty) volume on first boot. Updated periodically from a real
// backup, not meant to be perfectly current — see server/autoBackup.js for
// the ongoing automated backups.
const DEFAULT_SEED_DB_PATH = path.join(__dirname, '..', 'seed', 'schedule.seed.db');

let db;
let currentDbPath = null;

function resolveDbPath() {
    const configuredPath = process.env.DB_PATH;

    if (!configuredPath) {
        return DEFAULT_DB_PATH;
    }

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);
}

function resolveSeedDbPath() {
    const configuredPath = process.env.SEED_DB_PATH;

    if (!configuredPath) {
        return DEFAULT_SEED_DB_PATH;
    }

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);
}

function ensureDataDirectory(dbPath) {
    const dataDir = path.dirname(dbPath);

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

/**
 * A brand-new persistent volume (or a fresh deploy with no DB_PATH override)
 * starts with nothing at the target path. Rather than silently boot an empty
 * schema — which would look like every group/lesson/admin vanished — seed it
 * from the last known-good snapshot committed alongside the code. This only
 * ever fires when the target file doesn't exist yet; it never overwrites a
 * database that's already there.
 */
function bootstrapFromSeedIfMissing(dbPath) {
    if (fs.existsSync(dbPath)) {
        return;
    }

    const seedPath = resolveSeedDbPath();

    if (!fs.existsSync(seedPath)) {
        return;
    }

    fs.copyFileSync(seedPath, dbPath);
    console.log(`[db] No database found at ${dbPath} — bootstrapped from seed snapshot (${seedPath}).`);
}

/**
 * Get or create the database connection (singleton).
 * @returns {Database.Database}
 */
function getDb() {
    const nextDbPath = resolveDbPath();

    if (db && currentDbPath === nextDbPath) {
        return db;
    }

    if (db) {
        db.close();
    }

    ensureDataDirectory(nextDbPath);
    const existedBefore = fs.existsSync(nextDbPath);
    bootstrapFromSeedIfMissing(nextDbPath);

    db = new Database(nextDbPath);
    currentDbPath = nextDbPath;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    if (existedBefore) {
        // initTables also migrates — keep the data as it was right before.
        snapshotBeforeMigrations(db, nextDbPath);
    }

    initTables();

    return db;
}

function closeDb() {
    if (!db) {
        return;
    }

    db.close();
    db = null;
    currentDbPath = null;
}

function getDbPath() {
    return currentDbPath || resolveDbPath();
}

/**
 * Create all tables if they don't exist.
 */
function initTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS universities (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            short_name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS groups_ (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            university_id INTEGER NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            direction     TEXT DEFAULT NULL,
            UNIQUE(university_id, name)
        );

        CREATE TABLE IF NOT EXISTS lessons (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup    INTEGER NOT NULL DEFAULT 0,
            day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
            week_type   INTEGER NOT NULL DEFAULT 0 CHECK(week_type IN (0, 1, 2)),
            specific_week INTEGER DEFAULT NULL,
            template_from_week INTEGER NOT NULL DEFAULT 1,
            is_removed  INTEGER NOT NULL DEFAULT 0,
            time_start  TEXT    NOT NULL,
            time_end    TEXT    NOT NULL,
            subject     TEXT    NOT NULL,
            room        TEXT,
            lesson_type TEXT,
            teacher     TEXT,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Migration: try to add specific_week column if it doesn't exist
        BEGIN TRANSACTION;
        -- SQLite requires a separate command to add a column, so we use a try/catch block
        -- This will be handled in JS below since db.exec will throw if column exists when doing it via standard exec,
        -- but we can just swallow the error.
        COMMIT;
    `);

    try {
        db.exec('ALTER TABLE lessons ADD COLUMN specific_week INTEGER DEFAULT NULL');
    } catch (err) {
        // Ignored if column already exists
    }

    try {
        db.exec('ALTER TABLE lessons ADD COLUMN template_from_week INTEGER NOT NULL DEFAULT 1');
    } catch (err) {
        // Ignored if column already exists
    }

    try {
        db.exec('ALTER TABLE lessons ADD COLUMN is_removed INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
        // Ignored if column already exists
    }

    try {
        db.exec('ALTER TABLE groups_ ADD COLUMN direction TEXT DEFAULT NULL');
    } catch (err) {
        // Ignored if column already exists
    }

    migrateLessonsDayOfWeekConstraint();
    migrateLoadPlanPlannedHoursNullable();
    migrateLessonsLoadPlanFkRepair();

    db.exec(`

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admins (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
            action      TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id   TEXT,
            ip_address  TEXT,
            details     TEXT,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            client_key        TEXT PRIMARY KEY,
            failure_count     INTEGER NOT NULL DEFAULT 0,
            window_started_at INTEGER NOT NULL,
            updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Teaching-load tracking (independent of the schedule's own
        -- semester_start_date setting — see the comment on semesters below).

        CREATE TABLE IF NOT EXISTS teachers (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name  TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS disciplines (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Deliberately separate from settings.semester_start_date (which only
        -- ever tracks the one semester currently driving the public
        -- schedule's week numbering). A load_plan row needs to stay scoped to
        -- the semester it was entered for even after that setting moves
        -- forward — otherwise last semester's plan would bleed into this
        -- semester's hour count. The two are usually set to the same start
        -- date by whoever manages the semester rollover, but are not
        -- programmatically linked.
        CREATE TABLE IF NOT EXISTS semesters (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            label        TEXT NOT NULL,
            start_date   TEXT NOT NULL,
            weeks_count  INTEGER NOT NULL DEFAULT 18,
            is_active    INTEGER NOT NULL DEFAULT 0,
            created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- One row = "this teacher owes this many hours of this discipline's
        -- this lesson type, for this one group, this semester." Streams
        -- (one lecture shared by several groups) and subgroups are both
        -- expressed by entering separate rows per group/subgroup rather than
        -- a multiplier — confirmed against how the university's own system
        -- tracks it (one row per group, hours counted per row).
        CREATE TABLE IF NOT EXISTS load_plan (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id   INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
            teacher_id    INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
            discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
            lesson_type   TEXT NOT NULL,
            group_id      INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup      INTEGER NOT NULL DEFAULT 0,
            -- Nullable: a plan row can exist before its hours are known — e.g.
            -- auto-created the moment a schedule lesson is saved against a
            -- discipline/teacher/type/group combo that has no plan row yet.
            -- It shows up as "часы не заданы" until the specialist fills it in.
            planned_hours INTEGER CHECK(planned_hours IS NULL OR planned_hours > 0),
            entered_by    TEXT NOT NULL DEFAULT 'specialist' CHECK(entered_by IN ('specialist', 'teacher')),
            confirmed     INTEGER NOT NULL DEFAULT 0,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_lessons_group   ON lessons(group_id);
        CREATE INDEX IF NOT EXISTS idx_lessons_day     ON lessons(group_id, day_of_week);
        CREATE INDEX IF NOT EXISTS idx_groups_univ     ON groups_(university_id);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_login_attempts_window_started_at ON login_attempts(window_started_at);
        CREATE INDEX IF NOT EXISTS idx_load_plan_semester ON load_plan(semester_id);
        CREATE INDEX IF NOT EXISTS idx_load_plan_teacher  ON load_plan(teacher_id);
    `);

    // Nullable: only lessons relevant to load tracking get linked to a plan
    // row. Ordinary schedule entries stay NULL forever — linking is opt-in
    // per plan line, not a blanket requirement on the whole table. Runs
    // after load_plan exists so the REFERENCES target is real.
    try {
        db.exec('ALTER TABLE lessons ADD COLUMN load_plan_id INTEGER REFERENCES load_plan(id) ON DELETE SET NULL');
    } catch (err) {
        // Ignored if column already exists
    }

    // 'lesson'  — real teaching; must resolve to a load_plan row to count hours.
    // 'event'   — торжественная линейка, субботник and the like. Carries only a
    //             title, never a teacher or hours, and is skipped by the hour
    //             engine for free (it has no load_plan_id). Kept in this table
    //             rather than its own so it inherits slot collisions, week
    //             overrides, materialization and drag-and-drop unchanged.
    try {
        db.exec("ALTER TABLE lessons ADD COLUMN kind TEXT NOT NULL DEFAULT 'lesson'");
    } catch (err) {
        // Ignored if column already exists
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_lessons_load_plan ON lessons(load_plan_id)');

    migrateSemesterScoping();
    migrateSemesterClosing();
    migrateLessonsTeacherDiscipline();
    clearRoomsHoldingTheWholeCell();
}

// Real rooms for the joint lectures below, read from the source sheets (the
// first "Ауд." column after the merged cell): [group, day_of_week, time_start, subject, room].
const IMPORTED_JOINT_LECTURE_ROOMS = [
    ['23103', 1, '08:00', 'Информатика и основы информационных технологий', '105'],
    ['23203', 1, '15:00', 'Проектная деятельность', '103'],
    ['23203', 2, '13:10', 'Математическая логика и теория алгоритмов', '104'],
    ['23203', 2, '15:00', 'Программирование и основы алгоритмизации', '104'],
    ['23203', 2, '16:40', 'Программирование и основы алгоритмизации', '104'],
    ['23203', 4, '11:30', 'Теория вероятностей и математическая статистика', '104'],
    ['23203', 4, '13:10', 'Физика', '104'],
    ['23203', 4, '15:00', 'Проектная деятельность', '103'],
    ['23203', 5, '13:10', 'Личностное развитие', '104'],
    ['23203', 5, '13:10', 'Культурология и социология', '105'],
    ['23203', 5, '15:00', 'Личностное развитие', '104'],
    ['23203', 5, '15:00', 'Культурология и социология', '105'],
    ['23403', 3, '13:10', 'Моделирование информационных систем', '104'],
    ['23403', 3, '15:00', 'Защита информации', '104'],
    ['23403', 3, '16:40', 'Защита информации', '104'],
    ['23403', 5, '13:10', 'Проектная деятельность', '103'],
    ['23403', 5, '15:00', 'Проектная деятельность', '103']
];

/**
 * The one-time Excel import read a joint lecture's room from the first
 * "Ауд." column after its cell — but that cell was merged across two groups
 * and covered the column, so room got the cell text itself ("Физика (лек.)
 * Акст Е.Р."). The real room sits after the merge; this puts it back, and
 * clears any such room with no known replacement. Matches only a room that
 * starts with the row's own subject followed by " (", which no real room
 * does — so once fixed a row is never touched again, even if later edited.
 */
function clearRoomsHoldingTheWholeCell() {
    const isWholeCell = `room IS NOT NULL AND subject IS NOT NULL AND TRIM(subject) != ''
          AND substr(room, 1, length(subject) + 2) = subject || ' ('`;
    const restore = db.prepare(`
        UPDATE lessons SET room = ?, updated_at = CURRENT_TIMESTAMP
        WHERE group_id IN (SELECT id FROM groups_ WHERE name = ?)
          AND day_of_week = ? AND time_start = ? AND subject = ? AND ${isWholeCell}
    `);

    db.transaction(() => {
        for (const [group, day, timeStart, subject, room] of IMPORTED_JOINT_LECTURE_ROOMS) {
            restore.run(room, group, day, timeStart, subject);
        }
        db.exec(`UPDATE lessons SET room = NULL, updated_at = CURRENT_TIMESTAMP WHERE ${isWholeCell}`);
    })();
}

/**
 * Replaces the manual "link this pair to a plan row" step with a direct
 * identity: a lesson now carries teacher_id/discipline_id, the same two
 * foreign keys a load_plan row already has. Hours are computed by matching
 * (teacher_id, discipline_id, lesson_type, group_id, subgroup) live — no
 * explicit link, and no possibility of the schedule's text and the plan's
 * dictionary silently drifting apart, because they are now the same id.
 *
 * subject/teacher stay as plain text columns too (still what's shown to
 * students and printed on exports), but once an id is set the app always
 * writes the dictionary's own current text into them — see
 * resolveTeacherDiscipline in routes/admin/shared.js. A row can still exist
 * with no ids at all (kind='event', or a one-off nobody wants to track);
 * it simply never counts toward anyone's hours, same as before.
 */
function migrateLessonsTeacherDiscipline() {
    try {
        db.exec('ALTER TABLE lessons ADD COLUMN teacher_id INTEGER REFERENCES teachers(id)');
    } catch (err) {
        // Ignored if column already exists
    }

    try {
        db.exec('ALTER TABLE lessons ADD COLUMN discipline_id INTEGER REFERENCES disciplines(id)');
    } catch (err) {
        // Ignored if column already exists
    }

    // One-time backfill for rows that predate the columns: today's schedule
    // text already matches the dictionaries exactly (verified against the
    // real semester before writing this), so this just links up what a
    // human already made consistent by hand. Re-runs harmlessly on rows that
    // still have no match (kept NULL, same as any untracked entry) — including
    // picking up a match later if the matching dictionary entry gets added.
    db.exec(`
        UPDATE lessons SET teacher_id = (
            SELECT id FROM teachers WHERE full_name = TRIM(lessons.teacher)
        )
        WHERE teacher_id IS NULL AND teacher IS NOT NULL AND TRIM(teacher) != ''
    `);
    db.exec(`
        UPDATE lessons SET discipline_id = (
            SELECT id FROM disciplines WHERE name = TRIM(lessons.subject)
        )
        WHERE discipline_id IS NULL AND subject IS NOT NULL AND TRIM(subject) != ''
    `);

    // The one index the hour engine's live match leans on every read.
    db.exec('CREATE INDEX IF NOT EXISTS idx_lessons_teacher_discipline ON lessons(teacher_id, discipline_id, lesson_type, group_id, subgroup)');
}

/**
 * Scopes every lesson to a semester.
 *
 * Before this, lessons had no semester at all, while their week numbers
 * (specific_week, template_from_week) were relative to whichever semester
 * happened to be current. The moment a new semester started, every stored
 * week number was silently re-read against the new start date — autumn's
 * "week 1" rows showed up as spring's week 1 for students, and editing the
 * template for spring wrote week numbers that autumn's hour counter read as
 * its own, erasing hours already taught. Owning the semester on the row makes
 * each semester's week numbers mean one thing forever.
 *
 * Also records each semester's first-week parity (see
 * getWeekTypeForSemesterWeek in utils/date.js for why it is stored rather
 * than derived).
 */
/**
 * A finished semester can be closed: its schedule and its hours stop changing.
 * The hours a closed semester reports are the ones stored at closing time, not
 * a fresh calculation — the figures went into a signed report, and a later
 * correction to an old pair must not silently rewrite them.
 */
function migrateSemesterClosing() {
    try {
        db.exec('ALTER TABLE semesters ADD COLUMN closed_at TEXT DEFAULT NULL');
    } catch (err) {
        // Ignored if column already exists
    }

    try {
        db.exec('ALTER TABLE load_plan ADD COLUMN final_hours INTEGER DEFAULT NULL');
    } catch (err) {
        // Ignored if column already exists
    }
}

function migrateSemesterScoping() {
    try {
        db.exec('ALTER TABLE semesters ADD COLUMN first_week_parity INTEGER NOT NULL DEFAULT 0');
        // 0 marks "not yet decided" for rows that existed before this column —
        // filled below from the calendar rule, which is what they used until now.
    } catch (err) {
        // Ignored if column already exists
    }

    // At most one working semester, enforced by the database itself. Several
    // things read "the active semester" and assume a single answer — with two,
    // a date sync would overwrite both and read back an arbitrary one. The API
    // already deactivates the others on activation; this makes any other path
    // (a script, raw SQL) unable to create the ambiguous state at all.
    const activeRows = db.prepare('SELECT id FROM semesters WHERE is_active = 1 ORDER BY start_date DESC, id DESC').all();
    if (activeRows.length > 1) {
        db.prepare(`UPDATE semesters SET is_active = 0 WHERE is_active = 1 AND id != ?`).run(activeRows[0].id);
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_semesters_single_active ON semesters(is_active) WHERE is_active = 1');

    // Semester weeks run Monday–Sunday; a start date entered as the first
    // teaching day (e.g. a Tuesday) is moved to that week's Monday. Week
    // numbers of every existing row stay the same — it is the same week.
    const setStart = db.prepare('UPDATE semesters SET start_date = ? WHERE id = ?');
    for (const semester of db.prepare('SELECT id, start_date FROM semesters').all()) {
        const monday = mondayOfWeek(semester.start_date);
        if (monday !== semester.start_date) setStart.run(monday, semester.id);
    }
    const startSetting = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    if (startSetting && isValidIsoDate(startSetting.value) && mondayOfWeek(startSetting.value) !== startSetting.value) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'semester_start_date'").run(mondayOfWeek(startSetting.value));
    }

    const undecided = db.prepare('SELECT id, start_date FROM semesters WHERE first_week_parity NOT IN (1, 2)').all();
    const setParity = db.prepare('UPDATE semesters SET first_week_parity = ? WHERE id = ?');
    for (const semester of undecided) {
        setParity.run(defaultFirstWeekParity(semester.start_date), semester.id);
    }

    try {
        db.exec('ALTER TABLE lessons ADD COLUMN semester_id INTEGER REFERENCES semesters(id) ON DELETE CASCADE');
    } catch (err) {
        // Ignored if column already exists
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_lessons_semester_group ON lessons(semester_id, group_id)');

    const unscopedCount = db.prepare('SELECT COUNT(*) c FROM lessons WHERE semester_id IS NULL').get().c;

    if (unscopedCount > 0) {
        // Lessons that predate scoping all belong to the one semester the app
        // was operating in — the active one, else the most recent, else one
        // created from the schedule's own start-date setting.
        const owner = ensureWorkingSemester();
        db.prepare('UPDATE lessons SET semester_id = ? WHERE semester_id IS NULL').run(owner.id);
    }

    // Safety net for any insert path that does not pass a semester (seed
    // scripts, raw SQL, future code): it lands in the working semester rather
    // than staying unscoped and leaking into every semester at once. Every
    // route sets semester_id explicitly; this only catches omissions.
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS lessons_default_semester
        AFTER INSERT ON lessons
        WHEN NEW.semester_id IS NULL
        BEGIN
            UPDATE lessons
            SET semester_id = (
                SELECT id FROM semesters
                ORDER BY is_active DESC, start_date DESC, id DESC
                LIMIT 1
            )
            WHERE id = NEW.id;
        END;
    `);
}

/**
 * The semester admin edits go into: the active one; else the most recent,
 * promoted to active; else a new one created from settings.semester_start_date
 * so a database that only ever had the old single-semester setting keeps
 * working unchanged.
 */
function ensureWorkingSemester() {
    const active = db.prepare('SELECT * FROM semesters WHERE is_active = 1 ORDER BY start_date DESC LIMIT 1').get();
    if (active) return active;

    const latest = db.prepare('SELECT * FROM semesters ORDER BY start_date DESC, id DESC LIMIT 1').get();
    if (latest) {
        db.prepare('UPDATE semesters SET is_active = 1 WHERE id = ?').run(latest.id);
        return { ...latest, is_active: 1 };
    }

    const setting = db.prepare("SELECT value FROM settings WHERE key = 'semester_start_date'").get();
    const startDate = setting ? setting.value : formatLocalDate();
    const result = db.prepare(`
        INSERT INTO semesters (label, start_date, weeks_count, is_active, first_week_parity)
        VALUES ('Текущий семестр', ?, 18, 1, ?)
    `).run(startDate, defaultFirstWeekParity(startDate));

    return db.prepare('SELECT * FROM semesters WHERE id = ?').get(result.lastInsertRowid);
}

function migrateLessonsDayOfWeekConstraint() {
    const lessonsTable = db.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'lessons'
    `).get();

    if (!lessonsTable?.sql || !/CHECK\s*\(\s*day_of_week\s+BETWEEN\s+1\s+AND\s+6\s*\)/i.test(lessonsTable.sql)) {
        return;
    }

    db.exec(`
        BEGIN TRANSACTION;
        ALTER TABLE lessons RENAME TO lessons_legacy;

        CREATE TABLE lessons (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup    INTEGER NOT NULL DEFAULT 0,
            day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
            week_type   INTEGER NOT NULL DEFAULT 0 CHECK(week_type IN (0, 1, 2)),
            specific_week INTEGER DEFAULT NULL,
            template_from_week INTEGER NOT NULL DEFAULT 1,
            is_removed  INTEGER NOT NULL DEFAULT 0,
            time_start  TEXT    NOT NULL,
            time_end    TEXT    NOT NULL,
            subject     TEXT    NOT NULL,
            room        TEXT,
            lesson_type TEXT,
            teacher     TEXT,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO lessons (
            id, group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher,
            sort_order, created_at, updated_at
        )
        SELECT
            id, group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher,
            sort_order, created_at, updated_at
        FROM lessons_legacy;

        DROP TABLE lessons_legacy;
        COMMIT;
    `);
}

/**
 * Older schema had planned_hours NOT NULL CHECK(> 0) — a plan row could not
 * exist without hours already decided. That blocks auto-creating a plan row
 * the moment a schedule lesson references a discipline/teacher/type/group
 * combo that has none yet (hours unknown at that point, filled in later by
 * the specialist). SQLite can't drop a CHECK constraint in place, so the
 * table has to be rebuilt.
 *
 * Unlike migrateLessonsDayOfWeekConstraint, this table is itself the FK
 * TARGET of another table (lessons.load_plan_id REFERENCES load_plan(id)) on
 * any database that already has load tracking installed. Renaming load_plan
 * out of the way (load_plan -> load_plan_legacy) makes SQLite rewrite that
 * *other* table's stored REFERENCES clause to point at the new name — so by
 * the time load_plan_legacy is dropped, lessons is left permanently
 * referencing a table that no longer exists (confirmed against a real
 * database: its lessons.sql read `REFERENCES "load_plan_legacy"(id)` after
 * such a rename-based rebuild, and the corruption survives — every later
 * write that touches lessons.load_plan_id then fails with "no such table:
 * main.load_plan_legacy"). Building the replacement under a fresh temporary
 * name and renaming *that* into "load_plan" avoids ever renaming the
 * original away, so nothing referencing it by name ever gets rewritten.
 */
function migrateLoadPlanPlannedHoursNullable() {
    const loadPlanTable = db.prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'load_plan'
    `).get();

    if (!loadPlanTable?.sql || !/CHECK\s*\(\s*planned_hours\s*>\s*0\s*\)/i.test(loadPlanTable.sql)) {
        return;
    }

    // load_plan is the FK TARGET of lessons.load_plan_id on any database that
    // already has load tracking installed. With enforcement on, DROP TABLE
    // fires each child's ON DELETE action against the about-to-vanish parent
    // rows at the instant of the drop — permanently nulling out working links
    // even though a same-named, same-keyed replacement table appears a
    // statement later. (Confirmed directly: rebuilding load_plan this way
    // with enforcement left on silently zeroed every lessons.load_plan_id
    // that pointed at it.) PRAGMA foreign_keys can't be toggled inside a
    // transaction, so it brackets the whole exec rather than living inside it.
    db.pragma('foreign_keys = OFF');

    db.exec(`
        BEGIN TRANSACTION;

        CREATE TABLE load_plan_rebuilt (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id   INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
            teacher_id    INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
            discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
            lesson_type   TEXT NOT NULL,
            group_id      INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup      INTEGER NOT NULL DEFAULT 0,
            planned_hours INTEGER CHECK(planned_hours IS NULL OR planned_hours > 0),
            entered_by    TEXT NOT NULL DEFAULT 'specialist' CHECK(entered_by IN ('specialist', 'teacher')),
            confirmed     INTEGER NOT NULL DEFAULT 0,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO load_plan_rebuilt (
            id, semester_id, teacher_id, discipline_id, lesson_type, group_id,
            subgroup, planned_hours, entered_by, confirmed, created_at, updated_at
        )
        SELECT
            id, semester_id, teacher_id, discipline_id, lesson_type, group_id,
            subgroup, planned_hours, entered_by, confirmed, created_at, updated_at
        FROM load_plan;

        DROP TABLE load_plan;
        ALTER TABLE load_plan_rebuilt RENAME TO load_plan;

        COMMIT;
    `);

    db.pragma('foreign_keys = ON');
}

/**
 * Repairs a database left in the corrupted state migrateLoadPlanPlannedHoursNullable
 * used to produce: lessons.load_plan_id pointing at a "load_plan_legacy" table
 * that no longer exists, because an earlier version of that migration renamed
 * load_plan out from under it instead of building the replacement under a
 * fresh name. Detected by inspecting lessons' own stored schema text; a no-op
 * on any database that never hit the bug.
 */
function migrateLessonsLoadPlanFkRepair() {
    const lessonsTable = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lessons'
    `).get();

    if (!lessonsTable?.sql || !/REFERENCES\s+"?load_plan_legacy"?\s*\(/i.test(lessonsTable.sql)) {
        return;
    }

    // Nothing currently holds a live FK against lessons(id), so this rebuild
    // doesn't need the pragma toggle migrateLoadPlanPlannedHoursNullable
    // needs — but bracketing it the same way costs nothing and guards
    // against that ever becoming false later.
    db.pragma('foreign_keys = OFF');

    db.exec(`
        BEGIN TRANSACTION;

        CREATE TABLE lessons_fk_repaired (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id    INTEGER NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
            subgroup    INTEGER NOT NULL DEFAULT 0,
            day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
            week_type   INTEGER NOT NULL DEFAULT 0 CHECK(week_type IN (0, 1, 2)),
            specific_week INTEGER DEFAULT NULL,
            template_from_week INTEGER NOT NULL DEFAULT 1,
            is_removed  INTEGER NOT NULL DEFAULT 0,
            time_start  TEXT    NOT NULL,
            time_end    TEXT    NOT NULL,
            subject     TEXT    NOT NULL,
            room        TEXT,
            lesson_type TEXT,
            teacher     TEXT,
            sort_order  INTEGER NOT NULL DEFAULT 0,
            kind        TEXT NOT NULL DEFAULT 'lesson',
            load_plan_id INTEGER REFERENCES load_plan(id) ON DELETE SET NULL,
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO lessons_fk_repaired (
            id, group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher,
            sort_order, kind, load_plan_id, created_at, updated_at
        )
        SELECT
            id, group_id, subgroup, day_of_week, week_type, specific_week,
            template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher,
            sort_order, kind, load_plan_id, created_at, updated_at
        FROM lessons;

        DROP TABLE lessons;
        ALTER TABLE lessons_fk_repaired RENAME TO lessons;

        CREATE INDEX IF NOT EXISTS idx_lessons_group   ON lessons(group_id);
        CREATE INDEX IF NOT EXISTS idx_lessons_day     ON lessons(group_id, day_of_week);
        CREATE INDEX IF NOT EXISTS idx_lessons_load_plan ON lessons(load_plan_id);

        COMMIT;
    `);

    db.pragma('foreign_keys = ON');
}

module.exports = {
    closeDb,
    getDb,
    getDbPath
};
