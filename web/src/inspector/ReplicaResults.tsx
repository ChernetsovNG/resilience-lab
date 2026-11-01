import { useState } from "react";
import type { Catalog, ModelFile } from "../api/apiTypes";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { formatOutput, outputValue, outputsOf } from "../results/outputs";
import type { ReplicaGroup, ResultAggregate } from "../results/groups";
import { policyOutputAvailable } from "../workspace/policyParameters";
import type { WindowMetricValues } from "../results/series/types";

/** A summary or selected-window view of the saved instance rows; sorting never alters documents. */
export function ReplicaResults({ group, aggregate, catalog, replications, models = [], window = null, frames, selected, onSelect }: {
  group: ReplicaGroup; aggregate: ResultAggregate; catalog: Catalog; replications: number;
  models?: readonly ModelFile[];
  window?: number | null; frames?: ReadonlyMap<string, WindowMetricValues>;
  selected: string | null; onSelect?: (id: string) => void;
}) {
  const [sort, setSort] = useState({ column: "replica", descending: false });
  const outputs = outputsOf(catalog, "service");
  const policyColumns = ["ejectedShare", "notReadyShare", "rateLimitedRate"]
    .filter(id => policyOutputAvailable(id, group.id, models))
    .map(id => ({ id, title: t(`results.groups.${id}`) }));
  const columns = [
    { id: "utilization", title: t("results.metrics.handlerUtilization") },
    { id: "meanQueue", title: t("results.groups.meanQueue") },
    { id: "queueRejectionRate", title: t("results.groups.rejections") },
    { id: "groupP99LatencyMs", title: t("results.metrics.p99LatencyMs") },
    ...policyColumns,
  ];
  const sortColumn = sort.column === "replica" || columns.some(column => column.id === sort.column) ? sort.column : "replica";
  const rows = group.instances.map(instance => ({ ...instance, values: Object.fromEntries(columns.map(column => {
    const output = outputs.find(output => output.id === column.id);
    const value = window === null ? { ...aggregate.services[instance.id], replications } : frames?.get(instance.id);
    return [column.id, { output, value: output === undefined ? null : outputValue(output, value, window !== null).value }];
  })) }));
  rows.sort((a, b) => {
    const av = sortColumn === "replica" ? a.replica : a.values[sortColumn].value;
    const bv = sortColumn === "replica" ? b.replica : b.values[sortColumn].value;
    return av === null ? bv === null ? a.replica - b.replica : 1 : bv === null ? -1
      : (sort.descending ? bv - av : av - bv) || a.replica - b.replica;
  });
  const header = (id: string, title: string) => <th scope="col" key={id}
    aria-sort={sortColumn !== id ? "none" : sort.descending ? "descending" : "ascending"}>
    <button type="button" onClick={() => setSort(current => ({ column: id,
      descending: current.column === id ? !current.descending : id !== "replica" }))}>{title}</button>
  </th>;
  return <div className="replica-results-scroll"><table className={`replica-results${policyColumns.length > 0 ? " replica-results--policies" : ""}`} aria-label={t("results.groups.replicas", { group: group.id })}>
    <caption>{t("results.groups.replicas", { group: group.id })} <HelpHint label={t("results.groups.replicas", { group: group.id })}>
      {t(window === null ? "results.groups.summaryHelp" : "results.groups.windowHelp")}</HelpHint>
      <small>{window === null ? t("results.groups.summarySource") : t("inspector.results.window", { window: formatNumber(window) })}</small>
    </caption>
    <thead><tr>{header("replica", t("editor.replicas.number"))}{columns.map(column => header(column.id, column.title))}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id} aria-selected={selected === row.id} onClick={() => onSelect?.(row.id)}>
      <th scope="row"><button type="button" aria-label={row.id} onClick={event => { event.stopPropagation(); onSelect?.(row.id); }}>
        {t("editor.replicas.row", { number: formatNumber(row.replica) })}</button></th>
      {columns.map(column => <td key={column.id}>{row.values[column.id].output === undefined ? formatNumber(null)
        : formatOutput(row.values[column.id].output!, row.values[column.id].value)}</td>)}
    </tr>)}</tbody>
  </table></div>;
}
