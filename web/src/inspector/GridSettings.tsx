import { useId } from "react";
import { language, t } from "../i18n";
import { HelpHint } from "../help/HelpHint";
import { sweepDiagnostics } from "./sweepDiagnostics";
import { InspectorSection } from "./InspectorSection";
import { formatNumber } from "../i18n/format";
import type { Catalog, Diagnostic, ExperimentFile, ModelFile, ParamDescriptor } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { setGridAxes } from "../workspace/experimentCommands";
import { isObject, ownEntry } from "../workspace/params";
import { ParamField } from "./ParamField";
import { parameterLabel } from "../presentation/labels";
import { parseParam } from "../workspace/paramParsing";
import { parameterApplies } from "../workspace/parameterApplicability";
import { canonicalOf, equivalentQuantities } from "../workspace/quantities";

type GridAxis = NonNullable<ExperimentFile["grid"]>[number];

interface Props {
  catalog: Catalog;
  model: ModelFile;
  experiment: ExperimentFile;
  editable: boolean;
  invalid: boolean;
  onCommand: (command: EditorCommand) => void;
  onValidity: (path: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

function parametersOf(model: ModelFile, catalog: Catalog) {
  const leaves = (params: ParamDescriptor[], prefix: string, values: unknown, titles: string[] = []): {
    path: string; title: string; descriptor: ParamDescriptor; value: GridAxis["values"][number];
  }[] => params.flatMap((descriptor) => {
    if (!parameterApplies(descriptor, isObject(values) ? values : {}, params)) return [];
    const path = `${prefix}.${descriptor.name}`;
    const value = (isObject(values) ? values[descriptor.name] : undefined) ?? descriptor.default ?? null;
    const title = [...titles, descriptor.title];
    return descriptor.kind === "OBJECT" ? leaves(descriptor.fields, path, value, title)
      : descriptor.sweepable ? [{ path, title: title.join(t("editor.symbols.separator")), descriptor, value: value as GridAxis["values"][number] }] : [];
  });
  return [...Object.entries(model.blocks), ...model.connections.map((connection) => [connection.id, connection] as const)]
    .flatMap(([id, element]) => leaves((catalog.types.find((type) => type.id === element.type)?.params ?? []).filter(param =>
      !(element.type === "call" && "from" in element && ownEntry(model.blocks, element.from)?.type === "pooler" && param.name === "pool")), id, element.params)
      .map(parameter => ({ ...parameter, heading: parameterLabel(parameter.path, catalog, model) })));
}

/** Continue the written step, then look for unused values inside the descriptor's range. */
function nextGridValue(descriptor: ParamDescriptor, values: GridAxis["values"], initial: GridAxis["values"][number]): GridAxis["values"][number] | undefined {
  const quantity = descriptor.kind === "QUANTITY";
  const lastWritten = values.at(-1) ?? initial;
  const unit = quantity ? [...descriptor.units].sort((a, b) => b.symbol.length - a.symbol.length)
    .find(candidate => String(lastWritten).endsWith(candidate.symbol)) ?? descriptor.units[0] : undefined;
  if (quantity && unit === undefined) return undefined;
  const scale = unit === undefined ? 1 : unit.numerator / unit.denominator;
  const numberOf = (value: unknown) => quantity ? canonicalOf(String(value), descriptor.units)
    : typeof value === "number" && Number.isFinite(value) ? value : null;
  const numbers = values.map(numberOf).filter((value): value is number => value !== null);
  const last = numbers.at(-1) ?? numberOf(initial) ?? descriptor.minimum ?? descriptor.exclusiveMinimum ?? 0;
  const previous = numbers.slice(0, -1).reverse().find(value => value !== last);
  const step = previous === undefined ? scale : last - previous;
  const used = (value: GridAxis["values"][number]) => values.some(current => quantity
    ? equivalentQuantities(String(current), String(value), descriptor.units) : current === value);
  const encode = (canonical: number) => {
    const written = unit === undefined ? canonical : canonical * unit.denominator / unit.numerator;
    if (!Number.isFinite(written)) return undefined;
    // Remove addition noise in decimal steps; retain full precision when rounding repeats an existing value.
    for (const number of descriptor.kind === "INTEGER" ? [written] : [Number(written.toPrecision(15)), written]) {
      const value = unit === undefined ? number : `${number}${unit.symbol}`;
      if (parseParam({ ...descriptor, required: true }, String(value)).ok && !used(value)) return value;
    }
    return undefined;
  };
  const first = encode(values.length === 0 ? last : last + step);
  if (first !== undefined) return first;
  const resolution = descriptor.kind === "INTEGER" ? 1 : Math.max(Number.MIN_VALUE, Math.abs(last) * Number.EPSILON);
  const distance = Math.max(Math.abs(step), resolution);
  for (let index = 1; index <= values.length + 1; index++) {
    for (const candidate of [last - Math.sign(step) * distance * index, last + Math.sign(step) * distance * index]) {
      const value = encode(candidate);
      if (value !== undefined) return value;
    }
  }
  if (descriptor.kind === "INTEGER") {
    for (let index = 1; index <= values.length + 1; index++) {
      for (const candidate of [last - index, last + index]) {
        const value = encode(candidate);
        if (value !== undefined) return value;
      }
    }
  }
  const lower = descriptor.minimum ?? descriptor.exclusiveMinimum ?? (quantity ? 0 : undefined);
  for (const bound of [lower, descriptor.maximum]) {
    if (bound == null) continue;
    for (const candidate of [bound, bound / 2 + last / 2]) {
      const value = encode(candidate);
      if (value !== undefined) return value;
    }
  }
  if (descriptor.kind === "NUMBER" || quantity) {
    const positions = [...new Set([...numbers, lower, descriptor.maximum]
      .filter((value): value is number => value != null && Number.isFinite(value)))].sort((a, b) => a - b);
    for (let index = 1; index < positions.length; index++) {
      const value = encode(positions[index - 1] / 2 + positions[index] / 2);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/** Shared grid axes use the same catalog fields, draft validation and history as other parameters. */
export function GridSettings({ catalog, model, experiment, editable, invalid, onCommand, onValidity, fieldDiagnostics }: Props) {
  const id = useId();
  const grid = experiment.grid ?? [];
  const parameters = parametersOf(model, catalog);
  const labels = new Map(grid.map(axis => {
    const parameter = parameters.find(candidate => candidate.path === axis.path);
    return [axis.path, parameter?.heading ?? parameterLabel(axis.path, catalog, model)];
  }));
  const display = (diagnostics: readonly Diagnostic[] = []) => sweepDiagnostics(diagnostics, experiment, labels, catalog, model);
  const fieldMessages = new Map([...(fieldDiagnostics ?? [])].map(([path, diagnostics]) => [path, display(diagnostics)]));
  const errors = new Map([...fieldMessages].map(([path, diagnostics]) => [path, diagnostics.filter(diagnostic => diagnostic.severity === "ERROR")]));
  const plural = new Intl.PluralRules(language);
  const count = (kind: string, value: number) => t(`editor.grid.count.${kind}.${plural.select(value)}`, { count: formatNumber(value) });
  const points = grid.reduce((total, axis) => total * axis.values.length, 1);
  const cost = t("editor.grid.cost", { dimensions: grid.length < 2 ? "" : t("editor.grid.dimensions", {
    sizes: grid.map(axis => formatNumber(axis.values.length)).join(` ${t("editor.symbols.multiplier")} `),
  }), points: count("points", points), variants: count("variants", experiment.variants.length),
    replications: count("replications", experiment.execution.replications), runs: count("runs", points * experiment.variants.length * experiment.execution.replications) });
  const next = parameters.find((parameter) => !grid.some((axis) => axis.path === parameter.path));
  const replace = (index: number, axis: GridAxis) => onCommand(setGridAxes(grid.map((current, position) => position === index ? axis : current)));
  return <InspectorSection name="grid" title={<h3>{t("editor.grid.title")}</h3>}>
    <section className="grid-settings" data-inspector-field="grid">
    <p className="grid-explanation">{t("editor.grid.explanation")}</p>
    {grid.length === 0 ? null : <output className="grid-cost" aria-label={t("editor.grid.costLabel")}>{cost}</output>}
    <p className="grid-explanation">{t("editor.grid.shared")}</p>
    <DiagnosticMessages diagnostics={fieldMessages.get("grid")} />
    {grid.length === 0 ? <p>{t("editor.grid.empty")}</p> : null}
    {grid.map((axis, index) => {
      const parameter = parameters.find((candidate) => candidate.path === axis.path);
      const prefix = `grid.${index}`;
      const heading = parameter?.heading ?? parameterLabel(axis.path, catalog, model);
      const nextValue = parameter === undefined ? undefined : nextGridValue(parameter.descriptor, axis.values, parameter.value);
      const descriptionId = `${id}-axis-${index}-description`;
      const warningsId = `${id}-axis-${index}-warnings`;
      const warnings = display(axis.values.flatMap((_, position) => fieldDiagnostics?.get(`${prefix}.values.${position}`) ?? [])
        .filter(diagnostic => diagnostic.severity === "WARNING"));
      return <fieldset className="param-group" key={index} data-inspector-field={prefix} aria-label={heading}
        aria-describedby={[parameter?.descriptor.description ? descriptionId : null, warnings.length > 0 ? warningsId : null].filter(Boolean).join(" ") || undefined}>
        <legend>{heading} {parameter?.descriptor.description ? <HelpHint id={descriptionId} label={heading}>{parameter.descriptor.description}</HelpHint> : null}</legend>
        <DiagnosticMessages diagnostics={fieldMessages.get(prefix)} />
        <label className="param-field" data-inspector-field={`${prefix}.path`}>{t("editor.grid.axisParameter", { number: formatNumber(index + 1) })}
          <select value={axis.path} disabled={!editable || invalid}
            onChange={(event) => {
              const selected = parameters.find((candidate) => candidate.path === event.target.value)!;
              replace(index, { path: selected.path, values: [selected.value] });
            }}>
            {parameter === undefined ? <option value={axis.path} title={axis.path}>{t("editor.grid.unavailableParameter", { path: heading })}</option> : null}
            {parameters.map((candidate) => <option key={candidate.path} value={candidate.path} title={candidate.path}>
              {candidate.heading}
            </option>)}
          </select>
        </label>
        <DiagnosticMessages diagnostics={fieldMessages.get(`${prefix}.path`)} />
        <div className="grid-values" data-inspector-field={`${prefix}.values`}>
        <DiagnosticMessages diagnostics={fieldMessages.get(`${prefix}.values`)} />
        {parameter === undefined ? <p>{t("editor.grid.chooseParameter")}</p> : <>
          {axis.values.map((value, position) => <div className="grid-value" key={position}>
            <ParamField descriptor={{ ...parameter.descriptor, required: true, description: "", title: t("editor.grid.axisValue", { axis: formatNumber(index + 1), value: formatNumber(position + 1) }) }}
              path={`${prefix}.values.${position}`} value={value} editable={editable} isOverridden={() => false}
              onValidity={onValidity} fieldDiagnostics={errors}
              onCommit={(updated) => replace(index, { ...axis, values: axis.values.map((current, at) => at === position ? updated as typeof current : current) })} />
            <button type="button" aria-label={t("editor.grid.removeValueLabel", { axis: formatNumber(index + 1), value: formatNumber(position + 1) })} disabled={!editable || invalid}
              onClick={() => replace(index, { ...axis, values: axis.values.filter((_, at) => at !== position) })}>{t("editor.grid.removeValueSymbol")}</button>
          </div>)}
          <button type="button" aria-label={t("editor.grid.addValueLabel", { axis: formatNumber(index + 1) })} disabled={!editable || invalid || nextValue === undefined}
            onClick={() => { if (nextValue !== undefined) replace(index, { ...axis, values: [...axis.values, nextValue] }); }}>{t("editor.grid.addValue")}</button>
        </>}
        </div>
        <DiagnosticMessages id={warningsId} diagnostics={warnings} />
        <button type="button" aria-label={t("editor.grid.removeAxisLabel", { axis: formatNumber(index + 1) })} disabled={!editable || invalid}
          onClick={() => onCommand(setGridAxes(grid.filter((_, at) => at !== index)))}>{t("editor.grid.removeAxis")}</button>
      </fieldset>;
    })}
    <button type="button" disabled={!editable || invalid || grid.length >= 2 || next === undefined}
      onClick={() => { if (next !== undefined) onCommand(setGridAxes([...grid, { path: next.path, values: [next.value] }])); }}>{t("editor.grid.addAxis")}</button>
    </section>
  </InspectorSection>;
}
