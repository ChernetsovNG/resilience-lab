import type { Catalog, Diagnostic, ExperimentFile, ModelFile } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import { elementOf, isOverridden } from "../workspace/params";
import { ParamField } from "./ParamField";

export interface InspectorProps {
  catalog: Catalog;
  /** The model as the active variant page sees it. */
  model: ModelFile;
  experiment: ExperimentFile;
  selected: string | null;
  /** False on variant pages: values are shown, not edited. */
  editable: boolean;
  overrides: Record<string, unknown>;
  onParam: (id: string, name: string, value: unknown) => void;
  /** Validity of a field draft by `elementId.path`; a field that unmounts reports itself valid. */
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

/** Context inspector (product vision §5.5): the selected element from the catalog, run settings otherwise. */
export function Inspector({ catalog, model, experiment, selected, editable, overrides, onParam, onValidity, fieldDiagnostics }: InspectorProps) {
  const element = selected === null ? null : elementOf(model, selected);
  const type = element === null ? undefined : catalog.types.find((candidate) => candidate.id === element.type);

  return (
    <aside className="inspector" aria-label="Inspector">
      {selected !== null && element !== null && type !== undefined ? (
        <>
          <h2>{selected}</h2>
          <p className="inspector-type">
            {type.title}
            {editable ? "" : " · read-only on this variant page"}
          </p>
          {type.params.length === 0 ? <p>No parameters.</p> : null}
          {type.params.map((descriptor) => (
            <ParamField
              key={`${selected}.${descriptor.name}`}
              descriptor={descriptor}
              value={element.params[descriptor.name]}
              path={descriptor.name}
              editable={editable}
              isOverridden={(path) => isOverridden(overrides, selected, path)}
              onCommit={(value) => onParam(selected, descriptor.name, value)}
              onValidity={(path, valid) => onValidity(`${selected}.${path}`, valid)}
              fieldDiagnostics={fieldDiagnostics}
            />
          ))}
        </>
      ) : (
        <RunSettings experiment={experiment} fieldDiagnostics={fieldDiagnostics} />
      )}
    </aside>
  );
}

function RunSettings({ experiment, fieldDiagnostics }: Pick<InspectorProps, "experiment" | "fieldDiagnostics">) {
  const { execution } = experiment;
  return (
    <>
      <h2>Run settings</h2>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution")} />
      <dl className="run-settings">
        <dt>Replications</dt>
        <dd>{execution.replications}<DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution.replications")} /></dd>
        <dt>Warm-up</dt>
        <dd>{execution.warmup}<DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution.warmup")} /></dd>
        <dt>Measurement</dt>
        <dd>{execution.measurement}<DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution.measurement")} /></dd>
        <dt>Seed</dt>
        <dd>{execution.seed}<DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution.seed")} /></dd>
        <dt>Real-time limit</dt>
        <dd>{execution.maxRealTime ?? "Default"}<DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution.maxRealTime")} /></dd>
      </dl>
      <h3>Faults</h3>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("faults")} />
      {experiment.faults.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {experiment.faults.map((fault, index) => (
            <li key={index}>
              <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`faults.${index}`)} />
              {fault.target}: {fault.from}–{fault.to}
              {fault.processingMultiplier == null ? "" : `, processing ×${fault.processingMultiplier}`}
              {fault.failureRate == null ? "" : `, failures ${fault.failureRate}`}
              {[...(fieldDiagnostics ?? [])].filter(([field]) => field.startsWith(`faults.${index}.`)).map(([field, diagnostics]) => (
                <div key={field}>{field.slice(`faults.${index}.`.length)}<DiagnosticMessages diagnostics={diagnostics} /></div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
