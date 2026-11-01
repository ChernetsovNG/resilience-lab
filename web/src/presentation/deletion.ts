import type { Catalog } from "../api/apiTypes";
import { faultLabel } from "../experiment/course";
import { t } from "../i18n";
import type { EditorDocuments } from "../workspace/editor";
import { elementLabel, parameterLabel, variantLabel } from "./labels";

/** Describe the existing deletion command's losses; model-only deletions need no confirmation. */
export function deletionMessage(before: EditorDocuments, after: EditorDocuments, catalog: Catalog, experimentPath: string): string | null {
  const summarize = (items: string[]) => [...items.slice(0, 5),
    ...(items.length > 5 ? [t("app.confirm.moreRemoved", { count: items.length - 5 })] : [])].join("; ");
  const retainedFaults = new Set(after.experiment.faults.map(fault => fault.target));
  const retainedAxes = new Set(after.experiment.grid?.map(axis => axis.path));
  const faults = before.experiment.faults.filter(fault => !retainedFaults.has(fault.target))
    .map(fault => faultLabel(fault, before.model, catalog));
  const axes = (before.experiment.grid ?? []).filter(axis => !retainedAxes.has(axis.path))
    .map(axis => parameterLabel(axis.path, catalog, before.model));
  const variants = before.experiment.variants.flatMap(variant => {
    const retained = after.experiment.variants.find(candidate => candidate.id === variant.id)?.overrides ?? {};
    const removed = Object.keys(variant.overrides ?? {}).filter(path => !Object.hasOwn(retained, path));
    return removed.length === 0 ? [] : [t("app.confirm.removedOverrides", {
      variant: variantLabel(variant, before.experiment.variants), count: removed.length,
      parameters: summarize(removed.map(path => parameterLabel(path, catalog, before.model))),
    })];
  });
  if (faults.length === 0 && axes.length === 0 && variants.length === 0) return null;
  const blocks = Object.keys(before.model.blocks).filter(id => !Object.hasOwn(after.model.blocks, id));
  const retainedConnections = new Set(after.model.connections.map(edge => edge.id));
  const connections = before.model.connections.filter(edge => !retainedConnections.has(edge.id))
    .map(edge => elementLabel(edge.id, before.model));
  const settings = [
    ...(blocks.length === 0 ? [] : [t("app.confirm.removedBlocks", { blocks: summarize(blocks) })]),
    ...(connections.length === 0 ? [] : [t("app.confirm.removedConnections", { connections: summarize(connections) })]),
    t("app.confirm.removedExperiment", { experiment: experimentPath.split("/").at(-1)!.replace(/\.experiment\.json$/, "") }),
    ...(faults.length === 0 ? [] : [t("app.confirm.removedFaults", { faults: summarize(faults) })]),
    ...(axes.length === 0 ? [] : [t("app.confirm.removedAxes", { axes: summarize(axes) })]),
    ...(variants.length === 0 ? [] : [summarize(variants)]),
  ];
  return t("app.confirm.dependentSettingsMessage", { settings: settings.join("\n") });
}
