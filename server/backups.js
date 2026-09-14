const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BACKUPS_DIR } = require('./config');
const { closeDb, getDb, getDbPath } = require('./db');

async function createDatabaseBackup() {
    const db = getDb();
    const backupDir = await ensureBackupsDirectory();
    const backupFileName = buildBackupFileName();
    const backupFilePath = path.join(backupDir, backupFileName);

    await db.backup(backupFilePath);

    return getBackupFileInfo(backupFileName);
}

async function listDatabaseBackups() {
    const backupDir = await ensureBackupsDirectory();
    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        if (!entry.name.endsWith('.db')) {
            continue;
        }

        files.push(await getBackupFileInfo(entry.name));
    }

    return files.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function getBackupDownloadPath(fileName) {
    const backupDir = await ensureBackupsDirectory();
    const safeFileName = path.basename(fileName);
    const resolvedPath = path.join(backupDir, safeFileName);
    const stat = await fs.stat(resolvedPath);

    if (!stat.isFile()) {
        throw new Error('Backup file is not a regular file');
    }

    return resolvedPath;
}

async function getBackupFileInfo(fileName) {
    const backupDir = await ensureBackupsDirectory();
    const safeFileName = path.basename(fileName);
    const resolvedPath = path.join(backupDir, safeFileName);
    const stat = await fs.stat(resolvedPath);

    return {
        file_name: safeFileName,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString()
    };
}

async function ensureBackupsDirectory() {
    const backupDir = BACKUPS_DIR || path.join(path.dirname(getDbPath()), 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    return backupDir;
}

function buildBackupFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `schedule-backup-${year}${month}${day}-${hours}${minutes}${seconds}.db`;
}

const REQUIRED_TABLES = ['universities', 'groups_', 'lessons', 'admins', 'settings'];

/**
 * Refuses anything that is not a healthy database of THIS app with at least
 * one admin — restoring a file without one would lock everybody out of the
 * very panel needed to undo it.
 */
function inspectBackupFile(filePath) {
    let candidate;

    try {
        candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    } catch {
        throw restoreError('Файл не является базой данных SQLite');
    }

    try {
        const integrity = candidate.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') {
            throw restoreError(`Файл повреждён (integrity_check: ${integrity})`);
        }

        const tables = new Set(candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
        if (missing.length) {
            throw restoreError(`Это не база расписания: нет таблиц ${missing.join(', ')}`);
        }

        const count = (table) => candidate.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
        const summary = { groups: count('groups_'), lessons: count('lessons'), admins: count('admins') };

        if (summary.admins === 0) {
            throw restoreError('В копии нет ни одного администратора — после восстановления вход в панель был бы невозможен');
        }

        return summary;
    } catch (error) {
        if (error.statusCode) throw error;
        throw restoreError('Не удалось прочитать файл базы данных');
    } finally {
        candidate.close();
    }
}

/** Timestamped name that never overwrites an existing file (two actions in one second). */
function uniqueBackupName(backupDir, prefix) {
    const base = buildBackupFileName().replace('schedule-backup-', prefix).replace(/\.db$/, '');
    let name = `${base}.db`;
    for (let n = 2; fsSync.existsSync(path.join(backupDir, name)); n += 1) {
        name = `${base}-${n}.db`;
    }
    return name;
}

function restoreError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

/**
 * Replaces the live database with a backup file.
 *
 * Synchronous from start to finish on purpose: Node runs one request at a
 * time, so no other request can observe (or write into) a half-swapped file.
 * The current database is saved first; if the restored file then fails to
 * open or migrate, that copy is put back before the error is reported.
 */
function restoreDatabaseFromFile(sourcePath) {
    const summary = inspectBackupFile(sourcePath);
    const dbPath = getDbPath();
    const backupDir = BACKUPS_DIR || path.join(path.dirname(dbPath), 'backups');
    fsSync.mkdirSync(backupDir, { recursive: true });

    const safetyName = uniqueBackupName(backupDir, 'schedule-before-restore-');
    const safetyPath = path.join(backupDir, safetyName);
    getDb().prepare('VACUUM INTO ?').run(safetyPath);

    const swapIn = (filePath) => {
        closeDb();
        for (const suffix of ['-wal', '-shm']) {
            fsSync.rmSync(dbPath + suffix, { force: true });
        }
        const staging = `${dbPath}.restoring`;
        fsSync.copyFileSync(filePath, staging);
        fsSync.renameSync(staging, dbPath);
        // Opening runs the migrations, so an older copy comes back in the
        // current schema.
        getDb();
    };

    try {
        swapIn(sourcePath);
    } catch (error) {
        console.error('[restore] Restored file failed to open, putting the previous database back:', error);
        swapIn(safetyPath);
        throw restoreError('Копию не удалось открыть — текущая база возвращена без изменений');
    }

    return { ...summary, safety_backup: safetyName };
}

async function getBackupFilePathForRestore(fileName) {
    return getBackupDownloadPath(fileName);
}

async function saveUploadedBackup(buffer) {
    const backupDir = await ensureBackupsDirectory();
    const fileName = uniqueBackupName(backupDir, 'schedule-uploaded-');
    const filePath = path.join(backupDir, fileName);
    await fs.writeFile(filePath, buffer);
    return { fileName, filePath };
}

module.exports = {
    getBackupFilePathForRestore,
    inspectBackupFile,
    restoreDatabaseFromFile,
    saveUploadedBackup,
    createDatabaseBackup,
    getBackupDownloadPath,
    listDatabaseBackups
};
