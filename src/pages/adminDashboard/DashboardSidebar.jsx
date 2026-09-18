// Left navigation of the admin dashboard.
// Presentational only: moved verbatim from AdminDashboardPage.jsx, every
// value and handler comes from the page as a prop of the same name.
export default function DashboardSidebar({
    activeSection,
    auditLogs,
    backups,
    loadAuditLogs,
    loadBackups,
    logout,
    setActiveSection
}) {
    return (
        <aside className="sidebar">
            <div className="sidebar-header">
                <img src="/assets/logo.png" alt="Логотип КАИ" width="108" height="45" />
                <span className="sidebar-title">КАИ Расписание</span>
            </div>
            <nav className="sidebar-nav">
                <button className={`nav-item ${activeSection === 'builder' ? 'active' : ''}`} data-section="builder" id="navBuilder" onClick={() => setActiveSection('builder')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                        <line x1="3" y1="15" x2="21" y2="15" />
                        <line x1="9" y1="9" x2="9" y2="21" />
                        <line x1="15" y1="9" x2="15" y2="21" />
                    </svg>
                    Конструктор
                </button>
                <button className={`nav-item ${activeSection === 'settings' ? 'active' : ''}`} data-section="settings" id="navSettings" onClick={() => setActiveSection('settings')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                    </svg>
                    Настройки
                </button>
                <button
                    className={`nav-item ${activeSection === 'load' ? 'active' : ''}`}
                    data-section="load"
                    id="navLoad"
                    onClick={() => setActiveSection('load')}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20V10" />
                        <path d="M18 20V4" />
                        <path d="M6 20v-4" />
                    </svg>
                    Нагрузка
                </button>
                <button
                    className={`nav-item ${activeSection === 'backup' ? 'active' : ''}`}
                    data-section="backup"
                    id="navBackup"
                    onClick={() => {
                        setActiveSection('backup');

                        if (backups.length === 0) {
                            loadBackups();
                        }
                    }}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 8v13H3V8" />
                        <path d="M1 3h22v5H1z" />
                        <path d="M10 12h4" />
                    </svg>
                    Резервные копии
                </button>
                <button
                    className={`nav-item ${activeSection === 'audit' ? 'active' : ''}`}
                    data-section="audit"
                    id="navAudit"
                    onClick={() => {
                        setActiveSection('audit');

                        if (auditLogs.length === 0) {
                            loadAuditLogs();
                        }
                    }}
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 8v4l3 3" />
                        <circle cx="12" cy="12" r="9" />
                    </svg>
                    Журнал
                </button>
            </nav>
            <button className="nav-item logout-btn" id="logoutBtn" onClick={logout}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Выйти
            </button>
        </aside>
    );
}
