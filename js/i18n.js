// Lightweight i18n system (no dependencies, no page reload).
//
// - English (en) ships in the bundle and is the fallback for every key, so
//   missing translations degrade to English, never to raw keys or blanks.
// - Other locales live in js/locales/<code>.js and are loaded on demand
//   (dynamic import). Adding a language = adding one file + one LANGS row;
//   no application code changes.
// - Static DOM text binds via data-i18n / data-i18n-title /
//   data-i18n-placeholder attributes; applyI18n() (re)applies the active
//   dictionary. Dynamic strings use t(key, params); count-dependent strings
//   use tn(key, n, params), which picks "<key>.<plural category>" via
//   Intl.PluralRules and falls back to "<key>.other".
// - Numbers format through Intl.NumberFormat for the active locale via num().
//
// Language codes follow the game's language set (zhs/zht for Simplified /
// Traditional Chinese); bcp47 supplies the tag used for Intl, the <html>
// lang attribute, and font selection in CSS.

import en from './locales/en.js';

export const LANGS = [
  { code: 'en', name: 'English', bcp47: 'en' },
  { code: 'zhs', name: '简体中文', bcp47: 'zh-Hans' },
  { code: 'zht', name: '繁體中文', bcp47: 'zh-Hant' },
  { code: 'ja', name: '日本語', bcp47: 'ja' },
  { code: 'ko', name: '한국어', bcp47: 'ko' },
  { code: 'fr', name: 'Français', bcp47: 'fr' },
  { code: 'de', name: 'Deutsch', bcp47: 'de' },
  { code: 'es', name: 'Español', bcp47: 'es' },
  { code: 'pt', name: 'Português', bcp47: 'pt' },
  { code: 'ru', name: 'Русский', bcp47: 'ru' },
  { code: 'th', name: 'ไทย', bcp47: 'th' },
  { code: 'vi', name: 'Tiếng Việt', bcp47: 'vi' },
  { code: 'id', name: 'Bahasa Indonesia', bcp47: 'id' },
  { code: 'tr', name: 'Türkçe', bcp47: 'tr' },
  { code: 'it', name: 'Italiano', bcp47: 'it' },
];

// Language preference is shared across all Miliastra Toolkit sites (same
// origin ⇒ same localStorage) via the canonical key below; our internal
// codes are already the toolkit's canonical set, so no mapping is needed.
// See docs/language-sync.md. LEGACY_KEY is this site's pre-integration key,
// migrated once on read and never written again.
const SHARED_KEY = 'miliastra-lang';
const LEGACY_KEY = 'gia-splitter-lang';
const dicts = { en };
let current = 'en';
let dict = en;
const listeners = new Set();

export function currentLang() {
  return current;
}

function bcp47Of(code) {
  return LANGS.find((l) => l.code === code)?.bcp47 ?? 'en';
}

function interpolate(s, params) {
  if (!params) return s;
  for (const [k, v] of Object.entries(params)) {
    s = s.split('{' + k + '}').join(String(v));
  }
  return s;
}

// t("key", { n: 5 }) interpolates {n}; falls back key-by-key to English.
export function t(key, params) {
  return interpolate(dict[key] ?? en[key] ?? key, params);
}

// tn("key", 5, params) is the plural-aware t(): resolves "key.<category>" for the
// active locale's plural rules, falling back to "key.other", then English.
// {n} is pre-formatted with the locale's number format.
let pr = new Intl.PluralRules('en');
export function tn(key, n, params) {
  const cat = pr.select(n);
  const s = dict[`${key}.${cat}`] ?? dict[`${key}.other`]
    ?? en[`${key}.${cat}`] ?? en[`${key}.other`] ?? key;
  return interpolate(s, { n: num(n), ...params });
}

// locale-aware number formatting
let nf = new Intl.NumberFormat('en');
export function num(v, opts) {
  if (v == null || v === '') return '';
  if (typeof v !== 'number') return String(v);
  return opts ? new Intl.NumberFormat(bcp47Of(current), opts).format(v) : nf.format(v);
}

// Optional key-variant suffix (e.g. 'gil' when a .gil file is loaded):
// elements carrying data-i18n-<variant> use that key instead of data-i18n,
// so mode-dependent labels stay in the markup with no duplicated elements.
let variant = null;
export function setI18nVariant(v) {
  if (variant === v) return;
  variant = v;
  applyI18n(document);
}

// Apply the active dictionary to every bound element under root.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = (variant && el.getAttribute(`data-i18n-${variant}`)) || el.dataset.i18n;
    el.textContent = t(key);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  // the drag-overlay label lives in CSS (content: attr(...))
  document.body.dataset.dropLabel = t('drop.overlay');
}

// Subscribe to language changes (for re-rendering dynamic UI).
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Apply a language without persisting it (load-time detection, cross-tab
// sync). Only setLanguage(), an explicit user choice, writes storage.
async function applyLanguage(code) {
  if (!LANGS.some((l) => l.code === code)) code = 'en';
  if (!dicts[code]) {
    try {
      dicts[code] = (await import(`./locales/${code}.js`)).default;
    } catch (e) {
      console.warn('i18n: failed to load locale', code, e);
      dicts[code] = {};
    }
  }
  current = code;
  dict = dicts[code];
  nf = new Intl.NumberFormat(bcp47Of(code));
  pr = new Intl.PluralRules(bcp47Of(code));
  document.documentElement.lang = bcp47Of(code);
  applyI18n(document);
  for (const fn of listeners) fn(code);
}

export async function setLanguage(code) {
  if (!LANGS.some((l) => l.code === code)) code = 'en';
  try {
    localStorage.setItem(SHARED_KEY, code);
  } catch {}
  return applyLanguage(code);
}

// Pick the saved language, or the closest match to the browser language.
// Invalid stored values are ignored (not deleted), since another toolkit site
// may understand them.
export function detectLanguage() {
  try {
    const saved = localStorage.getItem(SHARED_KEY);
    if (saved && LANGS.some((l) => l.code === saved)) return saved;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && LANGS.some((l) => l.code === legacy)) {
      localStorage.setItem(SHARED_KEY, legacy);
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch {}
  const cands = navigator.languages || [navigator.language || 'en'];
  for (const cand of cands) {
    const nav = String(cand).toLowerCase();
    if (nav.startsWith('zh')) {
      return /tw|hk|mo|hant/.test(nav) ? 'zht' : 'zhs';
    }
    const two = nav.slice(0, 2);
    if (LANGS.some((l) => l.code === two)) return two;
  }
  return 'en';
}

// Initialize: apply saved/detected language (async for non-English), and
// follow language changes made on other toolkit sites in other tabs.
// Neither path writes back to localStorage.
export function initI18n() {
  window.addEventListener('storage', (e) => {
    if (
      e.key === SHARED_KEY && e.newValue && e.newValue !== current
      && LANGS.some((l) => l.code === e.newValue)
    ) {
      applyLanguage(e.newValue);
    }
  });
  const lang = detectLanguage();
  if (lang === 'en') {
    document.documentElement.lang = 'en';
    applyI18n(document);
    return Promise.resolve();
  }
  return applyLanguage(lang);
}
