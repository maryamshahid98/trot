import { useAuth } from '../auth/AuthContext';
import { t } from '../i18n';
import type { NavKey } from '../constants';

export function Placeholder({ page }: { page: NavKey }) {
  const { user } = useAuth();
  return (
    <>
      <div className="head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h1 className="title">{t.nav[page]}</h1>
          <span className="sub">{user ? `${t.page.signedInAs} ${user.fullName ?? ''} · ${t.roles[user.role]}` : ''}</span>
        </div>
      </div>
      <div className="card">{t.page.comingSoon}</div>
    </>
  );
}
