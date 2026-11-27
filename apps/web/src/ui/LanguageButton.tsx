import { LOCALE } from '../constants';
import { locale, switchLocale, t } from '../i18n';

/** Shows the other language's own name, so someone who cannot read the current one can still find it. */
export const LanguageButton = () => (
  <button type="button" className="chip" aria-label={t.shell.language} lang={locale === LOCALE.AR ? 'en' : 'ar'} onClick={switchLocale}>{locale === LOCALE.AR ? 'English' : 'العربية'}</button>
);
