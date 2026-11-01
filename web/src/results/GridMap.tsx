import { entryModels, entryPopulations, type EntrySelection } from "./entries";
import { serviceResultRows } from "./groups";
import { t } from "../i18n";
import { formatInterval, formatNumber, formatPercent } from "../i18n/format";
import { useState } from "react";
import { CartesianGrid, ErrorBar, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Catalog, ModelFile, RunSummary } from "../api/apiTypes";
import { formatMapValue, gridCells, mapMetric, type MapMetric, type MapValue } from "./map";
import { confidenceInterval } from "./confidence";
import { useConfidenceLevel } from "../layout/confidenceLevel";
import { parameterLabel, pointCoordinates, pointLabel, variantLabel, type NamedVariant } from "../presentation/labels";
import { ownEntry, type Params } from "../workspace/params";
import { formatParameterValue } from "../workspace/parameterValues";
import { outputNote } from "./outputs";

interface Props {
  summary: RunSummary;
  activeVariantId: string | null;
  pointId: string;
  onPointChange?: (id: string) => void;
  catalog?: Catalog | null;
  model?: ModelFile | null;
  variants?: readonly (NamedVariant & { overrides?: Params })[];
  onElement?: (id: string) => void;
}

const mapMetrics = (): { id: MapMetric; title: string }[] => [
  { id: "successRate", title: t("results.metrics.successRate") }, { id: "p95LatencyMs", title: t("results.metrics.p95LatencyMs") },
  { id: "p99LatencyMs", title: t("results.metrics.p99LatencyMs") }, { id: "admittedAmplification", title: t("results.metrics.amplification") },
  { id: "handlerUtilization", title: t("results.metrics.handlerUtilization") },
];
const label = (value: unknown) => formatParameterValue(value);

/** A view of the saved summary; selecting a cell only changes the shared results context. */
export function GridMap({ summary, activeVariantId, pointId, onPointChange, catalog, model, variants = summary.variants, onElement }: Props) {
  const level = useConfidenceLevel();
  const metrics = mapMetrics();
  const [metric, setMetric] = useState<MapMetric>("successRate");
  const [chosenEntry, setEntry] = useState<EntrySelection>("total");
  const [chosenService, setService] = useState("");
  const variant = summary.variants.find((candidate) => candidate.id === activeVariantId);
  if (variant === undefined) return <p className="results-empty">{t("results.map.selectVariant")}</p>;
  const grid = summary.grid;
  const name = variantLabel(variant, variants);
  const axisLabel = (path: string) => parameterLabel(path, catalog, model);
  const pointName = (id: string) => pointLabel(id, grid, variant.points.find(point => point.id === id)?.coordinates, catalog, model);
  const services = serviceResultRows(variant.points.map(point => point.aggregate));
  const selectedService = services.find(service => service.id === chosenService || service.instances.some(instance => instance.id === chosenService)) ?? services[0];
  const service = selectedService?.instances.some(instance => instance.id === chosenService) ? chosenService : selectedService?.id ?? "";
  const serviceMetric = metric === "admittedAmplification" || metric === "handlerUtilization";
  const populations = entryPopulations(summary.variants.flatMap(variant => variant.points.map(point => point.aggregate)), entryModels(summary, model, catalog, variants));
  const choices = [
    { id: "total", title: t("results.entries.total") },
    ...(populations.clients.length > 1 ? populations.clients.map(id => ({ id: `clients:${id}`, title: t("results.entries.client", { id }) })) : []),
    ...(populations.classes.length > 1 ? populations.classes.map(id => ({ id: `classes:${id}`, title: t("results.entries.requestType", { id }) })) : []),
  ];
  const entry = choices.some(choice => choice.id === chosenEntry) ? chosenEntry : "total";
  const cells = gridCells(grid, variant.points).map((cell) => {
    const value = cell.point === null ? null : mapMetric(cell.point.aggregate, metric, service, entry);
    return { ...cell, value, interval: confidenceInterval(value, level) };
  });
  const values = cells.flatMap((cell) => cell.value === null ? [] : [cell.value.mean]);
  const low = values.length === 0 ? 0 : values.reduce((min, value) => Math.min(min, value));
  const high = values.length === 0 ? 0 : values.reduce((max, value) => Math.max(max, value));
  const format = (value: number) => formatMapValue(value, metric);
  const readout = ({ value, interval }: typeof cells[number]) => value === null ? formatNumber(null) : format(value.mean) +
    (interval === null ? "" : t("results.intervalInParens", { interval: formatInterval(interval[0], interval[1], format, level) }));
  const color = (value: MapValue | null) => value === null ? "#f1f5f9" :
    `hsl(213 90% ${96 - 28 * (high === low ? 0.5 : (value.mean - low) / (high - low))}%)`;
  const pointButton = (cell: typeof cells[number]) => {
    const amplification = cell.point === null ? undefined : ownEntry(cell.point.aggregate.services, service)?.admittedAmplification;
    const note = metric === "admittedAmplification" ? outputNote({ id: "amplification" }, cell.value?.mean,
      amplification === null ? "noArrivals" : "missingData") : null;
    const description = note === null ? readout(cell) : t("results.map.readoutNote", { value: readout(cell), note });
    return <button type="button" aria-pressed={pointId === cell.id}
      aria-label={t("results.map.pointReadout", { point: pointName(cell.id), value: description })}
      disabled={cell.point === null} title={description} onClick={() => onPointChange?.(cell.id)}
      style={grid.length === 2 ? { background: color(cell.value) } : undefined}>
      <strong>{Object.values(pointCoordinates(cell.id, grid)).map(value => formatParameterValue(value)).join(t("editor.symbols.separator"))}</strong>
      <span>{grid.length === 2 ? cell.value === null ? formatNumber(null) : format(cell.value.mean) : readout(cell)}</span>
      {note === null ? null : <small className="output-note">{note}</small>}
    </button>;
  };
  const chartData = cells.map((cell, index) => ({ index, mean: cell.value?.mean ?? null,
    interval: cell.value === null || cell.interval === null ? undefined :
      [cell.value.mean - cell.interval[0], cell.interval[1] - cell.value.mean],
  }));

  return <section className="parameter-map" aria-label={t("results.map.variantLabel", { variant: name })}>
    <div className="map-toolbar">
      <label>{t("results.map.metric")} <select value={metric} onChange={(event) => setMetric(event.target.value as MapMetric)}>
        {metrics.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
      </select></label>
      {!serviceMetric && choices.length > 1 ? <label>{t("results.entries.entry")} <select value={entry}
        onChange={event => setEntry(event.target.value as EntrySelection)}>
        {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.title}</option>)}
      </select></label> : null}
      {serviceMetric ? <label>{t("results.map.service")} <select value={selectedService?.id ?? ""} disabled={services.length === 0} onChange={(event) => setService(event.target.value)}>
        {services.map(({ id }) => <option key={id} value={id}>{id}</option>)}
      </select></label> : null}
      <span>{t("results.map.context", { variant: name, point: pointName(pointId) })}</span>
    </div>
    {!serviceMetric || selectedService === undefined || selectedService.instances.length === 0 ? null : <details className="map-replicas" key={selectedService.id}>
      <summary>{t("results.groups.replicas", { group: selectedService.id })}</summary>
      {[{ id: selectedService.id }, ...selectedService.instances].map(instance => <label key={instance.id}>
        <input type="radio" name="map-replica" checked={service === instance.id} onChange={() => { setService(instance.id); onElement?.(instance.id); }} />
        {instance.id}</label>)}
    </details>}
    <p className="map-note">{metric === "handlerUtilization" ? t("results.map.utilizationNote")
      : t("results.map.meansNote", { level: formatPercent(level / 100) })}</p>
    {grid.length === 2 ? <>
      <div className="map-legend" aria-label={t("results.map.colorScale")}>
        {values.length === 0 ? t("results.map.noValues") : <>{format(low)}<span aria-hidden="true" />{format(high)}</>}
      </div>
      <table className="map-heatmap" aria-label={t("results.map.heatmap")}>
        <caption>{t("results.map.axes", { rows: axisLabel(grid[0].path), columns: axisLabel(grid[1].path) })}</caption>
        <thead><tr><th scope="col">{t("results.map.axisPaths", { rows: axisLabel(grid[0].path), columns: axisLabel(grid[1].path) })}</th>
          {grid[1].values.map((value, index) => <th scope="col" key={index}>{label(value)}</th>)}
        </tr></thead>
        <tbody>{grid[0].values.map((value, row) => <tr key={row}>
          <th scope="row">{label(value)}</th>
          {cells.slice(row * grid[1].values.length, (row + 1) * grid[1].values.length).map((cell) =>
            <td key={cell.id}>{pointButton(cell)}</td>)}
        </tr>)}</tbody>
      </table>
    </> : grid.length === 1 ? <>
      <div role="img" aria-label={t("results.map.parameterLine", { level: formatPercent(level / 100) })}>
        <ResponsiveContainer width="100%" height={240} minWidth={0} initialDimension={{ width: 600, height: 240 }}>
          <LineChart data={chartData} margin={{ top: 16, right: 24, bottom: 12, left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="index" type="category" tickFormatter={(index: number) => label(grid[0].values[index]) ?? ""} />
            <YAxis domain={["auto", "auto"]} tickFormatter={format} width={84} />
            <Tooltip labelFormatter={(index) => t("results.coordinate", { path: axisLabel(grid[0].path), value: label(grid[0].values[Number(index)]) ?? "" })}
              formatter={(value) => typeof value === "number" ? format(value) : formatNumber(null)} />
            <Line type="linear" dataKey="mean" name={metrics.find((candidate) => candidate.id === metric)?.title}
              stroke="#2563eb" connectNulls={false} isAnimationActive={false} activeDot={false}
              dot={({ cx, cy, index }) => {
                const cell = cells[index ?? -1];
                return cell === undefined || cx == null || cy == null ? <g /> : <circle key={cell.id} cx={cx} cy={cy}
                  r={cell.id === pointId ? 7 : 4} fill={cell.id === pointId ? "#172554" : "#2563eb"}
                  role="button" tabIndex={0} aria-label={t("results.map.selectPoint", { point: pointName(cell.id) })} aria-pressed={cell.id === pointId}
                  onClick={() => onPointChange?.(cell.id)} onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPointChange?.(cell.id); }
                  }}><title>{t("results.map.pointReadout", { point: pointName(cell.id), value: readout(cell) })}</title></circle>;
              }}>
              <ErrorBar dataKey="interval" stroke="#475569" width={5} isAnimationActive={false} />
            </Line>
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="map-axis">{t("results.map.documentOrder", { path: axisLabel(grid[0].path) })}</p>
      <ul className="map-points" aria-label={t("results.map.points")}>{cells.map((cell) => <li key={cell.id}>
        <span>{label(grid[0].values[cell.column])}</span>{pointButton(cell)}
      </li>)}</ul>
    </> : null}
  </section>;
}
