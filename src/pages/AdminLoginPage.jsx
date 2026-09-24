import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import usePageAssets from '../hooks/usePageAssets';

export default function AdminLoginPage() {
    const isAssetsReady = usePageAssets({
        title: 'Вход для администратора',
        description: 'Вход для администраторов системы расписания.',
        stylesheets: ['/css/admin-login.css']
    });

    const navigate = useNavigate();
    const [login, setLogin] = useState('');
    const [password, setPassword] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

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
            const response = await fetch('/api/admin/login', {
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

            if (response.ok) {
                navigate('/admin/dashboard', { replace: true });
                return;
            }

            setErrorMessage(data.error || 'Неправильный логин или пароль');
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
                <img src="/assets/logo.png" alt="Логотип КАИ" width="148" height="62" />
            </header>
            <div className="background-circles">
                <div className="circle circle-1"></div>
                <div className="circle circle-2"></div>
                <div className="circle circle-3"></div>
                <div className="circle circle-4"></div>
            </div>
            <div className="container">
                <div className="card">
                    <h1 className="title">Вход для<br />администратора</h1>
                    <form id="adminForm" className="login-form" onSubmit={handleSubmit}>
                        <div className="input-group">
                            <input
                                type="text"
                                id="loginInput"
                                className="admin-input"
                                placeholder="Введите логин"
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
                                className="admin-input"
                                placeholder="Введите пароль"
                                autoComplete="current-password"
                                required
                                value={password}
                                onChange={(event) => {
                                    setPassword(event.target.value);
                                    setErrorMessage('');
                                }}
                            />
                        </div>
                        <div
                            id="errorMessage"
                            className="error-message"
                            style={{ display: errorMessage ? 'block' : 'none' }}
                        >
                            {errorMessage}
                        </div>
                        <button type="submit" className="submit-button" disabled={isSubmitting}>
                            {isSubmitting ? 'Вход...' : 'Войти'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
