import { useEffect, useId, useState } from "react";
import type { SweepParameter, SweepSpec } from "../api/types";

interface SweepControlsProps {
  onChange: (sweep: SweepSpec) => void;
  appliedSweep?: SweepSpec | null;
  onDraftStateChange?: (canRun: boolean) => void;
}

const parameters: { value: SweepParameter; label: string }[] = [
  { value: "ARRIVAL_RATE", label: "Arrival rate" },
  { value: "LINK_TIMEOUT", label: "Link timeout" },
  { value: "MAX_ATTEMPTS", label: "Max attempts" },
  { value: "BACKOFF_BASE", label: "Backoff base" },
  { value: "DEGRADATION_MULTIPLIER", label: "Degradation multiplier" },
];

function validateValue(parameter: SweepParameter, value: number): string | null {
  if (parameter === "MAX_ATTEMPTS") {
    if (!Number.isInteger(value)) return "Max attempts values must be integers.";
    if (value < 1 || value > 2_147_483_647) return "Max attempts values must be in 1..2147483647.";
    return null;
  }
  if (parameter === "BACKOFF_BASE" && value < 0) {
    return "Backoff base values must be non-negative.";
  }
  if (parameter !== "BACKOFF_BASE" && value <= 0) {
    return "Sweep values must be greater than zero for this parameter.";
  }
  if (parameter === "ARRIVAL_RATE" && (!Number.isFinite(1 / value) || 1 / value <= 0)) {
    return "Arrival rate must produce a finite, strictly positive interarrival mean.";
  }
  return null;
}

function readDraft(
  parameter: SweepParameter,
  target: string,
  valueList: string,
): { sweep: SweepSpec | null; error: string | null } {
  const parts = valueList.split(",").map((value) => value.trim());
  const values = parts.map(Number);
  if (parts.some((value) => value === "") || values.some((value) => !Number.isFinite(value))) {
    return { sweep: null, error: "Sweep values must be valid finite numbers." };
  }
  for (const value of values) {
    const valueError = validateValue(parameter, value);
    if (valueError !== null) return { sweep: null, error: valueError };
  }
  const needsLink = parameter === "LINK_TIMEOUT" || parameter === "MAX_ATTEMPTS" || parameter === "BACKOFF_BASE";
  const needsService = parameter === "DEGRADATION_MULTIPLIER";
  if ((needsLink || needsService) && target.trim() === "") {
    return { sweep: null, error: `${needsLink ? "Link" : "Service"} ID is required for this parameter.` };
  }
  return {
    sweep: {
      parameter,
      serviceId: needsService ? target.trim() : null,
      linkId: needsLink ? target.trim() : null,
      values,
    },
    error: null,
  };
}

function sameSweep(left: SweepSpec, right: SweepSpec): boolean {
  return left.parameter === right.parameter &&
    left.serviceId === right.serviceId &&
    left.linkId === right.linkId &&
    left.values.length === right.values.length &&
    left.values.every((value, index) => value === right.values[index]);
}

export function SweepControls({ onChange, appliedSweep, onDraftStateChange }: SweepControlsProps) {
  const id = useId();
  const [parameter, setParameter] = useState<SweepParameter>("ARRIVAL_RATE");
  const [target, setTarget] = useState("");
  const [valueList, setValueList] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsLink = parameter === "LINK_TIMEOUT" || parameter === "MAX_ATTEMPTS" || parameter === "BACKOFF_BASE";
  const needsService = parameter === "DEGRADATION_MULTIPLIER";
  const needsTarget = needsLink || needsService;
  const draft = readDraft(parameter, target, valueList);
  const canRun = draft.sweep !== null && appliedSweep !== null && appliedSweep !== undefined &&
    sameSweep(draft.sweep, appliedSweep);

  useEffect(() => {
    onDraftStateChange?.(canRun);
  }, [canRun, onDraftStateChange]);

  const apply = () => {
    if (draft.sweep === null) {
      setError(draft.error);
      return;
    }
    setError(null);
    onChange(draft.sweep);
  };

  return (
    <form
      className="sweep-controls"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div>
        <label htmlFor={`${id}-parameter`}>Sweep parameter</label>
        <select
          id={`${id}-parameter`}
          name="sweepParameter"
          value={parameter}
          onChange={(event) => {
            setParameter(event.target.value as SweepParameter);
            setError(null);
          }}
        >
          {parameters.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {needsTarget ? (
        <div>
          <label htmlFor={`${id}-target`}>{needsLink ? "Link ID" : "Service ID"}</label>
          <input
            id={`${id}-target`}
            name="sweepTarget"
            value={target}
            required
            onChange={(event) => {
              setTarget(event.target.value);
              setError(null);
            }}
          />
        </div>
      ) : null}
      <div>
        <label htmlFor={`${id}-values`}>Sweep values</label>
        <input
          id={`${id}-values`}
          name="sweepValues"
          inputMode="decimal"
          value={valueList}
          required
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setValueList(event.target.value);
            setError(null);
          }}
        />
      </div>
      {error ? <div id={`${id}-error`} role="alert">{error}</div> : null}
      <button type="submit">Apply sweep</button>
    </form>
  );
}
