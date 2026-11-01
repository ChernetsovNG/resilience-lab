/** Chart descriptions contain data only; cursor changes belong to the surrounding results selection. */
export interface ChartPoint { x: number; endX?: number; window: number; value: number | null }
export interface ChartRangePoint { x: number; endX?: number; window: number; range: readonly [number, number] | null }

interface NumericAxis { id: string; label: string; domain: readonly [number, number] }
export type ChartXAxis = NumericAxis & (
  { kind: "time"; windowMs: number }
  | { kind: "parameter"; path: string }
  | { kind: "output"; elementId: string; outputId: string }
);
export type ChartYScale = { scale: "zero" | "data" } | { scale: "manual"; min: number; max: number };
export type ChartColorBy = "variant" | "element" | "metric";
export type ChartDash = "solid" | "dashed" | "dotted";

export interface ChartSeries {
  id: string;
  label: string;
  elementId?: string;
  outputId?: string;
  variantIndex?: number;
  variantId?: string;
  replication?: number | "all";
  points: readonly ChartPoint[];
  range?: readonly ChartRangePoint[];
  color?: string;
  dash?: ChartDash;
  width?: number;
  marker?: "circle" | "square";
}

export type ChartOverlay =
  | { kind: "region"; id: string; role: "warmup" | "fault"; from: number; to: number; label: string }
  | { kind: "threshold"; id: string; value: number; label: string; dash?: ChartDash }
  | { kind: "marker"; id: string; x: number; value: number; label: string; color?: string }
  | { kind: "state"; id: string; label: string; color: string;
      points: readonly (ChartPoint & { endX: number; description: string })[] };

export interface ChartDescription {
  title: string;
  unit: string;
  x: ChartXAxis;
  series: readonly ChartSeries[];
  colorBy?: ChartColorBy;
  overlays?: readonly ChartOverlay[];
  y?: ChartYScale;
  preset?: "full" | "compact";
  note?: string;
}
