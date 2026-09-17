import { Component } from 'react';

/**
 * Last line of defence for the whole app.
 *
 * Without it, one unexpected shape in the data (a missing field, a lesson
 * without a time) takes React's render down and leaves a blank white page —
 * no message, no way back, and no hint of what happened. That is the worst
 * possible failure for a student standing in a corridor before a pair.
 *
 * A class is required here: componentDidCatch has no hook equivalent.
 */
export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, message: '' };
    }

    static getDerivedStateFromError(error) {
        return { hasError: true, message: error?.message || 'Неизвестная ошибка' };
    }

    componentDidCatch(error, info) {
        // Kept in the console so the person debugging has the stack, and
        // reported once so a crash in the browser isn't invisible.
        console.error('Ошибка интерфейса:', error, info?.componentStack);
        reportClientError(error, info);
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        return (
            <div className="app-error">
                <div className="app-error-card">
                    <h1>Что-то сломалось на этой странице</h1>
                    <p>
                        Расписание никуда не делось — не отобразилась сама страница. Обычно помогает
                        обновление; если нет, попробуйте позже или напишите администратору.
                    </p>
                    <div className="app-error-actions">
                        <button type="button" onClick={() => window.location.reload()}>
                            Обновить страницу
                        </button>
                        <a href="/">На главную</a>
                    </div>
                    <p className="app-error-detail">{this.state.message}</p>
                </div>
            </div>
        );
    }
}

/**
 * Tells the server that a browser crashed. Fire-and-forget and wrapped in
 * try/catch: an error while reporting an error must not start a loop.
 */
function reportClientError(error, info) {
    try {
        const body = JSON.stringify({
            message: String(error?.message || error).slice(0, 500),
            stack: String(error?.stack || '').slice(0, 2000),
            component_stack: String(info?.componentStack || '').slice(0, 1000),
            path: window.location.pathname
        });

        if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
            return;
        }

        fetch('/api/client-error', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true
        }).catch(() => {});
    } catch {
        // Nothing more to do — the message is already in the console.
    }
}
