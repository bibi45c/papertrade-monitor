import { english } from './translations.mjs';

export const LANGUAGE_KEY = 'papertrade:language';
export function savedLanguage(storage) {
  try { return storage?.getItem(LANGUAGE_KEY) === 'zh' ? 'zh' : 'en'; }
  catch { return 'en'; }
}
function initialLanguage() {
  try {
    const query = typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('lang');
    if (query === 'en' || query === 'zh') return query;
    return savedLanguage(typeof localStorage === 'undefined' ? null : localStorage);
  } catch { return 'en'; }
}
export const language = initialLanguage();
const pattern = new RegExp(Object.keys(english).sort((a, b) => b.length - a.length)
  .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
export function translateMessage(value, locale = language) {
  if (typeof value !== 'string' || locale === 'zh') return value;
  return value.replace(pattern, key => english[key]);
}
export function initializeLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = translateMessage(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', translateMessage(node.dataset.i18nAriaLabel));
  const description = document.querySelector('meta[name="description"]');
  description.content = translateMessage(description.dataset.i18nContent);
  const button = document.getElementById('languageToggle');
  button.textContent = language === 'en' ? '中文' : 'English';
  button.lang = language === 'en' ? 'zh-CN' : 'en';
  button.setAttribute('aria-label', language === 'en' ? 'Switch to Chinese' : '切换为英文');
  button.addEventListener('click', () => {
    const next = language === 'en' ? 'zh' : 'en';
    try { localStorage.setItem(LANGUAGE_KEY, next); }
    catch { /* URL fallback keeps switching usable when local storage is blocked. */ }
    const url = new URL(location.href); url.searchParams.set('lang', next); location.assign(url.href);
  });
}
