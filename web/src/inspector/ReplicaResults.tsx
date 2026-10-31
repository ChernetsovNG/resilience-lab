import { useState } from "react";
import type { Catalog } from "../api/apiTypes";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { formatOutput, outputValue, outputsOf } from "../results/outputs";
import type { ReplicaGroup, ResultAggregate } from "../results/groups";

/** A measured-interval view of the saved instance rows; sorting never alters documents. */
export function ReplicaResults({ group, aggregate, catalog, replications, selected, onSelect }: {
  group: ReplicaGroup; aggregate: ResultAggregate; catalog: Catalog; replications: number;
  selected: string | null; onSelect?: (id: string) => void;
}) {
  const [sort, setSort] = useState({ column: "replica", descending: false });
  const outputs = outputsOf(catalog, "service");
  const columns = [
    { id: "utilization", title: t("results.metrics.handlerUtilization") },
    { id: "meanQueue", title: t("results.groups.meanQueue") },
    { id: "queueRejectionRate", title: t("results.groups.rejections") },
    { id: "groupP99LatencyMs", title: t("results.metrics.p99LatencyMs") },
  ];
  const rows = group.instances.map(instance => ({ ...instance, values: Object.fromEntries(columns.map(column => {
    const output = outputs.find(output => output.id === column.id);
    const value = aggregate.services[instance.id];
    return [column.id, { output, value: output === undefined || value === undefined ? null : outputValue(output, { ...value, replications }, false).value }];
  })) }));
  rows.sort((a, b) => {
    const av = sort.column === "replica" ? a.replica : a.values[sort.column].value;
    const bv = sort.column === "replica" ? b.replica : b.values[sort.column].value;
    return av === null ? bv === null ? a.replica - b.replica : 1 : bv === null ? -1
      : (sort.descending ? bv - av : av - bv) || a.replica - b.replica;
  });
  const header = (id: string, title: string) => <th scope="col" key={id}
    aria-sort={sort.column !== id ? "none" : sort.descending ? "descending" : "ascending"}>
    <button type="button" onClick={() => setSort(current => ({ column: id,
      descending: current.column === id ? !current.descending : id !== "replica" }))}>{title}</button>
  </th>;
  return <div className="replica-results-scroll"><table className="replica-results" aria-label={t("results.groups.replicas", { group: group.id })}>
    <caption>{t("results.groups.replicas", { group: group.id })} <HelpHint label={t("results.groups.replicas", { group: group.id })}>
      {t("results.groups.summaryHelp")}</HelpHint></caption>
    <thead><tr>{header("replica", t("editor.replicas.number"))}{columns.map(column => header(column.id, column.title))}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id} aria-selected={selected === row.id} onClick={() => onSelect?.(row.id)}>
      <th scope="row"><button type="button" aria-label={row.id} onClick={event => { event.stopPropagation(); onSelect?.(row.id); }}>
        {t("editor.replicas.row", { number: formatNumber(row.replica) })}</button></th>
      {columns.map(column => <td key={column.id}>{row.values[column.id].output === undefined ? formatNumber(null)
        : formatOutput(row.values[column.id].output!, row.values[column.id].value)}</td>)}
    </tr>)}</tbody>
  </table></div>;
}
