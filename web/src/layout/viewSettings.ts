import { useSyncExternalStore } from "react";

export const GRID_STEPS = [10, 20, 40] as const;
export const TEXT_SCALES = [90, 100, 110, 125] as const;

/** Browser view preferences; documents and editor history never contain them. */
export interface ViewSettings {
  readonly gridStep: typeof GRID_STEPS[number];
  readonly snapToGrid: boolean;
  readonly showGrid: boolean;
  readonly textScale: typeof TEXT_SCALES[number];
}

const preferenceKey = "resilience-lab.viewSettings";
const defaults: ViewSettings = { gridStep: 20, snapToGrid: true, showGrid: true, textScale: 100 };
const listeners = new Set<() => void>();

function savedSettings(): ViewSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null") as Partial<ViewSettings> | null;
    return {
      gridStep: GRID_STEPS.find(step => step === saved?.gridStep) ?? defaults.gridStep,
      snapToGrid: typeof saved?.snapToGrid === "boolean" ? saved.snapToGrid : defaults.snapToGrid,
      showGrid: typeof saved?.showGrid === "boolean" ? saved.showGrid : defaults.showGrid,
      textScale: TEXT_SCALES.find(scale => scale === saved?.textScale) ?? defaults.textScale,
    };
  } catch { return defaults; }
}

let settings = savedSettings();
export const currentViewSettings = (): ViewSettings => settings;

function applyTextScale(): void {
  if (typeof document !== "undefined") document.documentElement.style.fontSize = `${settings.textScale}%`;
}

/** Apply immediately; unavailable storage still permits changes for the current session. */
export function setViewSettings(patch: Partial<ViewSettings>): void {
  settings = { ...settings, ...patch };
  applyTextScale();
  try { localStorage.setItem(preferenceKey, JSON.stringify(settings)); } catch { /* This session still uses the selected settings. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Update the menu and canvas together without remounting the editor. */
export function useViewSettings(): ViewSettings {
  return useSyncExternalStore(subscribe, currentViewSettings);
}

applyTextScale();
