const { PORT } = require('./config');
const { createApp } = require('./app');
const { getDb, getDbPath } = require('./db');
const { startDailyBackups } = require('./autoBackup');
const { notify } = require('./alerts');

const { app, hasFrontendBuild } = createApp();

if (require.main === module) {
    // A process that dies silently is the case this alerting exists for:
    // systemd restarts the service (Restart=always), and without this nobody
    // ever learns that it happened, or why.
    process.on('uncaughtException', (error) => {
        notify(`Сервер упал: ${error.stack || error.message}`, { key: 'uncaught' });
        setTimeout(() => process.exit(1), 1000).unref();
    });

    process.on('unhandledRejection', (reason) => {
        notify(`Необработанная ошибка: ${reason instanceof Error ? reason.stack : String(reason)}`, { key: 'unhandled' });
    });

    startDailyBackups(getDb, getDbPath);

    app.listen(PORT, () => {
        console.log(`KAI Schedule server running at http://localhost:${PORT}`);
        console.log(`Schedule:  http://localhost:${PORT}/`);
        console.log(`Admin:     http://localhost:${PORT}/admin`);
        console.log(`Dashboard: http://localhost:${PORT}/admin/dashboard`);
        console.log(`Frontend source: ${hasFrontendBuild ? 'dist build' : 'not built yet'}`);

        // Every start is worth knowing about: after a deploy it confirms the
        // new version is up (and that alerts actually arrive), and at 3 a.m.
        // it is the only trace that the platform restarted a crashed process.
        const deployment = process.env.RAILWAY_DEPLOYMENT_ID;
        notify(`Сервер запущен${deployment ? ` (деплой ${deployment.slice(0, 8)})` : ''}`, { key: 'startup' });
    });
}

module.exports = { app };
