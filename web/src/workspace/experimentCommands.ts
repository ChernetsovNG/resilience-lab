import { t } from "../i18n";
import type { Catalog, ExperimentFile, ModelFile, ParamDescriptor, Variant } from "../api/apiTypes";
import type { EditorCommand } from "./editor";
import { applyOverrides, elementOf, isObject, type Params } from "./params";
import { equivalentQuantities } from "./quantities";
import { reconcileParameter } from "./parameterApplicability";

type Fault = ExperimentFile["faults"][number];
type Execution = ExperimentFile["execution"];

/** Block, connection and variant ID syntax from ModelCompiler.ID; IDs are unique within the variant list. */
export function variantIdError(variants: Variant[], id: string, current?: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return t("app.variant.invalidId");
  return variants.some((variant) => variant.id === id && variant.id !== current) ? t("app.variant.idUsed") : null;
}

/** Smallest free generated variant ID, independent of labels and array order. */
export function nextVariantId(variants: Variant[]): string {
  let index = 1;
  while (variants.some((variant) => variant.id === `variant-${index}`)) index++;
  return `variant-${index}`;
}

function editExperiment(change: (experiment: ExperimentFile) => ExperimentFile): EditorCommand {
  return (documents) => {
    const experiment = change(documents.experiment);
    return experiment === documents.experiment ? documents : { ...documents, experiment };
  };
}

/** Replace the shared grid in one history entry, preserving axis/value order and duplicates.
 * An imported oversized grid may be edited or reduced, but cannot grow. */
export function setGridAxes(grid: NonNullable<ExperimentFile["grid"]>): EditorCommand {
  return editExperiment((experiment) => grid.length > Math.max(2, experiment.grid?.length ?? 0) ? experiment : { ...experiment, grid });
}

function parameter(model: ModelFile, catalog: Catalog, id: string, path: string) {
  const element = elementOf(model, id);
  const [name, ...fields] = path.split(".");
  let descriptor = catalog.types.find((type) => type.id === element?.type)?.params.find((param) => param.name === name);
  let value = element?.params[name] ?? descriptor?.default;
  for (const field of fields) {
    descriptor = descriptor?.fields.find((candidate) => candidate.name === field);
    value = (isObject(value) ? value[field] : undefined) ?? descriptor?.default;
  }
  return { descriptor, value };
}

function sameValue(left: unknown, right: unknown, descriptor?: ParamDescriptor): boolean {
  if (left === right) return true;
  if (descriptor?.kind === "QUANTITY" && typeof left === "string" && typeof right === "string") {
    return equivalentQuantities(left, right, descriptor.units);
  }
  if ((descriptor?.kind === "NUMBER" || descriptor?.kind === "INTEGER") && left != null && right != null) {
    return Number(left) === Number(right);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Expand only an ancestor object that must be split for a field edit; retain its effective sibling values. */
function leafDifferences(path: string, base: unknown, effective: unknown, descriptor: ParamDescriptor | undefined, result: Params) {
  base ??= descriptor?.default;
  effective ??= descriptor?.default;
  if (descriptor?.kind === "OBJECT" || isObject(effective)) {
    const fields = new Set([...(descriptor?.fields.map((field) => field.name) ?? []), ...Object.keys(isObject(effective) ? effective : {})]);
    for (const field of fields) {
      leafDifferences(`${path}.${field}`, isObject(base) ? base[field] : undefined, isObject(effective) ? effective[field] : undefined,
        descriptor?.fields.find((candidate) => candidate.name === field), result);
    }
  } else if (!sameValue(base, effective, descriptor)) result[path] = effective ?? null;
}

/** Edit a precise path; kind changes may replace its enclosing object to reconcile dependent fields atomically.
 * Matching model values (including catalog defaults) remove the override. */
export function setVariantParam(variantId: string, id: string, path: string, value: unknown, catalog: Catalog): EditorCommand {
  return (documents) => editExperiment((experiment) => ({
    ...experiment,
    variants: experiment.variants.map((variant) => {
      if (variant.id !== variantId) return variant;
      const key = `${id}.${path}`;
      const overrides: Params = { ...variant.overrides };
      if (Object.keys(overrides).some((ancestor) => key.startsWith(`${ancestor}.`))) {
        const root = `${id}.${path.split(".")[0]}`;
        for (const existing of Object.keys(overrides)) if (existing === root || existing.startsWith(`${root}.`)) delete overrides[existing];
        const base = parameter(documents.model, catalog, id, path.split(".")[0]);
        const effective = parameter(applyOverrides(documents.model, variant.overrides, catalog), catalog, id, path.split(".")[0]);
        leafDifferences(root, base.value, effective.value, base.descriptor, overrides);
      }
      for (const existing of Object.keys(overrides)) if (existing === key || existing.startsWith(`${key}.`)) delete overrides[existing];
      const base = parameter(documents.model, catalog, id, path);
      if (value !== undefined && !sameValue(base.value, value ?? base.descriptor?.default, base.descriptor)) overrides[key] = value;
      const root = path.split(".")[0];
      const original = parameter(applyOverrides(documents.model, variant.overrides, catalog), catalog, id, root);
      const updated = parameter(applyOverrides(documents.model, overrides, catalog), catalog, id, root);
      const reconciled = updated.descriptor === undefined ? updated.value : reconcileParameter(updated.descriptor, original.value, updated.value);
      if (reconciled !== updated.value) {
        const rootKey = `${id}.${root}`;
        for (const existing of Object.keys(overrides)) if (existing === rootKey || existing.startsWith(`${rootKey}.`)) delete overrides[existing];
        const modelValue = parameter(documents.model, catalog, id, root);
        if (!sameValue(modelValue.value, reconciled, updated.descriptor)) overrides[rootKey] = reconciled;
      }
      return { ...variant, overrides: overrides as Variant["overrides"] };
    }),
  }))(documents);
}

/** Reset a scalar, field or complete object in a single history entry. */
export function resetVariantParam(variant: string, id: string, path: string, catalog: Catalog): EditorCommand {
  return setVariantParam(variant, id, path, undefined, catalog);
}

/** Append an empty variant or a copy, without sharing its override map. */
export function addVariant(id: string, label: string, copyFrom?: string): EditorCommand {
  return editExperiment((experiment) => {
    if (variantIdError(experiment.variants, id) !== null) return experiment;
    const source = experiment.variants.find((variant) => variant.id === copyFrom);
    return { ...experiment, variants: [...experiment.variants, { ...source, id, label, overrides: { ...source?.overrides } }] };
  });
}

/** Rename the variant in place; parameter paths address model elements and do not change with a variant ID. */
export function updateVariant(id: string, patch: Partial<Pick<Variant, "id" | "label" | "description">>): EditorCommand {
  return editExperiment((experiment) => {
    if (patch.id !== undefined && variantIdError(experiment.variants, patch.id, id) !== null) return experiment;
    return { ...experiment, variants: experiment.variants.map((variant) => {
      if (variant.id !== id) return variant;
      const next = { ...variant, ...patch };
      if (patch.label === "") delete next.label;
      if (patch.description === "") delete next.description;
      return next;
    }) };
  });
}

/** Remove a variant, preserving the compiler's requirement that at least one remains. */
export function removeVariant(id: string): EditorCommand {
  return editExperiment((experiment) => experiment.variants.length <= 1 ? experiment : {
    ...experiment, variants: experiment.variants.filter((variant) => variant.id !== id),
  });
}

/** Run settings apply to every variant, independently of the currently displayed page.
 * Clearing an optional field removes it from the document. */
export function setExecutionParam<K extends keyof Execution>(name: K, value: Execution[K]): EditorCommand {
  return editExperiment((experiment) => {
    const execution = { ...experiment.execution };
    if (value === undefined) delete execution[name];
    else execution[name] = value;
    return { ...experiment, execution };
  });
}

/** Append a shared fault without changing the order or content of existing faults. */
export function addFault(fault: Fault): EditorCommand {
  return editExperiment((experiment) => ({ ...experiment, faults: [...experiment.faults, fault] }));
}

/** Replace a fault, including all kind-specific fields, in one history entry. */
export function replaceFault(index: number, fault: Fault): EditorCommand {
  return editExperiment(experiment => ({ ...experiment, faults: experiment.faults.map((current, position) => position === index ? fault : current) }));
}

/** Edit one shared fault field; clearing an optional field removes it. */
export function setFaultParam<K extends keyof Fault>(index: number, name: K, value: Fault[K] | undefined): EditorCommand {
  return editExperiment((experiment) => ({ ...experiment, faults: experiment.faults.map((fault, position) => {
    if (position !== index) return fault;
    const next = { ...fault };
    if (value === undefined) delete next[name];
    else next[name] = value;
    return next;
  }) }));
}

/** Remove one shared fault. */
export function removeFault(index: number): EditorCommand {
  return editExperiment((experiment) => ({ ...experiment, faults: experiment.faults.filter((_, position) => position !== index) }));
}
