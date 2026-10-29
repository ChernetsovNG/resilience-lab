import en from "./en.json" with { type: "json" };

/** Web language only; it is never stored in workspace documents or result artifacts. */
export const language = "en";
export const messages: Readonly<Record<string, string>> = en;

/** Resolve one catalog message and substitute named parameters; missing text is a programming error. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = messages[key];
  if (typeof template !== "string") throw new Error(`Unknown message key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing message parameter ${name} for ${key}`);
    return String(params[name]);
  });
}
