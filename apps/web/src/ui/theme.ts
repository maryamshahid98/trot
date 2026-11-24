import { STORAGE, THEME } from '../constants';
import type { Theme } from '../constants';

export const readTheme = (): Theme => {
  const v = localStorage.getItem(STORAGE.THEME);
  return v === THEME.LIGHT || v === THEME.DARK ? v : THEME.SYSTEM;
};
/** Sets data-theme on the page. "system" follows the computer. */
export function applyTheme(theme: Theme): void {
  const dark = theme === THEME.DARK || (theme === THEME.SYSTEM && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? THEME.DARK : THEME.LIGHT;
}
/** Flips between light and dark and remembers the choice. */
export function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === THEME.DARK ? THEME.LIGHT : THEME.DARK;
  localStorage.setItem(STORAGE.THEME, next);
  applyTheme(next);
}
