// Light or dark. Until the person flips the toggle the app follows the system,
// and keeps following it while open (a phone that goes dark in the evening
// takes the page with it). A flip is remembered — unless it lands on what the
// system shows anyway: then the choice is forgotten and the app follows the
// system again. So one plain toggle covers «auto» without a third button.

const THEME_KEY = 'kai_schedule_theme';
const THEME_EVENT = 'kai-theme-change';
// The phone's status bar of the installed app follows the theme too.
const THEME_COLORS = { light: '#7CB9E8', dark: '#0f172a' };

function systemQuery() {
    return typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
}

function systemTheme() {
    return systemQuery()?.matches ? 'dark' : 'light';
}

function storedTheme() {
    try {
        const value = localStorage.getItem(THEME_KEY);
        return value === 'light' || value === 'dark' ? value : null;
    } catch {
        return null;
    }
}

/** The theme shown now: the person's choice, or else the system's. */
export function currentTheme() {
    return storedTheme() || systemTheme();
}

export function applyTheme() {
    const theme = currentTheme();
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

/** The toggle was flipped to `theme`. */
export function chooseTheme(theme) {
    try {
        if (theme === systemTheme()) {
            localStorage.removeItem(THEME_KEY);
        } else {
            localStorage.setItem(THEME_KEY, theme);
        }
    } catch {
        // Storage unavailable: the choice still applies until the page closes.
    }

    // The whole page eases from one theme to the other in one composited
    // cross-fade, instead of some parts flipping at once while others fade —
    // an abrupt brightness jump is exactly what a theme switch must not do.
    // Browsers without View Transitions (or with reduced motion asked for)
    // just switch.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (document.startViewTransition && !reduceMotion) {
        document.startViewTransition(applyTheme);
    } else {
        applyTheme();
    }
}

/** Re-applies the theme when the system switches and nothing was chosen. */
export function watchSystemTheme() {
    systemQuery()?.addEventListener('change', () => {
        if (!storedTheme()) {
            applyTheme();
        }
    });
}

/** Calls back with 'light' | 'dark' whenever the shown theme changes. */
export function onThemeChange(callback) {
    const listener = (event) => callback(event.detail);
    window.addEventListener(THEME_EVENT, listener);
    return () => window.removeEventListener(THEME_EVENT, listener);
}
