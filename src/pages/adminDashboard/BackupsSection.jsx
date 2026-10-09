import { formatAuditTimestamp, formatBytes } from './format';

// Backups: list, create, download and restore.
// Presentational only: moved verbatim from AdminDashboardPage.jsx, every
// value and handler comes from the page as a prop of the same name.
export default function BackupsSection({
    activeSection,
    backups,
    createBackup,
    isBackupsLoading,
    isCreatingBackup,
    loadBackups,
    restoreBackup,
    restoreFromFile
}) {
    return (
        <section className={`content-section ${activeSection === 'backup' ? 'active' : ''}`} id="sectionBackup">
            <div className="audit-header">
                <div>
                    <h2 className="section-title">Резервные копии</h2>
                    <p className="section-desc">
                        Копия создаётся автоматически раз в день и при каждом обновлении сервера. Скачивайте копию
                        себе время от времени: если пропадёт сам сервер, базу можно вернуть из файла.
                    </p>
                </div>
                <div className="section-actions">
                    <button className="btn btn-secondary" onClick={loadBackups}>
                        Обновить список
                    </button>
                    <label className="btn btn-secondary">
                        Восстановить из файла
                        <input type="file" accept=".db" hidden onChange={restoreFromFile} />
                    </label>
                    <button className="btn btn-primary" onClick={createBackup} disabled={isCreatingBackup}>
                        {isCreatingBackup ? 'Создание...' : 'Создать копию'}
                    </button>
                </div>
            </div>
            <div className="lessons-table-wrapper audit-table-wrapper">
                <table className="lessons-table audit-table">
                    <thead>
                        <tr>
                            <th>Файл</th>
                            <th>Создан</th>
                            <th>Размер</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {backups.map((backup) => (
                            <tr key={backup.file_name}>
                                <td><strong>{backup.file_name}</strong></td>
                                <td>{formatAuditTimestamp(backup.created_at)}</td>
                                <td>{formatBytes(backup.size_bytes)}</td>
                                <td>
                                    <a className="btn-link" href={`/api/admin/backups/${encodeURIComponent(backup.file_name)}/download`}>
                                        Скачать
                                    </a>
                                    {' · '}
                                    <button type="button" className="btn-link" onClick={() => restoreBackup(backup.file_name)}>
                                        Восстановить
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className="empty-message" style={{ display: backups.length === 0 ? '' : 'none' }}>
                    {isBackupsLoading ? 'Загрузка резервных копий...' : 'Резервных копий пока нет'}
                </p>
            </div>
        </section>
    );
}
