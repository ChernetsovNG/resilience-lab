import type { Catalog, Diagnostic, ExperimentFile, ModelFile, ParamDescriptor } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { addFault, removeFault, setExecutionParam, setFaultParam } from "../workspace/experimentCommands";
import { ParamField } from "./ParamField";

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

function allParams(catalog: Catalog): ParamDescriptor[] {
  const flatten = (params: ParamDescriptor[]): ParamDescriptor[] => params.flatMap((param) => [param, ...flatten(param.fields)]);
  return flatten(catalog.types.flatMap((type) => type.params));
}

/** Execution and fault field units come from catalog dimensions, including their conversion scales. */
function descriptor(catalog: Catalog, name: string, title: string, kind: ParamDescriptor["kind"], extra: Partial<ParamDescriptor> = {}): ParamDescriptor {
  const units = allParams(catalog).find((param) => param.dimension === extra.dimension)?.units ?? [];
  return { name, title, kind, description: "Shared by all variants", required: true, options: [], fields: [], sweepable: false, units, ...extra };
}

/** Shared experiment settings are editable on every model or variant page. */
export function RunSettings({ catalog, model, experiment, editable, invalid, onCommand, onValidity, fieldDiagnostics }: Props) {
  const duration = (name: string, title: string, positive = false) => descriptor(catalog, name, title, "QUANTITY", {
    dimension: "DURATION", ...(positive ? { exclusiveMinimum: 0 } : { minimum: 0 }),
  });
  const executionFields = [
    descriptor(catalog, "replications", "Replications", "INTEGER", { minimum: 1, maximum: 2_147_483_647 }),
    duration("warmup", "Warm-up"), duration("measurement", "Measurement", true),
    descriptor(catalog, "seed", "Seed", "INTEGER", { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    duration("maxRealTime", "Real-time limit", true),
  ];
  const faultFields = [
    duration("from", "Fault start"), duration("to", "Fault end", true),
    descriptor(catalog, "processingMultiplier", "Processing multiplier", "NUMBER", { required: false, exclusiveMinimum: 0 }),
    descriptor(catalog, "failureRate", "Fault failure rate", "QUANTITY", { required: false, dimension: "PROBABILITY", minimum: 0, maximum: 1 }),
  ];
  const targets = Object.entries(model.blocks).filter(([, block]) =>
    catalog.types.find((type) => type.id === block.type)?.params.some((param) => param.name === "processing"),
  ).map(([id]) => id);
  return (
    <>
      <h2>Run settings</h2>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution")} />
      <p className="inspector-type">Shared by all variants</p>
      {executionFields.map((field) => (
        <ParamField key={field.name} descriptor={field} value={experiment.execution[field.name as keyof ExperimentFile["execution"]]}
          path={`execution.${field.name}`} editable={editable} isOverridden={() => false} onValidity={onValidity}
          fieldDiagnostics={fieldDiagnostics}
          onCommit={(value) => onCommand(setExecutionParam(field.name as keyof ExperimentFile["execution"], value as string | number))} />
      ))}
      <h3>Faults</h3>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("faults")} />
      {experiment.faults.length === 0 ? <p>None.</p> : null}
      {experiment.faults.map((fault, index) => (
        <fieldset className="param-group" key={index}>
          <legend>Fault {index + 1}</legend>
          <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`faults.${index}`)} />
          <label className="param-field">Fault target
            <select value={fault.target} disabled={!editable} onChange={(event) => onCommand(setFaultParam(index, "target", event.target.value))}>
              {targets.includes(fault.target) ? null : <option value={fault.target}>{fault.target}</option>}
              {targets.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`faults.${index}.target`)} />
          </label>
          {faultFields.map((field) => (
            <ParamField key={field.name} descriptor={field} value={fault[field.name as keyof typeof fault]}
              path={`faults.${index}.${field.name}`} editable={editable} isOverridden={() => false} onValidity={onValidity}
              fieldDiagnostics={fieldDiagnostics}
              onCommit={(value) => onCommand(setFaultParam(index, field.name as keyof typeof fault, value as string | number | undefined))} />
          ))}
          <button type="button" aria-label={`Remove fault ${index + 1}`} disabled={!editable || invalid}
            onClick={() => onCommand(removeFault(index))}>Remove fault</button>
        </fieldset>
      ))}
      <button type="button" disabled={!editable || invalid || targets.length === 0} onClick={() => onCommand(addFault({
        target: targets[0], from: `0${duration("from", "").units[0]?.symbol ?? ""}`,
        to: experiment.execution.measurement, processingMultiplier: 2,
      }))}>Add fault</button>
    </>
  );
}
