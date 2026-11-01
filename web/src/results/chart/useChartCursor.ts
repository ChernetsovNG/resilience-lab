import { createContext, useContext } from "react";

export interface ChartCursorState {
  axisId: string;
  hoverWindow: number | null;
  cursorWindow: number | null;
  onHover: (window: number | null) => void;
  onCursor: (window: number | null) => void;
}

export const ChartCursorContext = createContext<ChartCursorState | null>(null);

/** Axis identity prevents unrelated runs and parameter axes from sharing time inspection. */
export function useChartCursor(axisId: string) {
  const cursor = useContext(ChartCursorContext);
  return cursor?.axisId === axisId ? cursor : null;
}
