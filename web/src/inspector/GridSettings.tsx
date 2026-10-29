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
  const leaves = (params: ParamDescriptor[], prefix: string, values: unknown): {
    path: string; descriptor: ParamDescriptor; value: GridAxis["values"][number];
  }[] => params.flatMap((descriptor) => {
    const path = `${prefix}.${descriptor.name}`;
    const value = (isObject(values) ? values[descriptor.name] : undefined) ?? descriptor.default ?? null;
    return descriptor.kind === "OBJECT" ? leaves(descriptor.fields, path, value)
      : descriptor.sweepable ? [{ path, descriptor, value: value as GridAxis["values"][number] }] : [];
  });
  return [...Object.entries(model.blocks), ...model.connections.map((connection) => [connection.id, connection] as const)]
    .flatMap(([id, element]) => leaves(catalog.types.find((type) => type.id === element.type)?.params ?? [], id, element.params));
}

/** Shared grid axes use the same catalog fields, draft validation and history as other parameters. */
export function GridSettings({ catalog, model, experiment, editable, invalid, onCommand, onValidity, fieldDiagnostics }: Props) {
  const grid = experiment.grid ?? [];
  const parameters = parametersOf(model, catalog);
  const next = parameters.find((parameter) => !grid.some((axis) => axis.path === parameter.path));
  const replace = (index: number, axis: GridAxis) => onCommand(setGridAxes(grid.map((current, position) => position === index ? axis : current)));
  return <section className="grid-settings">
    <h3>Parameter grid</h3>
    <DiagnosticMessages diagnostics={fieldDiagnostics?.get("grid")} />
    {grid.length === 0 ? <p>No grid. Add up to two axes to compare parameter values.</p> : null}
    {grid.map((axis, index) => {
      const parameter = parameters.find((candidate) => candidate.path === axis.path);
      const prefix = `grid.${index}`;
      return <fieldset className="param-group" key={index}>
        <legend>Axis {index + 1}</legend>
        <DiagnosticMessages diagnostics={fieldDiagnostics?.get(prefix)} />
        <label className="param-field">Axis {index + 1} parameter
          <select value={axis.path} disabled={!editable || invalid}
            onChange={(event) => {
              const selected = parameters.find((candidate) => candidate.path === event.target.value)!;
              replace(index, { path: selected.path, values: [selected.value] });
            }}>
            {parameter === undefined ? <option value={axis.path}>{axis.path} (unavailable)</option> : null}
            {parameters.map((candidate) => <option key={candidate.path} value={candidate.path}>
              {candidate.path} · {candidate.descriptor.title}
            </option>)}
          </select>
        </label>
        <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`${prefix}.path`)} />
        <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`${prefix}.values`)} />
        {parameter === undefined ? <p>Choose a catalog parameter to edit its values.</p> : <>
          {axis.values.map((value, position) => <div className="grid-value" key={position}>
            <ParamField descriptor={{ ...parameter.descriptor, required: true, title: `Axis ${index + 1} value ${position + 1}` }}
              path={`${prefix}.values.${position}`} value={value} editable={editable} isOverridden={() => false}
              onValidity={onValidity} fieldDiagnostics={fieldDiagnostics}
              onCommit={(updated) => replace(index, { ...axis, values: axis.values.map((current, at) => at === position ? updated as typeof current : current) })} />
            <button type="button" aria-label={`Remove axis ${index + 1} value ${position + 1}`} disabled={!editable || invalid}
              onClick={() => replace(index, { ...axis, values: axis.values.filter((_, at) => at !== position) })}>Remove value</button>
          </div>)}
          <button type="button" aria-label={`Add value to axis ${index + 1}`} disabled={!editable || invalid}
            onClick={() => replace(index, { ...axis, values: [...axis.values, parameter.value] })}>Add value</button>
        </>}
        <button type="button" aria-label={`Remove grid axis ${index + 1}`} disabled={!editable || invalid}
          onClick={() => onCommand(setGridAxes(grid.filter((_, at) => at !== index)))}>Remove axis</button>
      </fieldset>;
    })}
    <button type="button" disabled={!editable || invalid || grid.length >= 2 || next === undefined}
      onClick={() => { if (next !== undefined) onCommand(setGridAxes([...grid, { path: next.path, values: [next.value] }])); }}>Add grid axis</button>
  </section>;
}
