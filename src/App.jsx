import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getSavedSelection } from './lib/storage';

const WelcomePage = lazy(() => import('./pages/WelcomePage'));
const SchedulePage = lazy(() => import('./pages/SchedulePage'));
const AdminLoginPage = lazy(() => import('./pages/AdminLoginPage'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'));
const TeacherLookupPage = lazy(() => import('./pages/TeacherLookupPage'));

// The installed app starts at "/": a student whose group is saved goes
// straight to the schedule, without the group search showing for a frame.
function Home() {
    const saved = getSavedSelection();

    return saved?.group_id && saved?.subgroup ? <Navigate to="/schedule" replace /> : <WelcomePage />;
}

export default function App() {
    return (
        <Suspense fallback={null}>
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/schedule" element={<SchedulePage />} />
                <Route path="/admin" element={<AdminLoginPage />} />
                <Route path="/admin/dashboard" element={<AdminDashboardPage />} />
                <Route path="/teacher" element={<TeacherLookupPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </Suspense>
    );
}
