// Runs in <head>, before anything is painted: the page starts in the theme it
// will have, so a phone in dark mode never flashes white while the app's code
// and styles load. The same rule as src/lib/theme.js (the stored choice, else
// the system's); main.jsx applies the theme again once the app is running.
// A file of its own rather than an inline script: the CSP allows 'self' only.
(function () {
    var theme = null;

    try {
        theme = localStorage.getItem('kai_schedule_theme');
    } catch (error) {
        theme = null;
    }

    if (theme !== 'light' && theme !== 'dark') {
        theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    document.documentElement.setAttribute('data-theme', theme);

    var meta = document.querySelector('meta[name="theme-color"]');

    if (meta) {
        meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#7CB9E8');
    }
})();
