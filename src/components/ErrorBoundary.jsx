import { Component } from 'react';
import ErrorScreen from './ErrorScreen';

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
            <ErrorScreen
                text={['Расписание никуда не делось — не отобразилась сама страница.', 'Обычно помогает обновление страницы.']}
                onRetry={() => window.location.reload()}
                onHome={goHome}
                detail={this.state.message}
            />
        );
    }
}

/**
 * Back to the group search. The saved group is forgotten first: otherwise the
 * welcome page would send the user straight back to the schedule — the very
 * page that just crashed.
 */
function goHome() {
    try {
        localStorage.removeItem('kai_schedule_selection');
    } catch {
        // Storage unavailable: the search page still opens.
    }
    window.location.assign('/');
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
