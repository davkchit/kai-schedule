import { useState } from 'react';

// Requests to /api/admin: JSON by default, the CSRF token on every state-changing
// call (fetched once from the session and kept), and a 401 sends the admin back
// to the login page. Moved verbatim from AdminDashboardPage.jsx.
export default function useAdminApi(navigate) {
    const [csrfToken, setCsrfToken] = useState('');

    function isUnsafeMethod(method = 'GET') {
        return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
    }

    async function getCsrfTokenForRequest() {
        if (csrfToken) {
            return csrfToken;
        }

        const sessionResponse = await fetch('/api/admin/session');

        if (sessionResponse.status === 401) {
            navigate('/admin', { replace: true });
            throw new Error('UNAUTHORIZED');
        }

        const sessionData = await sessionResponse.json();
        const nextToken = sessionData.csrf_token || '';

        setCsrfToken(nextToken);
        return nextToken;
    }

    async function api(path, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const headers = {
            ...(options.headers || {})
        };

        if (options.body !== undefined && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        if (isUnsafeMethod(method)) {
            const nextCsrfToken = await getCsrfTokenForRequest();

            if (nextCsrfToken) {
                headers['X-CSRF-Token'] = nextCsrfToken;
            }
        }

        const response = await fetch(path, {
            ...options,
            method,
            headers
        });

        if (response.status === 401) {
            navigate('/admin', { replace: true });
            throw new Error('UNAUTHORIZED');
        }

        return response;
    }

    return { api, setCsrfToken };
}
