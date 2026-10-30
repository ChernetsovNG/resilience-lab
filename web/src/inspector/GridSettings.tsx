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
import { isObject } from "../workspace/params";
import { ParamField } from "./ParamField";

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
    const path = `${prefix}.${descriptor.name}`;
    const value = (isObject(values) ? values[descriptor.name] : undefined) ?? descriptor.default ?? null;
    const title = [...titles, descriptor.title];
    return descriptor.kind === "OBJECT" ? leaves(descriptor.fields, path, value, title)
      : descriptor.sweepable ? [{ path, title: title.join(t("editor.symbols.separator")), descriptor, value: value as GridAxis["values"][number] }] : [];
  });
  return [...Object.entries(model.blocks), ...model.connections.map((connection) => [connection.id, connection] as const)]
    .flatMap(([id, element]) => leaves(catalog.types.find((type) => type.id === element.type)?.params ?? [], id, element.params)
      .map(parameter => ({ ...parameter, heading: t("editor.grid.axisTitle", { parameter: parameter.title,
        element: "from" in element ? t("editor.grid.connection", { from: element.from, to: element.to }) : id }) })));
}

/** Shared grid axes use the same catalog fields, draft validation and history as other parameters. */
export function GridSettings({ catalog, model, experiment, editable, invalid, onCommand, onValidity, fieldDiagnostics }: Props) {
  const id = useId();
  const grid = experiment.grid ?? [];
  const parameters = parametersOf(model, catalog);
  const labels = new Map(grid.map(axis => {
    const parameter = parameters.find(candidate => candidate.path === axis.path);
    const ambiguous = parameters.filter(candidate => grid.some(axis => axis.path === candidate.path) && candidate.title === parameter?.title).length > 1;
    return [axis.path, (ambiguous ? parameter?.heading : parameter?.title) ?? axis.path];
  }));
  const display = (diagnostics: readonly Diagnostic[] = []) => sweepDiagnostics(diagnostics, experiment, labels);
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
      const heading = parameter?.heading ?? axis.path;
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
            {parameter === undefined ? <option value={axis.path}>{t("editor.grid.unavailableParameter", { path: axis.path })}</option> : null}
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
          <button type="button" aria-label={t("editor.grid.addValueLabel", { axis: formatNumber(index + 1) })} disabled={!editable || invalid}
            onClick={() => replace(index, { ...axis, values: [...axis.values, parameter.value] })}>{t("editor.grid.addValue")}</button>
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
