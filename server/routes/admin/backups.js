// Backups: create, download and restore — from the list or from an uploaded file.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const fs = require('fs');
const { writeAuditLog } = require('../../audit');
const {
    createDatabaseBackup,
    getBackupDownloadPath,
    getBackupFilePathForRestore,
    listDatabaseBackups,
    restoreDatabaseFromFile,
    saveUploadedBackup
} = require('../../backups');
const { getDb } = require('../../db');
const { clearAdminAuthCookie, createToken, setAdminAuthCookie } = require('../../middleware/auth');
const { getClientAddress } = require('./shared');

const router = express.Router();

router.get('/backups', async (req, res) => {
    try {
        const backups = await listDatabaseBackups();
        res.json(backups);
    } catch (error) {
        console.error('Backup list error:', error);
        res.status(500).json({ error: 'Не удалось получить список резервных копий' });
    }
});

router.post('/backups', async (req, res) => {
    try {
        const backup = await createDatabaseBackup();
        const db = getDb();

        writeAuditLog(db, {
            adminId: req.admin.id,
            action: 'backup.create',
            entityType: 'database_backup',
            entityId: backup.file_name,
            ipAddress: getClientAddress(req),
            details: backup
        });

        res.json({
            success: true,
            backup
        });
    } catch (error) {
        console.error('Backup create error:', error);
        res.status(500).json({ error: 'Не удалось создать резервную копию' });
    }
});

router.get('/backups/:fileName/download', async (req, res) => {
    let filePath;

    try {
        filePath = await getBackupDownloadPath(req.params.fileName);
    } catch {
        return res.status(404).json({ error: 'Резервная копия не найдена' });
    }

    res.download(filePath, req.params.fileName);
});

function respondRestored(req, res, result, source) {
    const db = getDb();
    // The restored file has its own admins: the one restoring may not exist
    // there, or its id may belong to someone else — so the login must match too.
    const admin = db.prepare('SELECT id, username FROM admins WHERE id = ? AND username = ?').get(req.admin.id, req.admin.username);

    // The audit row goes into the restored database — the one that stays.
    writeAuditLog(db, {
        adminId: admin ? admin.id : null,
        action: 'backup.restore',
        entityType: 'database_backup',
        entityId: source,
        ipAddress: getClientAddress(req),
        details: { source, ...result }
    });

    // Sessions saved in an old copy may include ones ended since (a logout, a
    // password change): none of them survive a restore. The admin doing it
    // keeps working here if the copy still has their account.
    db.prepare('DELETE FROM admin_sessions').run();

    if (admin) {
        setAdminAuthCookie(res, createToken(admin, { ip: getClientAddress(req), userAgent: req.get('user-agent') }));
    } else {
        clearAdminAuthCookie(res);
    }

    res.json({ success: true, ...result, relogin: !admin });
}

router.post('/backups/:fileName/restore', async (req, res) => {
    let filePath;

    try {
        filePath = await getBackupFilePathForRestore(req.params.fileName);
    } catch {
        return res.status(404).json({ error: 'Резервная копия не найдена' });
    }

    try {
        respondRestored(req, res, restoreDatabaseFromFile(filePath), req.params.fileName);
    } catch (error) {
        console.error('Backup restore error:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Не удалось восстановить базу' });
    }
});

// For when the copies on the server are gone too: a file downloaded earlier
// from this panel is sent back as the raw request body.
router.post('/backups/upload-restore', express.raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    const { fileName, filePath } = await saveUploadedBackup(req.body);

    try {
        respondRestored(req, res, restoreDatabaseFromFile(filePath), fileName);
    } catch (error) {
        fs.rmSync(filePath, { force: true });
        console.error('Backup upload-restore error:', error);
        res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Не удалось восстановить базу' });
    }
});

module.exports = router;
