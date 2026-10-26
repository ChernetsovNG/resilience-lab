import { useId } from "react";
import type { DistributionKind, DurationDistribution } from "../api/types";
import { NumberField } from "./NumberField";

interface DistributionFieldsProps {
  label: string;
  name: string;
  distribution: DurationDistribution;
  onChange: (distribution: DurationDistribution) => void;
}

export function DistributionFields({ label, name, distribution, onChange }: DistributionFieldsProps) {
  const id = useId();

  return (
    <>
      <div className="parameter-field">
        <label htmlFor={`${id}-kind`}>{label} kind</label>
        <select
          id={`${id}-kind`}
          name={`${name}Kind`}
          value={distribution.kind}
          onChange={(event) => {
            const kind = event.target.value as DistributionKind;
            onChange({
              ...distribution,
              kind,
              stdDevMs: kind === "LOGNORMAL" ? (distribution.stdDevMs ?? 1) : distribution.stdDevMs,
            });
          }}
        >
          <option value="FIXED">Fixed</option>
          <option value="EXPONENTIAL">Exponential</option>
          <option value="LOGNORMAL">Lognormal</option>
        </select>
      </div>
      <NumberField
        label={`${label} mean (ms)`}
        name={`${name}MeanMs`}
        value={distribution.meanMs}
        min={0}
        positive={distribution.kind !== "FIXED"}
        hint={distribution.kind === "FIXED" ? "Finite, zero or greater." : "Finite and greater than zero."}
        errorMessage={distribution.kind === "FIXED" ? "Must be zero or greater." : "Must be greater than 0."}
        onCommit={(meanMs) => {
          if (meanMs !== null) onChange({ ...distribution, meanMs });
        }}
      />
      <NumberField
        label={`${label} standard deviation (ms)`}
        name={`${name}StdDevMs`}
        value={distribution.stdDevMs}
        min={0}
        positive={distribution.kind === "LOGNORMAL"}
        allowEmpty={distribution.kind !== "LOGNORMAL"}
        hint={distribution.kind === "LOGNORMAL" ? "Required and greater than zero." : "Optional; leave empty for null."}
        errorMessage={distribution.kind === "LOGNORMAL" ? "Must be greater than 0." : "Must be zero or greater or empty."}
        onCommit={(stdDevMs) => onChange({ ...distribution, stdDevMs })}
      />
    </>
  );
}
