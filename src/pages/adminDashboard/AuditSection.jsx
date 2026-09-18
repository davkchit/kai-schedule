import { formatAuditAction, formatAuditDetails, formatAuditEntity, formatAuditTimestamp } from './format';

// Audit journal: who changed what.
// Presentational only: moved verbatim from AdminDashboardPage.jsx, every
// value and handler comes from the page as a prop of the same name.
export default function AuditSection({
    activeSection,
    auditLogs,
    isAuditLogsLoading,
    loadAuditLogs
}) {
    return (
        <section className={`content-section ${activeSection === 'audit' ? 'active' : ''}`} id="sectionAudit">
            <div className="audit-header">
                <div>
                    <h2 className="section-title">Журнал действий</h2>
                    <p className="section-desc">История изменений расписания и важных действий администратора.</p>
                </div>
                <div className="section-actions">
                    <a className="btn btn-secondary" href="/api/admin/audit-logs/export?limit=1000">
                        Экспорт CSV
                    </a>
                    <button className="btn btn-secondary" onClick={loadAuditLogs}>
                        Обновить журнал
                    </button>
                </div>
            </div>
            <div className="lessons-table-wrapper audit-table-wrapper">
                <table className="lessons-table audit-table">
                    <thead>
                        <tr>
                            <th>Время</th>
                            <th>Админ</th>
                            <th>Действие</th>
                            <th>Сущность</th>
                            <th>IP</th>
                            <th>Детали</th>
                        </tr>
                    </thead>
                    <tbody>
                        {auditLogs.map((log) => (
                            <tr key={log.id}>
                                <td>{formatAuditTimestamp(log.created_at)}</td>
                                <td>{log.admin_username || '—'}</td>
                                <td><strong>{formatAuditAction(log.action)}</strong></td>
                                <td>{formatAuditEntity(log)}</td>
                                <td>{log.ip_address || '—'}</td>
                                <td className="audit-details-cell">{formatAuditDetails(log)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className="empty-message" style={{ display: auditLogs.length === 0 ? '' : 'none' }}>
                    {isAuditLogsLoading ? 'Загрузка журнала...' : 'Журнал пока пуст'}
                </p>
            </div>
        </section>
    );
}
