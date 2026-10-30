import { useState, type ReactNode } from "react";

const unsaved = new Map<string, boolean>();

/** Disclosure preferences belong to the browser; collapsed fields stay mounted, retaining their drafts. */
export function InspectorSection({ name, title, defaultOpen = true, children }: {
  name: "parameters" | "execution" | "faults" | "grid";
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `resilience-lab.inspector-${name}-open`;
  const [preference, setPreference] = useState<boolean | null>(() => {
    if (unsaved.has(key)) return unsaved.get(key)!;
    try {
      const stored = localStorage.getItem(key);
      return stored === "true" ? true : stored === "false" ? false : null;
    } catch { return null; }
  });
  const open = preference ?? defaultOpen;
  const remember = (next: boolean) => {
    setPreference(next);
    try {
      localStorage.setItem(key, String(next));
      unsaved.delete(key);
    } catch { unsaved.set(key, next); }
  };
  return <details className={`inspector-section inspector-${name}`} data-inspector-field={name} open={open} onToggle={event => {
    const next = event.currentTarget.open;
    // React also emits toggle for initial and context-driven defaults; those are not user preferences.
    if (next !== open) remember(next);
  }}>
    <summary onClick={event => {
      // Persist before navigation/reload can interrupt the native asynchronous toggle event.
      event.preventDefault();
      remember(!open);
    }}>{title}</summary>
    {children}
  </details>;
}
