import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { registerServiceWorker } from './lib/pwa';
import './styles/base.css';

const savedTheme = localStorage.getItem('kai_schedule_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);

registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
        <BrowserRouter>
            <App />
        </BrowserRouter>
    </ErrorBoundary>
);
