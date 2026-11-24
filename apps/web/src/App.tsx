import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { NAV, PATH } from './constants';
import { Shell } from './layout/Shell';
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
import { Staff } from './pages/Staff';

const PAGES: Record<string, ReactElement> = {
  dashboard: <Dashboard />, calendar: <Calendar />, bookings: <Bookings />, people: <People />, horses: <Horses />, staff: <Staff />,
  money: <Money />, progress: <Progress />, comms: <Comms />, reports: <Reports />, admin: <Admin />,
};

export function App() {
  const { user, ready } = useAuth();
  if (!ready) return <div className="login">{t.shell.loading}</div>;
  const allowed = NAV.filter((n) => user && (n.roles as readonly string[]).includes(user.role));
  return (
    <Routes>
      <Route path={PATH.LOGIN} element={<Login />} />
      <Route element={user ? <Shell /> : <Navigate to={PATH.LOGIN} replace />}>
        {allowed.map((n) => <Route key={n.key} path={n.path} element={PAGES[n.key]} />)}
      </Route>
      {/* Anything else: signed-out people go to the login page. Signed-in people go to the dashboard (a screen their role cannot open). */}
      <Route path="*" element={<Navigate to={user ? PATH.DASHBOARD : PATH.LOGIN} replace />} />
    </Routes>
  );
}
