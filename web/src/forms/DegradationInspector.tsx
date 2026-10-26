import type { DegradationSpec } from "../api/types";
import { NumberField } from "./NumberField";

interface DegradationInspectorProps {
  degradation: DegradationSpec | null;
  serviceIds: string[];
  onChange: (degradation: DegradationSpec | null) => void;
}

export function DegradationInspector({ degradation, serviceIds, onChange }: DegradationInspectorProps) {
  const update = (patch: Partial<DegradationSpec>) => {
    if (degradation !== null) onChange({ ...degradation, ...patch });
  };

  return (
    <form className="parameter-form" aria-label="Degradation parameters" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend>Degradation</legend>
        <div className="parameter-field parameter-field--checkbox">
          <input
            id="degradation-enabled"
            name="degradationEnabled"
            type="checkbox"
            checked={degradation !== null}
            disabled={serviceIds.length === 0}
            onChange={(event) => {
              onChange(
                event.target.checked
                  ? {
                      serviceId: serviceIds[0],
                      startMs: 0,
                      endMs: 1_000,
                      processingMultiplier: 1,
                      failureRate: null,
                    }
                  : null,
              );
            }}
          />
          <label htmlFor="degradation-enabled">Enable degradation</label>
        </div>
        {degradation ? (
          <>
            <div className="parameter-field">
              <label htmlFor="degraded-service">Degraded service</label>
              <select
                id="degraded-service"
                name="degradedService"
                value={degradation.serviceId}
                onChange={(event) => update({ serviceId: event.target.value })}
              >
                {serviceIds.map((serviceId) => (
                  <option key={serviceId} value={serviceId}>
                    {serviceId}
                  </option>
                ))}
              </select>
            </div>
            <NumberField
              label="Degradation start (ms)"
              name="degradationStartMs"
              value={degradation.startMs}
              hint="Finite and earlier than the end."
              errorMessage="Must be finite and earlier than the end."
              isValid={(startMs) => startMs < degradation.endMs}
              onCommit={(startMs) => {
                if (startMs !== null) update({ startMs });
              }}
            />
            <NumberField
              label="Degradation end (ms)"
              name="degradationEndMs"
              value={degradation.endMs}
              hint="Finite and later than the start."
              errorMessage="Must be finite and greater than startMs."
              isValid={(endMs) => degradation.startMs < endMs}
              onCommit={(endMs) => {
                if (endMs !== null) update({ endMs });
              }}
            />
            <NumberField
              label="Processing multiplier"
              name="processingMultiplier"
              value={degradation.processingMultiplier}
              min={0}
              positive
              hint="Finite and greater than zero."
              errorMessage="Must be greater than 0."
              onCommit={(processingMultiplier) => {
                if (processingMultiplier !== null) update({ processingMultiplier });
              }}
            />
            <NumberField
              label="Degradation failure rate"
              name="degradationFailureRate"
              value={degradation.failureRate}
              min={0}
              max={1}
              allowEmpty
              hint="Optional probability from 0 through 1; empty means no override."
              errorMessage="Must be empty or between 0 and 1."
              onCommit={(failureRate) => update({ failureRate })}
            />
          </>
        ) : null}
      </fieldset>
    </form>
  );
}
