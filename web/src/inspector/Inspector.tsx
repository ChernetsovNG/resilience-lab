import type { Catalog, ExperimentFile, ModelFile } from "../api/apiTypes";
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
}

/** Context inspector (product vision §5.5): the selected element from the catalog, run settings otherwise. */
export function Inspector({ catalog, model, experiment, selected, editable, overrides, onParam, onValidity }: InspectorProps) {
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
            />
          ))}
        </>
      ) : (
        <RunSettings experiment={experiment} />
      )}
    </aside>
  );
}

function RunSettings({ experiment }: { experiment: ExperimentFile }) {
  const { execution } = experiment;
  return (
    <>
      <h2>Run settings</h2>
      <dl className="run-settings">
        <dt>Replications</dt>
        <dd>{execution.replications}</dd>
        <dt>Warm-up</dt>
        <dd>{execution.warmup}</dd>
        <dt>Measurement</dt>
        <dd>{execution.measurement}</dd>
        <dt>Seed</dt>
        <dd>{execution.seed}</dd>
      </dl>
      <h3>Faults</h3>
      {experiment.faults.length === 0 ? (
        <p>None.</p>
      ) : (
        <ul>
          {experiment.faults.map((fault, index) => (
            <li key={index}>
              {fault.target}: {fault.from}–{fault.to}
              {fault.processingMultiplier == null ? "" : `, processing ×${fault.processingMultiplier}`}
              {fault.failureRate == null ? "" : `, failures ${fault.failureRate}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
