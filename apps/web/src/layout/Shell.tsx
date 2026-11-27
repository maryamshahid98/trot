import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { menuFor, PATH } from '../constants';
import { t } from '../i18n';
import { Icon } from '../ui/Icon';
import { LanguageButton } from '../ui/LanguageButton';
import { Logo } from '../ui/Logo';
import { toggleTheme } from '../ui/theme';

const SUN = 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5';
const SEARCH = 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4';
const MENU = 'M4 7h16M4 12h16M4 17h16';

export function Shell() {
  const { user, branches, branchId, setBranchId, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const items = (user ? menuFor(user.role, user.title) : []).filter((n) => !user?.mfaEnrollmentRequired || n.key === 'security');
  // The search looks riders up, so only people who can open the People screen get it.
  const canSearch = items.some((n) => n.key === 'people');
  const [term, setTerm] = useState('');

  // On a narrow screen the menu is a drawer. It remembers which screen it was opened on, so it is closed automatically
  // as soon as the person goes to another screen (a menu choice, the search, or the browser's Back button). Escape closes it too.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const menuOpen = openedOn === location.pathname;
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenedOn(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = term.trim();
    if (q) navigate(`${PATH.PEOPLE}?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="shell">
      <a className="skip" href="#content">{t.shell.skip}</a>
      <aside id="menu" className={`side${menuOpen ? ' open' : ''}`} aria-label={t.shell.menu}>
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
      {menuOpen && <div className="backdrop" onClick={() => setOpenedOn(null)} aria-hidden="true" />}
      <div className="main">
        <div className="top">
          <button className="chip round menu-btn" aria-label={t.shell.menu} aria-expanded={menuOpen} aria-controls="menu" onClick={() => setOpenedOn(menuOpen ? null : location.pathname)}>
            <Icon d={MENU} size={20} />
          </button>
          <span className="mobile-logo"><Logo size={22} /></span>
          {canSearch && (
            <form className="search" role="search" onSubmit={search}>
              <Icon d={SEARCH} />
              <input aria-label={t.shell.searchLabel} placeholder={t.shell.search} value={term} onChange={(e) => setTerm(e.target.value)} />
            </form>
          )}
          {branches.length > 1 ? (
            <select className="chip" aria-label={t.shell.branch} value={branchId ?? ''} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          ) : (
            branches[0] && <span className="chip">{branches[0].name}</span>
          )}
          <button className="chip round" aria-label={t.shell.theme} onClick={toggleTheme}><Icon d={SUN} size={20} /></button>
          <LanguageButton />
          <button className="chip" onClick={() => void signOut()}>{t.shell.signOut}</button>
        </div>
        <main id="content" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
