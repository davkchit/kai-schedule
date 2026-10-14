const SELECTION_KEY = 'kai_schedule_selection';
const ADMIN_TOKEN_KEY = 'admin_token';

export function getSavedSelection() {
    try {
        const rawValue = localStorage.getItem(SELECTION_KEY);
        return rawValue ? JSON.parse(rawValue) : null;
    } catch {
        return null;
    }
}

export function saveSelection(selection) {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
}

export function clearSelection() {
    localStorage.removeItem(SELECTION_KEY);
}

export function getAdminToken() {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token) {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken() {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
}

