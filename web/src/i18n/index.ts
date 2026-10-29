import en from "./en.json" with { type: "json" };

/** Web language only; it is never stored in workspace documents or result artifacts. */
export const language = "en";
export const messages: Readonly<Record<string, string>> = en;

/** Resolve one catalog message and substitute named parameters; missing text is a programming error in dev/tests, with safe production fallbacks. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = messages[key];
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
