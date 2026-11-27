import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { menuFor, PATH } from './constants';
import { Shell } from './layout/Shell';
import { Logo } from './ui/Logo';
import { t } from './i18n';
import { Admin } from './pages/Admin';
import { Bookings } from './pages/Bookings';
import { Calendar } from './pages/Calendar';
import { Comms } from './pages/Comms';
import { Dashboard } from './pages/Dashboard';
import { Horses } from './pages/Horses';
import { Login } from './pages/Login';
import { Money } from './pages/Money';
import { People } from './pages/people/People';
import { Progress } from './pages/Progress';
import { Reports } from './pages/Reports';
import { Security } from './pages/Security';
import { Staff } from './pages/Staff';

const PAGES: Record<string, ReactElement> = {
  dashboard: <Dashboard />, calendar: <Calendar />, bookings: <Bookings />, people: <People />, horses: <Horses />, staff: <Staff />,
  money: <Money />, progress: <Progress />, comms: <Comms />, reports: <Reports />, admin: <Admin />, security: <Security />,
};

export function App() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="boot" role="status" aria-label={t.shell.loading}><Logo size={34} /><span className="spinner" aria-hidden="true" /></div>;
  // When the club requires two-step sign-in and it is not set up yet, the Security screen is the only one there is.
  const mustSetUp = user?.mfaEnrollmentRequired === true;
  const allowed = (user ? menuFor(user.role, user.title) : []).filter((n) => !mustSetUp || n.key === 'security');
  return (
    <Routes>
      <Route path={PATH.LOGIN} element={<Login />} />
      <Route element={user ? <Shell /> : <Navigate to={PATH.LOGIN} replace />}>
        {allowed.map((n) => <Route key={n.key} path={n.path} element={PAGES[n.key]} />)}
      </Route>
      {/* Anything else: signed-out people go to the login page. Signed-in people go to the dashboard (a screen their role cannot open). */}
      <Route path="*" element={<Navigate to={user ? (mustSetUp ? PATH.SECURITY : PATH.DASHBOARD) : PATH.LOGIN} replace />} />
    </Routes>
  );
}
