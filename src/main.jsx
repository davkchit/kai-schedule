import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { registerServiceWorker } from './lib/pwa';
import { applyTheme, watchSystemTheme } from './lib/theme';
import './styles/base.css';

// Before the first render, so the page never flashes the wrong theme.
applyTheme();
watchSystemTheme();

registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
        <BrowserRouter>
            <App />
        </BrowserRouter>
    </ErrorBoundary>
);
