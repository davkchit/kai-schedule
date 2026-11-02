// Light or dark. Until the person flips the toggle the app follows the system,
// and keeps following it while open (a phone that goes dark in the evening
// takes the page with it). A flip is remembered — unless it lands on what the
// system shows anyway: then the choice is forgotten and the app follows the
// system again. So one plain toggle covers «auto» without a third button.

// client-public/theme-boot.js repeats this key and these colours: it sets the
// theme before the app loads. Change both together.
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

function applyThemeColor(theme) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

export function applyTheme({ themeColor = true } = {}) {
    const theme = currentTheme();
    document.documentElement.setAttribute('data-theme', theme);

    if (themeColor) {
        applyThemeColor(theme);
    }

    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

// How long the new theme takes to spread from the toggle over the screen.
const REVEAL_MS = 450;

/**
 * The toggle was flipped to `theme`. `origin` ({ x, y } in viewport pixels,
 * where it was tapped) makes the new theme open out as a circle from there.
 */
export function chooseTheme(theme, origin = null) {
    try {
        if (theme === systemTheme()) {
            localStorage.removeItem(THEME_KEY);
        } else {
            localStorage.setItem(THEME_KEY, theme);
        }
    } catch {
        // Storage unavailable: the choice still applies until the page closes.
    }

    // The whole page changes in one View Transition, instead of some parts
    // flipping at once while others fade. Browsers without View Transitions
    // (or with reduced motion asked for) just switch.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (!document.startViewTransition || reduceMotion) {
        applyTheme();
        return;
    }

    // From the toggle the new theme opens out as a circle over the old one
    // (theme-reveal in base.css turns the cross-fade off). A cross-fade of
    // light into dark passes through a muddy grey, and on a mid-range Android
    // phone that blend drops frames — the switch looked torn.
    const root = document.documentElement;
    const reveal = Boolean(origin);

    if (reveal) {
        root.classList.add('theme-reveal');
    }

    // The status bar can't be animated: it flips halfway through, not at the
    // tap while the page still shows the old theme.
    const transition = document.startViewTransition(() => applyTheme({ themeColor: false }));

    transition.ready
        .then(() => {
            if (reveal) {
                const { x, y } = origin;
                const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

                root.animate(
                    { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
                    { duration: REVEAL_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
                );
            }

            window.setTimeout(() => applyThemeColor(currentTheme()), REVEAL_MS / 2);
        })
        .catch(() => applyThemeColor(currentTheme()));

    transition.finished.finally(() => root.classList.remove('theme-reveal'));
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
