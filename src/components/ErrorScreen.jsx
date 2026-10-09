import AuroraBackground from './AuroraBackground';

/**
 * The full-page "something went wrong" screen: the schedule failing to load
 * and the app crashing (ErrorBoundary) both end here. Its styles live in the
 * global stylesheet (src/styles/base.css), so it renders even when a page's
 * own CSS never arrived.
 */
export default function ErrorScreen({ text, onRetry, onHome, detail }) {
    return (
        <div className="error-screen" role="alert">
            <AuroraBackground />

            <div className="error-screen-stack">
                <img className="error-screen-logo" src="/assets/logo-trim.png" alt="Логотип КАИ" width="180" height="38" />

                <div className="error-screen-card">
                    <ErrorPlanet />
                    <h1 className="error-screen-title">Что-то пошло не так</h1>
                    <p className="error-screen-text">
                        {text.map((line) => <span key={line}>{line}</span>)}
                    </p>
                    <div className="error-screen-actions">
                        <button type="button" className="ui-btn ui-btn--primary ui-btn--lg" onClick={onRetry}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                                <path d="M21 4v5h-5" />
                            </svg>
                            Обновить страницу
                        </button>
                        <button type="button" className="ui-btn ui-btn--ghost ui-btn--lg" onClick={onHome}>
                            На главную
                        </button>
                    </div>
                    {detail && <p className="error-screen-detail">{detail}</p>}
                </div>
            </div>
        </div>
    );
}

// A glowing sphere with a tilted ring and a "!" — the back half of the ring is
// drawn before the sphere, the front half after, so the ring wraps around it.
function ErrorPlanet() {
    return (
        <svg className="error-planet" width="150" height="96" viewBox="0 0 150 96" aria-hidden="true">
            <defs>
                <radialGradient id="errorPlanetFill" cx="38%" cy="32%" r="75%">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="60%" stopColor="#eaf2ff" />
                    <stop offset="100%" stopColor="#cfe0fb" />
                </radialGradient>
            </defs>
            <g transform="rotate(-18 75 48)">
                <path d="M 13 48 A 62 15 0 0 1 137 48" fill="none" className="error-planet-ring" />
            </g>
            <circle cx="75" cy="48" r="32" fill="url(#errorPlanetFill)" className="error-planet-sphere" />
            <g transform="rotate(-18 75 48)">
                <path d="M 137 48 A 62 15 0 0 1 13 48" fill="none" className="error-planet-ring" />
            </g>
            <rect x="72" y="31" width="6" height="21" rx="3" className="error-planet-mark" />
            <circle cx="75" cy="60" r="3.6" className="error-planet-mark" />
        </svg>
    );
}
