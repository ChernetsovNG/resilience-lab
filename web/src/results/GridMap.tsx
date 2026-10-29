import { useState } from "react";
import { CartesianGrid, ErrorBar, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RunSummary } from "../api/apiTypes";
import { formatMapValue, gridCells, mapMetric, type MapMetric, type MapValue } from "./map";

interface Props {
  summary: RunSummary;
  activeVariantId: string | null;
  pointId: string;
  onPointChange?: (id: string) => void;
}

const metrics: { id: MapMetric; title: string }[] = [
  { id: "successRate", title: "Success rate" }, { id: "p95LatencyMs", title: "p95 latency" },
  { id: "p99LatencyMs", title: "p99 latency" }, { id: "admittedAmplification", title: "Amplification" },
  { id: "handlerUtilization", title: "Handler utilization" },
];
const label = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

/** A view of the saved summary; selecting a cell only changes the shared results context. */
export function GridMap({ summary, activeVariantId, pointId, onPointChange }: Props) {
  const [metric, setMetric] = useState<MapMetric>("successRate");
  const [chosenService, setService] = useState("");
  const variant = summary.variants.find((candidate) => candidate.id === activeVariantId);
  if (variant === undefined) return <p className="results-empty">Select a variant page to view Map.</p>;
  const grid = summary.grid;
  const services = [...new Set(variant.points.flatMap((point) => Object.keys(point.aggregate.services)))].sort();
  const service = services.includes(chosenService) ? chosenService : services[0] ?? "";
  const serviceMetric = metric === "admittedAmplification" || metric === "handlerUtilization";
  const cells = gridCells(grid, variant.points).map((cell) => ({
    ...cell, value: cell.point === null ? null : mapMetric(cell.point.aggregate, metric, service),
  }));
  const values = cells.flatMap((cell) => cell.value === null ? [] : [cell.value.mean]);
  const low = values.length === 0 ? 0 : values.reduce((min, value) => Math.min(min, value));
  const high = values.length === 0 ? 0 : values.reduce((max, value) => Math.max(max, value));
  const format = (value: number) => formatMapValue(value, metric);
  const readout = (value: MapValue | null) => value === null ? "n/a" : format(value.mean) +
    (value.ci95Low == null || value.ci95High == null ? "" : ` (95% CI ${format(value.ci95Low)}–${format(value.ci95High)})`);
  const color = (value: MapValue | null) => value === null ? "#f1f5f9" :
    `hsl(213 90% ${96 - 28 * (high === low ? 0.5 : (value.mean - low) / (high - low))}%)`;
  const pointButton = (cell: typeof cells[number]) => <button type="button" aria-pressed={pointId === cell.id}
    disabled={cell.point === null} title={readout(cell.value)} onClick={() => onPointChange?.(cell.id)}
    style={grid.length === 2 ? { background: color(cell.value) } : undefined}>
    <strong>{cell.id}</strong><span>{grid.length === 2 ? cell.value === null ? "n/a" : format(cell.value.mean) : readout(cell.value)}</span>
  </button>;
  const chartData = cells.map((cell, index) => ({ index, mean: cell.value?.mean ?? null,
    interval: cell.value?.ci95Low == null || cell.value.ci95High == null ? undefined :
      [cell.value.mean - cell.value.ci95Low, cell.value.ci95High - cell.value.mean],
  }));

  return <section className="parameter-map" aria-label={`Map · ${variant.label ?? variant.id}`}>
    <div className="map-toolbar">
      <label>Map metric <select value={metric} onChange={(event) => setMetric(event.target.value as MapMetric)}>
        {metrics.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
      </select></label>
      {serviceMetric ? <label>Map service <select value={service} disabled={services.length === 0} onChange={(event) => setService(event.target.value)}>
        {services.map((id) => <option key={id} value={id}>{id}</option>)}
      </select></label> : null}
      <span>Variant: {variant.label ?? variant.id} · Selected point: {pointId}</span>
    </div>
    <p className="map-note">{metric === "handlerUtilization" ? "Handler utilization: pooled busy/capacity; the summary has no replication CI for this ratio."
      : "Means across replications; 95% CI where available in the summary. Missing values: n/a."}</p>
    {grid.length === 2 ? <>
      <div className="map-legend" aria-label="Map color scale">
        {values.length === 0 ? "No values for this metric." : <>{format(low)}<span aria-hidden="true" />{format(high)}</>}
      </div>
      <table className="map-heatmap" aria-label="Parameter heatmap">
        <caption>Rows: {grid[0].path} · Columns: {grid[1].path}</caption>
        <thead><tr><th scope="col">{grid[0].path} / {grid[1].path}</th>
          {grid[1].values.map((value, index) => <th scope="col" key={index}>{label(value)}</th>)}
        </tr></thead>
        <tbody>{grid[0].values.map((value, row) => <tr key={row}>
          <th scope="row">{label(value)}</th>
          {cells.slice(row * grid[1].values.length, (row + 1) * grid[1].values.length).map((cell) =>
            <td key={cell.id}>{pointButton(cell)}</td>)}
        </tr>)}</tbody>
      </table>
    </> : grid.length === 1 ? <>
      <div role="img" aria-label="Parameter line with 95% confidence intervals">
        <ResponsiveContainer width="100%" height={240} minWidth={0} initialDimension={{ width: 600, height: 240 }}>
          <LineChart data={chartData} margin={{ top: 16, right: 24, bottom: 12, left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="index" type="category" tickFormatter={(index: number) => label(grid[0].values[index]) ?? ""} />
            <YAxis domain={["auto", "auto"]} tickFormatter={format} width={84} />
            <Tooltip labelFormatter={(index) => `${grid[0].path} = ${label(grid[0].values[Number(index)])}`}
              formatter={(value) => typeof value === "number" ? format(value) : "n/a"} />
            <Line type="linear" dataKey="mean" name={metrics.find((candidate) => candidate.id === metric)?.title}
              stroke="#2563eb" connectNulls={false} isAnimationActive={false} activeDot={false}
              dot={({ cx, cy, index }) => {
                const cell = cells[index ?? -1];
                return cell === undefined || cx == null || cy == null ? <g /> : <circle key={cell.id} cx={cx} cy={cy}
                  r={cell.id === pointId ? 7 : 4} fill={cell.id === pointId ? "#172554" : "#2563eb"}
                  role="button" tabIndex={0} aria-label={`Select ${cell.id}`} aria-pressed={cell.id === pointId}
                  onClick={() => onPointChange?.(cell.id)} onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPointChange?.(cell.id); }
                  }}><title>{cell.id} · {readout(cell.value)}</title></circle>;
              }}>
              <ErrorBar dataKey="interval" stroke="#475569" width={5} isAnimationActive={false} />
            </Line>
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="map-axis">{grid[0].path} (document order)</p>
      <ul className="map-points" aria-label="Map points">{cells.map((cell) => <li key={cell.id}>
        <span>{label(grid[0].values[cell.column])}</span>{pointButton(cell)}
      </li>)}</ul>
    </> : null}
  </section>;
}
