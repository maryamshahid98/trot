import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { NAV, PATH } from '../constants';
import { t } from '../i18n';
import { Icon } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { toggleTheme } from '../ui/theme';

const SUN = 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5';

export function Shell() {
  const { user, branches, branchId, setBranchId, signOut } = useAuth();
  const items = NAV.filter((n) => user && (n.roles as readonly string[]).includes(user.role));
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><Logo size={26} /></div>
        <nav className="rail">
          {items.map((n) => (
            <NavLink key={n.key} to={n.path} end={n.path === PATH.DASHBOARD} className={({ isActive }) => `nav${isActive ? ' active' : ''}`}>
              <Icon d={n.icon} />
              {t.nav[n.key]}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <div className="top">
          <div className="search"><Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />{t.shell.search}</div>
          {branches.length > 1 ? (
            <select className="chip" aria-label={t.shell.branch} value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : (
            <span className="chip">{branches[0]?.name ?? ''}</span>
          )}
          <button className="chip round" aria-label={t.shell.theme} onClick={toggleTheme}><Icon d={SUN} size={20} /></button>
          <button className="chip" onClick={() => void signOut()}>{t.shell.signOut}</button>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
