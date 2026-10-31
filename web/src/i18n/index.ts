export type Language = "en" | "ru";
type Messages = Readonly<Record<string, string>>;
export const catalogs: Partial<Record<Language, Messages>> = {};
const loading: Partial<Record<Language, Promise<Messages>>> = {};
const preferenceKey = "resilience-lab.language";
const listeners = new Set<() => void>();

function loadCatalog(locale: Language): Promise<Messages> {
  // Native Node needs JSON attributes; Vite serves these imports as JavaScript modules.
  const options = typeof window === "undefined" ? { with: { type: "json" } } : undefined;
  return loading[locale] ??= (locale === "en"
    ? import("./en.json", options)
    : import("./ru.json", options))
    .then(module => catalogs[locale] = module.default)
    .catch(error => { delete loading[locale]; throw error; });
}

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
export let messages: Messages = {};
let requestedLanguage = language;

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

/** Load the chosen startup catalog before rendering, without saving an implicit browser preference. */
export async function initializeLanguage(): Promise<void> {
  messages = await loadCatalog(language);
  updateDocumentLanguage();
}

/** Switches retain the current messages until loading succeeds.
 * Preference persistence is best effort; switching still works with browser storage disabled.
 */
export async function setLanguage(next: Language): Promise<void> {
  requestedLanguage = next;
  const nextMessages = catalogs[next] ?? await loadCatalog(next);
  if (requestedLanguage !== next || (language === next && messages === nextMessages)) return;
  language = next;
  messages = nextMessages;
  try { localStorage.setItem(preferenceKey, next); } catch { /* This session still uses the selected language. */ }
  updateDocumentLanguage();
  for (const listener of listeners) listener();
}

/** Resolve one catalog message and substitute named parameters; missing text is a programming error in dev/tests, with safe production fallbacks. */
export function t(key: string, params: Record<string, string | number> = {}, locale: Language = language): string {
  const template = catalogs[locale]?.[key];
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
