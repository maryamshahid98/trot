import { t } from '../i18n';

/** The Trot mark: four rounded squares in a diagonal pattern, like the two-beat diagonal gait of a trot. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="9" fill="#FF6B4A" />
      <rect x="34" y="2" width="28" height="28" rx="9" fill="var(--ink)" />
      <rect x="2" y="34" width="28" height="28" rx="9" fill="var(--ink)" />
      <rect x="34" y="34" width="28" height="28" rx="9" fill="#FF6B4A" />
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo" style={{ fontSize: Math.round(size * 0.8) }}>
      <LogoMark size={size} />
      <span className="logo-word">{t.appName.toLowerCase()}<span style={{ color: 'var(--accent)' }}>.</span></span>
    </span>
  );
}
