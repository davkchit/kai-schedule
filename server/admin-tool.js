#!/usr/bin/env node
// The way back in when the admin page itself won't let anyone in: run on the
// server, as the service user, with the service's environment, e.g.
//
//   sudo -u kai bash -c 'set -a; . /etc/kai.env; cd /opt/kai/app && node server/admin-tool.js unlock'
//
// Commands:
//   unlock                  forget failed login attempts (the pause after wrong passwords)
//   reset-2fa <login>       turn the second factor off (lost phone, recovery codes gone)
//   add-admin <login>       a separate account (each person their own: own phone for the code, own name in the journal)
//   remove-admin <login>    delete an account (never the last one)
//   set-password <login>    set a new password (read from the terminal, never from the command line)
//   logout-all              end every admin session
//   list                    show admins and whether the second factor is on
//
// Every change is written to the audit journal like one made in the panel.

const fs = require('fs');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { getDb, getDbPath, closeDb } = require('./db');
const { writeAuditLog } = require('./audit');

function audit(db, action, admin, details) {
    writeAuditLog(db, {
        adminId: admin ? admin.id : null,
        action,
        entityType: 'admin_account',
        entityId: admin ? admin.id : null,
        ipAddress: 'admin-tool',
        details: { ...details, via: 'admin-tool' }
    });
}

function findAdmin(db, login) {
    const admin = login ? db.prepare('SELECT * FROM admins WHERE username = ?').get(login) : null;

    if (!admin) {
        console.error(`Нет администратора «${login || ''}». Список: node server/admin-tool.js list`);
        process.exit(1);
    }

    return admin;
}

// One reader for every question; typed characters are not echoed. Piped
// input (scripts, tests) is read whole up front and handed out line by line.
let reader = null;
let promptText = '';
let pipedLines = null;

function askHidden(question) {
    if (!process.stdin.isTTY) {
        pipedLines ??= fs.readFileSync(0, 'utf8').split(/\r?\n/);
        return Promise.resolve(pipedLines.shift() ?? '');
    }

    if (!reader) {
        reader = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
        reader._writeToOutput = (text) => { if (text.includes(promptText)) process.stdout.write(text); };
    }

    promptText = question;
    return new Promise((resolve) => {
        reader.question(question, (answer) => { process.stdout.write('\n'); resolve(answer); });
    });
}

/** Asked twice in the terminal, same rules as the panel: 12+ characters, not containing the login. */
async function askNewPassword(username) {
    const password = await askHidden('Пароль (от 12 символов): ');

    if (password.length < 12 || password.toLowerCase().includes(username.toLowerCase())) {
        console.error('Пароль должен быть не короче 12 символов и не содержать логин.');
        process.exit(1);
    }

    if (await askHidden('Ещё раз: ') !== password) {
        console.error('Пароли не совпали.');
        process.exit(1);
    }

    return password;
}

async function main() {
    const [command, login] = process.argv.slice(2);

    // Opening a missing file would create a fresh database from the seed —
    // run without the service's DB_PATH, that is the wrong database entirely.
    if (!fs.existsSync(getDbPath())) {
        console.error(`Базы нет по пути ${getDbPath()} — запустите с переменными службы (DB_PATH), см. начало файла.`);
        process.exit(1);
    }

    console.log(`База: ${getDbPath()}`);
    const db = getDb();

    switch (command) {
        case 'unlock': {
            const cleared = db.prepare('DELETE FROM login_attempts').run().changes;
            audit(db, 'admin.unlock', null, { cleared });
            console.log(`Блокировки входа сняты (${cleared}).`);
            break;
        }
        case 'reset-2fa': {
            const admin = findAdmin(db, login);
            db.prepare('UPDATE admins SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?').run(admin.id);
            db.prepare('DELETE FROM admin_recovery_codes WHERE admin_id = ?').run(admin.id);
            audit(db, 'admin.totp_disable', admin, {});
            console.log(`Второй фактор у «${admin.username}» выключен. Войдите по паролю и включите его заново.`);
            break;
        }
        case 'add-admin': {
            if (!/^[\w.@-]{3,100}$/.test(login || '')) {
                console.error('Укажите логин: латиница, цифры, точка, дефис — от 3 символов. Например: add-admin zhenya');
                process.exit(1);
            }

            if (db.prepare('SELECT 1 FROM admins WHERE username = ?').get(login)) {
                console.error(`Логин «${login}» уже занят.`);
                process.exit(1);
            }

            const password = await askNewPassword(login);
            const id = db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(login, bcrypt.hashSync(password, 10)).lastInsertRowid;
            audit(db, 'admin.create', { id }, { username: login });
            console.log(`Администратор «${login}» добавлен. Пусть войдёт, сменит пароль в Настройках и включит вход с кодом.`);
            break;
        }
        case 'remove-admin': {
            const admin = findAdmin(db, login);

            if (db.prepare('SELECT COUNT(*) AS c FROM admins').get().c <= 1) {
                console.error('Это последний администратор — удалить нельзя, иначе войти будет некому.');
                process.exit(1);
            }

            db.prepare('DELETE FROM admins WHERE id = ?').run(admin.id);
            audit(db, 'admin.delete', null, { username: admin.username });
            console.log(`Администратор «${admin.username}» удалён, его сессии завершены.`);
            break;
        }
        case 'set-password': {
            const admin = findAdmin(db, login);
            const password = await askNewPassword(admin.username);

            db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), admin.id);
            db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(admin.id);
            audit(db, 'admin.update_credentials', admin, { password_changed: true });
            console.log(`Пароль «${admin.username}» изменён, все его сессии завершены.`);
            break;
        }
        case 'logout-all': {
            const ended = db.prepare('DELETE FROM admin_sessions').run().changes;
            audit(db, 'admin.logout_everywhere', null, { sessions_ended: ended });
            console.log(`Завершено сессий: ${ended}.`);
            break;
        }
        case 'list': {
            for (const admin of db.prepare('SELECT username, totp_enabled FROM admins ORDER BY id').all()) {
                console.log(`${admin.username}\tвторой фактор: ${admin.totp_enabled ? 'включён' : 'выключен'}`);
            }
            break;
        }
        default:
            console.log('Команды: unlock | reset-2fa <логин> | add-admin <логин> | remove-admin <логин> | set-password <логин> | logout-all | list');
            process.exitCode = command ? 1 : 0;
    }

    if (reader) reader.close();
    closeDb();
}

main();
