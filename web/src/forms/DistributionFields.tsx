import { useId } from "react";
import type { DistributionKind, DurationDistribution } from "../api/types";
import { NumberField } from "./NumberField";

interface DistributionFieldsProps {
  label: string;
  name: string;
  distribution: DurationDistribution;
  onChange: (distribution: DurationDistribution) => void;
}

function isDistributionValid(candidate: DurationDistribution): boolean {
  const meanValid =
    Number.isFinite(candidate.meanMs) &&
    (candidate.kind === "FIXED" ? candidate.meanMs >= 0 : candidate.meanMs > 0);
  const stdDevValid =
    candidate.kind === "LOGNORMAL"
      ? candidate.stdDevMs !== null && Number.isFinite(candidate.stdDevMs) && candidate.stdDevMs > 0
      : candidate.stdDevMs === null || Number.isFinite(candidate.stdDevMs);
  return meanValid && stdDevValid;
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
            const candidate: DurationDistribution = {
              ...distribution,
              kind,
              meanMs:
                kind !== "FIXED" && (!Number.isFinite(distribution.meanMs) || distribution.meanMs <= 0)
                  ? 1
                  : distribution.meanMs,
              stdDevMs:
                kind === "LOGNORMAL" &&
                (distribution.stdDevMs === null ||
                  !Number.isFinite(distribution.stdDevMs) ||
                  distribution.stdDevMs <= 0)
                  ? 1
                  : distribution.stdDevMs,
            };
            if (isDistributionValid(candidate)) onChange(candidate);
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
        min={distribution.kind === "LOGNORMAL" ? 0 : undefined}
        positive={distribution.kind === "LOGNORMAL"}
        allowEmpty={distribution.kind !== "LOGNORMAL"}
        hint={distribution.kind === "LOGNORMAL" ? "Required and greater than zero." : "Optional finite value; leave empty for null."}
        errorMessage={distribution.kind === "LOGNORMAL" ? "Must be greater than 0." : "Must be finite or empty."}
        onCommit={(stdDevMs) => onChange({ ...distribution, stdDevMs })}
      />
    </>
  );
}
