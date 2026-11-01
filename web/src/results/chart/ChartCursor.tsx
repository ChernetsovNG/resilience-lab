import { useMemo, type ReactNode } from "react";
import { ChartCursorContext, type ChartCursorState } from "./useChartCursor";

/** Controlled bridge to results.selection.window; no second pinned selection lives in Chart. */
export function ChartCursorProvider({ children, ...state }: ChartCursorState & { children: ReactNode }) {
  const { axisId, hoverWindow, cursorWindow, onHover, onCursor } = state;
  const value = useMemo(() => ({ axisId, hoverWindow, cursorWindow, onHover,
    onCursor: (window: number | null) => { onHover(null); onCursor(window); },
  }), [axisId, hoverWindow, cursorWindow, onHover, onCursor]);
  return <ChartCursorContext.Provider value={value}>{children}</ChartCursorContext.Provider>;
}
