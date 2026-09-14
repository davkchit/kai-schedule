const { PORT } = require('./config');
const { createApp } = require('./app');
const { getDb, getDbPath } = require('./db');
const { startDailyBackups } = require('./autoBackup');

const { app, hasFrontendBuild } = createApp();

if (require.main === module) {
    startDailyBackups(getDb, getDbPath);

    app.listen(PORT, () => {
        console.log(`KAI Schedule server running at http://localhost:${PORT}`);
        console.log(`Schedule:  http://localhost:${PORT}/`);
        console.log(`Admin:     http://localhost:${PORT}/admin`);
        console.log(`Dashboard: http://localhost:${PORT}/admin/dashboard`);
        console.log(`Frontend source: ${hasFrontendBuild ? 'dist build' : 'not built yet'}`);
    });
}

module.exports = { app };
