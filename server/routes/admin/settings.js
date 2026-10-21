// Settings and the audit journal.
// Mounted by ../admin.js after authentication and CSRF checks.

const express = require('express');
const { writeAuditLog } = require('../../audit');
const { getDb } = require('../../db');
const { getActiveSemester } = require('../../utils/semesters');
const { validateSettingsBody } = require('../../validation');
const { mapSemesterRow, getClientAddress } = require('./shared');

const router = express.Router();

router.get('/settings', (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};

    for (const row of rows) {
        settings[row.key] = row.value;
    }

    // The constructor numbers weeks and picks parity from the semester it is
    // editing, so it needs that semester, not just a start date.
    const active = getActiveSemester(db);
    settings.active_semester = active ? mapSemesterRow(active) : null;

    res.json(settings);
});

router.put('/settings', (req, res) => {
    let settingsPayload;

    try {
        settingsPayload = validateSettingsBody(req.body);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const db = getDb();
    const upsert = db.prepare(`
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const updatedKeys = {};

    for (const key of ['director_name', 'director_title', 'academic_year', 'study_form', 'term_parity']) {
        if (settingsPayload[key] !== null && settingsPayload[key] !== undefined) {
            upsert.run(key, settingsPayload[key]);
            updatedKeys[key] = settingsPayload[key];
        }
    }

    writeAuditLog(db, {
        adminId: req.admin.id,
        action: 'settings.update',
        entityType: 'settings',
        entityId: 'settings',
        ipAddress: getClientAddress(req),
        details: updatedKeys
    });
    res.json({ success: true });
});

router.get('/audit-logs', (req, res) => {
    try {
        const logs = getAuditLogs(req.query.limit, 200);
        res.json(logs);
    } catch (error) {
        res.status(error.statusCode || 400).json({ error: error.message });
    }
});

router.get('/audit-logs/export', (req, res) => {
    let logs;

    try {
        logs = getAuditLogs(req.query.limit === undefined ? 1000 : req.query.limit, 5000);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ error: error.message });
    }

    const csv = buildAuditCsv(logs);
    const stamp = formatTimestampForFileName(new Date());

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.csv"`);
    res.send(csv);
});

function mapAuditLogRow(row) {
    return {
        id: row.id,
        action: row.action,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        ip_address: row.ip_address,
        created_at: row.created_at,
        admin_username: row.admin_username,
        details: parseAuditDetails(row.details)
    };
}

function parseAuditDetails(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function getAuditLogs(limitValue, maxLimit) {
    const db = getDb();
    const limit = parsePositiveInteger(limitValue, 'Параметр limit', 1, maxLimit);
    const rows = db.prepare(`
        SELECT al.id, al.action, al.entity_type, al.entity_id, al.ip_address, al.details, al.created_at,
               a.username AS admin_username
        FROM audit_logs al
        LEFT JOIN admins a ON a.id = al.admin_id
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ?
    `).all(limit);

    return rows.map(mapAuditLogRow);
}

function parsePositiveInteger(value, label, min, max) {
    const normalized = value === undefined ? min : Number.parseInt(value, 10);

    if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
        const error = new Error(`${label} должен быть числом от ${min} до ${max}`);
        error.statusCode = 400;
        throw error;
    }

    return normalized;
}

function buildAuditCsv(logs) {
    const header = ['id', 'created_at', 'admin_username', 'action', 'entity_type', 'entity_id', 'ip_address', 'details'];
    const rows = logs.map((log) => ([
        log.id,
        log.created_at || '',
        log.admin_username || '',
        log.action || '',
        log.entity_type || '',
        log.entity_id || '',
        log.ip_address || '',
        log.details ? JSON.stringify(log.details) : ''
    ]));

    return [header, ...rows]
        .map((row) => row.map(escapeCsvCell).join(','))
        .join('\n');
}

function escapeCsvCell(value) {
    let normalized = String(value ?? '');

    // A cell starting with = + - @ is run as a formula when the file is
    // opened in Excel — a group or subject name could carry one. A leading
    // apostrophe makes it plain text.
    if (/^[=+\-@\t\r]/.test(normalized)) {
        normalized = `'${normalized}`;
    }

    const escaped = normalized.replaceAll('"', '""');
    return `"${escaped}"`;
}

function formatTimestampForFileName(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

module.exports = router;
