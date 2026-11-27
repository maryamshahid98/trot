import { LOCALE, STORAGE } from '../constants';
import { ar } from './ar';
import { AR_PHRASES } from './ar-phrases';
import { en } from './en';
import type { Messages } from './en';

export const MESSAGES: Record<string, Messages> = { en, ar };

const stored = (() => { try { return localStorage.getItem(STORAGE.LOCALE); } catch { return null; } })();
export const locale: string = stored === LOCALE.AR ? LOCALE.AR : LOCALE.EN;
export const t: Messages = MESSAGES[locale];

/** A fixed phrase in the chosen language; a phrase with no translation stays as written. */
export const tr = (phrase: string): string => {
  if (locale !== LOCALE.AR) return phrase;
  // Required fields carry a trailing mark.
  const required = phrase.endsWith(' *');
  const core = required ? phrase.slice(0, -2) : phrase;
  return (AR_PHRASES[core] ?? core) + (required ? ' *' : '');
};

/** Sets the page's language and reading direction. Called once when the app starts. */
export function applyLocale() {
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === LOCALE.AR ? 'rtl' : 'ltr';
}

/** Switching reloads the page, so every screen is drawn in the new language. */
export function switchLocale() {
  localStorage.setItem(STORAGE.LOCALE, locale === LOCALE.AR ? LOCALE.EN : LOCALE.AR);
  window.location.reload();
}
