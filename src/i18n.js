// Tiny i18n layer. Translations live in i18n/<code>.json; i18n/languages.json lists the available codes.
// English is always loaded first and used for any key missing from the selected language.
const BASE = new URL('../i18n/', import.meta.url);
const FALLBACK = 'en';
const STORAGE_KEY = 'another-world-lang';

let fallback = {};
let dict = {};
let current = FALLBACK;
export let languages = { [FALLBACK]: 'English' };

async function loadJson(name) {
  const r = await fetch(new URL(name, BASE));
  if (!r.ok) throw new Error(name);
  return r.json();
}

/** Pick the saved language, else the first browser language we have (full tag, then base tag), else English. */
function detect() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const wanted = [saved, ...(navigator.languages || [navigator.language])].filter(Boolean);
  for (const tag of wanted) {
    const lower = tag.toLowerCase();
    for (const cand of [lower, lower.split('-')[0]]) if (languages[cand]) return cand;
  }
  return FALLBACK;
}

export async function initI18n() {
  try { languages = await loadJson('languages.json'); } catch { /* keep English only */ }
  try { fallback = await loadJson(FALLBACK + '.json'); } catch { fallback = {}; }
  await setLanguage(detect(), false);
}

export async function setLanguage(code, remember = true) {
  current = languages[code] ? code : FALLBACK;
  try { dict = current === FALLBACK ? {} : await loadJson(current + '.json'); } catch { dict = {}; current = FALLBACK; }
  if (remember) localStorage.setItem(STORAGE_KEY, current);
  document.documentElement.lang = current;
  applyTranslations();
}

export const getLanguage = () => current;

/** Translate `key`, replacing `{name}` placeholders with params. Unknown keys fall back to English, then to the key. */
export function t(key, params = {}) {
  const text = dict[key] ?? fallback[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? params[name] : m));
}

/** Fill every element marked with data-i18n (text), data-i18n-html (trusted markup) or data-i18n-aria (aria-label). */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  document.dispatchEvent(new CustomEvent('languagechange'));
}
