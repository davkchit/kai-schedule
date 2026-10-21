import { useEffect, useState } from 'react';

// «Вход и безопасность» in Settings: the password, the second factor (a code
// from an authenticator app, with one-time recovery codes) and ending every
// session. Keeps its own state, like the «Сессия» section.
//
// If the admin is ever locked out anyway, the way back is on the server:
// `node server/admin-tool.js` (unlock, reset-2fa, set-password).
export default function SecuritySection({ isActive, api, setToastMessage, onLoggedOut }) {
    const [status, setStatus] = useState(null);
    const [passwordForm, setPasswordForm] = useState({ current: '', next: '', repeat: '' });
    // null | { step: 'password' } | { step: 'scan', qr, secret, code } | { step: 'codes', codes }
    const [setup, setSetup] = useState(null);
    const [setupPassword, setSetupPassword] = useState('');
    const [disableForm, setDisableForm] = useState(null);
    const [isBusy, setIsBusy] = useState(false);

    async function loadStatus() {
        try {
            const response = await api('/api/admin/account/security');
            if (response.ok) setStatus(await response.json());
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Не удалось загрузить настройки входа');
        }
    }

    useEffect(() => {
        if (isActive) loadStatus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive]);

    async function send(url, body, method = 'POST') {
        setIsBusy(true);
        try {
            const response = await api(url, { method, body: JSON.stringify(body) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) setToastMessage(data.error || 'Не удалось сохранить');
            return response.ok ? data : null;
        } catch (error) {
            if (error.message !== 'UNAUTHORIZED') setToastMessage('Ошибка сети');
            return null;
        } finally {
            setIsBusy(false);
        }
    }

    async function changePassword(event) {
        event.preventDefault();

        if (passwordForm.next !== passwordForm.repeat) {
            setToastMessage('Новые пароли не совпадают');
            return;
        }

        const done = await send('/api/admin/account', { current_password: passwordForm.current, new_password: passwordForm.next }, 'PUT');

        if (done) {
            setPasswordForm({ current: '', next: '', repeat: '' });
            setToastMessage('Пароль изменён. На остальных устройствах нужно войти заново.');
            loadStatus();
        }
    }

    async function startSetup(event) {
        event.preventDefault();
        const data = await send('/api/admin/account/totp/setup', { current_password: setupPassword });

        if (data) {
            setSetupPassword('');
            setSetup({ step: 'scan', qr: data.qr_svg, secret: data.secret, code: '' });
        }
    }

    async function confirmSetup(event) {
        event.preventDefault();
        const data = await send('/api/admin/account/totp/enable', { code: setup.code });

        if (data) {
            setSetup({ step: 'codes', codes: data.recovery_codes });
            loadStatus();
        }
    }

    async function newRecoveryCodes() {
        const password = window.prompt('Текущий пароль — старые резервные коды перестанут работать:');
        if (!password) return;
        const data = await send('/api/admin/account/totp/recovery-codes', { current_password: password });
        if (data) {
            setSetup({ step: 'codes', codes: data.recovery_codes });
            loadStatus();
        }
    }

    async function disable(event) {
        event.preventDefault();
        const done = await send('/api/admin/account/totp/disable', { current_password: disableForm.password, code: disableForm.code });

        if (done) {
            setDisableForm(null);
            setToastMessage('Вход с кодом выключен');
            loadStatus();
        }
    }

    async function logoutEverywhere() {
        if (!window.confirm('Завершить все сессии — на этом и на всех других устройствах? Потом нужно будет войти заново.')) return;
        const done = await send('/api/admin/account/logout-everywhere', {});
        if (done) onLoggedOut();
    }

    function downloadCodes(codes) {
        const text = `КАИ Расписание — резервные коды для входа (${status?.username || ''}).\nКаждый код работает один раз.\n\n${codes.join('\n')}\n`;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        link.download = 'kai-rezervnye-kody.txt';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    }

    return (
        <>
            <h3 className="subsection-title">Вход и безопасность</h3>

            <div className="settings-form security-block">
                <form className="setting-row" onSubmit={changePassword}>
                    <label htmlFor="currentPassword">Сменить пароль</label>
                    <p className="setting-hint">Не короче 12 символов. Проще всего — несколько слов подряд. После смены все другие устройства выйдут из админки.</p>
                    <input id="currentPassword" type="password" className="setting-input" placeholder="Текущий пароль" autoComplete="current-password" required
                        value={passwordForm.current} onChange={(event) => setPasswordForm((previous) => ({ ...previous, current: event.target.value }))} />
                    <input type="password" className="setting-input security-gap" placeholder="Новый пароль" autoComplete="new-password" required minLength={12}
                        value={passwordForm.next} onChange={(event) => setPasswordForm((previous) => ({ ...previous, next: event.target.value }))} />
                    <input type="password" className="setting-input security-gap" placeholder="Новый пароль ещё раз" autoComplete="new-password" required minLength={12}
                        value={passwordForm.repeat} onChange={(event) => setPasswordForm((previous) => ({ ...previous, repeat: event.target.value }))} />
                    <button type="submit" className="btn btn-primary security-gap" disabled={isBusy}>Сменить пароль</button>
                </form>

                <div className="setting-row">
                    <label>Вход с кодом из приложения</label>
                    <p className="setting-hint">
                        Кроме пароля, при входе спрашивается 6-значный код из приложения на телефоне (Яндекс Ключ, Google Authenticator).
                        Даже если пароль узнают, без телефона войти не получится.
                    </p>

                    {status && !status.totp_enabled && !setup && (
                        <button type="button" className="btn btn-secondary" onClick={() => setSetup({ step: 'password' })}>Включить</button>
                    )}

                    {setup?.step === 'password' && (
                        <form onSubmit={startSetup}>
                            <input type="password" className="setting-input" placeholder="Текущий пароль" autoComplete="current-password" required autoFocus
                                value={setupPassword} onChange={(event) => setSetupPassword(event.target.value)} />
                            <div className="security-actions">
                                <button type="submit" className="btn btn-primary" disabled={isBusy}>Дальше</button>
                                <button type="button" className="btn btn-secondary" onClick={() => setSetup(null)}>Отмена</button>
                            </div>
                        </form>
                    )}

                    {setup?.step === 'scan' && (
                        <form onSubmit={confirmSetup}>
                            <p className="setting-hint">1. Откройте приложение и отсканируйте код (или введите ключ вручную).</p>
                            {/* The SVG comes from our own server (the qrcode package), not from user input. */}
                            <div className="security-qr" dangerouslySetInnerHTML={{ __html: setup.qr }} />
                            <p className="security-secret">{setup.secret}</p>
                            <p className="setting-hint">2. Введите 6 цифр, которые показывает приложение.</p>
                            <input type="text" inputMode="numeric" className="setting-input" placeholder="000000" autoComplete="one-time-code" required autoFocus
                                value={setup.code} onChange={(event) => setSetup((previous) => ({ ...previous, code: event.target.value }))} />
                            <div className="security-actions">
                                <button type="submit" className="btn btn-primary" disabled={isBusy}>Включить</button>
                                <button type="button" className="btn btn-secondary" onClick={() => setSetup(null)}>Отмена</button>
                            </div>
                        </form>
                    )}

                    {setup?.step === 'codes' && (
                        <div className="security-codes">
                            <p className="setting-hint">
                                <strong>Сохраните резервные коды</strong> — они нужны, если телефон потеряется. Каждый работает один раз.
                                Больше они показаны не будут.
                            </p>
                            <ul>{setup.codes.map((code) => <li key={code}>{code}</li>)}</ul>
                            <div className="security-actions">
                                <button type="button" className="btn btn-secondary" onClick={() => downloadCodes(setup.codes)}>Скачать файлом</button>
                                <button type="button" className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(setup.codes.join('\n')).then(() => setToastMessage('Скопировано'))}>Скопировать</button>
                                <button type="button" className="btn btn-primary" onClick={() => setSetup(null)}>Я сохранил коды</button>
                            </div>
                        </div>
                    )}

                    {status?.totp_enabled && !setup && (
                        <>
                            <p className="security-on">Включено · резервных кодов осталось: {status.recovery_codes_left}</p>
                            {!disableForm ? (
                                <div className="security-actions">
                                    <button type="button" className="btn btn-secondary" onClick={newRecoveryCodes} disabled={isBusy}>Новые резервные коды</button>
                                    <button type="button" className="btn btn-delete" onClick={() => setDisableForm({ password: '', code: '' })}>Выключить</button>
                                </div>
                            ) : (
                                <form onSubmit={disable}>
                                    <input type="password" className="setting-input" placeholder="Текущий пароль" autoComplete="current-password" required
                                        value={disableForm.password} onChange={(event) => setDisableForm((previous) => ({ ...previous, password: event.target.value }))} />
                                    <input type="text" className="setting-input security-gap" placeholder="Код из приложения или резервный код" autoComplete="one-time-code" required
                                        value={disableForm.code} onChange={(event) => setDisableForm((previous) => ({ ...previous, code: event.target.value }))} />
                                    <div className="security-actions">
                                        <button type="submit" className="btn btn-delete" disabled={isBusy}>Выключить вход с кодом</button>
                                        <button type="button" className="btn btn-secondary" onClick={() => setDisableForm(null)}>Отмена</button>
                                    </div>
                                </form>
                            )}
                        </>
                    )}
                </div>

                <div className="setting-row">
                    <label>Сессии</label>
                    <p className="setting-hint">
                        Вход действует до 12 часов и заканчивается после 4 часов без действий.
                        {status ? ` Сейчас открыто: ${status.sessions_active}.` : ''} Если вы входили с чужого компьютера или потеряли телефон — завершите все.
                    </p>
                    <button type="button" className="btn btn-secondary" onClick={logoutEverywhere} disabled={isBusy}>Выйти на всех устройствах</button>
                </div>
            </div>
        </>
    );
}
