import en from "./en.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };

export type Language = "en" | "ru";
export const catalogs: Readonly<Record<Language, Readonly<Record<string, string>>>> = { en, ru };
const preferenceKey = "resilience-lab.language";
const listeners = new Set<() => void>();

/** An explicit supported preference wins; otherwise use the first supported browser language. */
export function chooseLanguage(languages: readonly string[], saved: string | null): Language {
  if (saved === "en" || saved === "ru") return saved;
  for (const locale of languages) {
    const base = locale.split("-")[0].toLowerCase();
    if (base === "en" || base === "ru") return base;
  }
  return "en";
}

function savedLanguage(): string | null {
  try { return localStorage.getItem(preferenceKey); } catch { return null; }
}

/** Web language only; it is never stored in workspace documents or result artifacts. */
export let language: Language = chooseLanguage(typeof navigator === "undefined" ? [] : navigator.languages, savedLanguage());
export let messages: Readonly<Record<string, string>> = catalogs[language];

/** Subscribe without remounting the editor, so drafts, selection and undo history survive switching. */
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const currentLanguage = (): Language => language;

function updateDocumentLanguage(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.title = t("app.name");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("app.description"));
}

/** Preference persistence is best effort; switching still works with browser storage disabled. */
export function setLanguage(next: Language): void {
  language = next;
  messages = catalogs[next];
  try { localStorage.setItem(preferenceKey, next); } catch { /* This session still uses the selected language. */ }
  updateDocumentLanguage();
  for (const listener of listeners) listener();
}

/** Resolve one catalog message and substitute named parameters; missing text is a programming error in dev/tests, with safe production fallbacks. */
export function t(key: string, params: Record<string, string | number> = {}, locale: Language = language): string {
  const template = catalogs[locale][key];
  const strict = import.meta.env?.DEV !== false || import.meta.env?.MODE === "test";
  if (typeof template !== "string") {
    if (strict) throw new Error(`Unknown message key: ${key}`);
    return key.replace(/^(?:app\.job\.status|results\.jobStatus)\./, "");
  }
  const missing = [...template.matchAll(/\{(\w+)\}/g)].find(([, name]) => !Object.hasOwn(params, name));
  if (missing !== undefined) {
    if (strict) throw new Error(`Missing message parameter ${missing[1]} for ${key}`);
    return key;
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));
}

updateDocumentLanguage();
