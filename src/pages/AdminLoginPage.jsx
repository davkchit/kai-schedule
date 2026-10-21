import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuroraBackground from '../components/AuroraBackground';
import usePageAssets from '../hooks/usePageAssets';

function formatWait(seconds) {
    return seconds < 60 ? `${seconds} с` : `${Math.ceil(seconds / 60)} мин`;
}

export default function AdminLoginPage() {
    const isAssetsReady = usePageAssets({
        title: 'Вход для администратора',
        description: 'Вход для администраторов системы расписания.',
        stylesheets: ['/css/welcome.css', '/css/admin-login.css']
    });

    const navigate = useNavigate();
    const [login, setLogin] = useState('');
    const [password, setPassword] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Set after a right password when the second factor is on: the code step.
    const [ticket, setTicket] = useState(null);
    const [code, setCode] = useState('');

    useEffect(() => {
        let ignore = false;

        async function checkSession() {
            try {
                const response = await fetch('/api/admin/session');

                if (!ignore && response.ok) {
                    navigate('/admin/dashboard', { replace: true });
                }
            } catch {
                // Intentionally ignored: user is likely not authenticated yet.
            }
        }

        checkSession();

        return () => {
            ignore = true;
        };
    }, [navigate]);

    async function handleSubmit(event) {
        event.preventDefault();

        setIsSubmitting(true);
        setErrorMessage('');

        try {
            const response = ticket
                ? await fetch('/api/admin/login/second-factor', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticket, code })
                })
                : await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        username: login,
                        password
                    })
                });

            const data = await response.json();

            if (response.ok && data.needs_second_factor) {
                setTicket(data.ticket);
                setCode('');
                return;
            }

            if (response.ok) {
                navigate('/admin/dashboard', { replace: true });
                return;
            }

            if (data.restart) {
                // The five minutes for the code ran out: start over from the password.
                setTicket(null);
                setPassword('');
            }

            setErrorMessage(data.retry_after_sec
                ? `${data.error} Подождите ${formatWait(data.retry_after_sec)}.`
                : (data.error || 'Неправильный логин или пароль'));
        } catch {
            setErrorMessage('Ошибка сервера');
        } finally {
            setIsSubmitting(false);
        }
    }

    if (!isAssetsReady) {
        return null;
    }

    return (
        <div className="page-stack">
            <header className="page-logo">
                <img src="/assets/logo-trim.png" alt="Логотип КАИ" width="180" height="38" />
            </header>
            <AuroraBackground />
            <div className="container">
                <div className="card">
                    <h1 className="title">Вход для<br />администратора</h1>
                    <form id="adminForm" className="login-form" onSubmit={handleSubmit}>
                        {ticket ? (
                            <div className="input-group">
                                <p className="login-hint">Введите 6 цифр из приложения-аутентификатора. Нет телефона — введите резервный код.</p>
                                <input
                                    type="text"
                                    id="codeInput"
                                    className="search-input admin-input"
                                    placeholder="Код"
                                    autoComplete="one-time-code"
                                    inputMode="text"
                                    autoFocus
                                    required
                                    value={code}
                                    onChange={(event) => {
                                        setCode(event.target.value);
                                        setErrorMessage('');
                                    }}
                                />
                            </div>
                        ) : (
                        <>
                        <div className="input-group">
                            <input
                                type="text"
                                id="loginInput"
                                className="search-input admin-input"
                                placeholder="Логин"
                                autoComplete="username"
                                required
                                value={login}
                                onChange={(event) => {
                                    setLogin(event.target.value);
                                    setErrorMessage('');
                                }}
                            />
                        </div>
                        <div className="input-group">
                            <input
                                type="password"
                                id="passwordInput"
                                className="search-input admin-input"
                                placeholder="Пароль"
                                autoComplete="current-password"
                                required
                                value={password}
                                onChange={(event) => {
                                    setPassword(event.target.value);
                                    setErrorMessage('');
                                }}
                            />
                        </div>
                        </>
                        )}
                        <div
                            id="errorMessage"
                            className="error-message"
                            style={{ display: errorMessage ? 'block' : 'none' }}
                        >
                            {errorMessage}
                        </div>
                        <button type="submit" className="ui-btn ui-btn--primary ui-btn--lg login-submit" disabled={isSubmitting}>
                            {isSubmitting ? 'Вход...' : (ticket ? 'Подтвердить' : 'Войти')}
                        </button>
                        {ticket && (
                            <button type="button" className="ui-btn ui-btn--ghost login-back" onClick={() => { setTicket(null); setPassword(''); setErrorMessage(''); }}>
                                Назад
                            </button>
                        )}
                    </form>
                </div>
            </div>
        </div>
    );
}
