import { useId, useState } from "react";
import type { SweepParameter, SweepSpec } from "../api/types";

interface SweepControlsProps {
  onChange: (sweep: SweepSpec) => void;
}

const parameters: { value: SweepParameter; label: string }[] = [
  { value: "ARRIVAL_RATE", label: "Arrival rate" },
  { value: "LINK_TIMEOUT", label: "Link timeout" },
  { value: "MAX_ATTEMPTS", label: "Max attempts" },
  { value: "BACKOFF_BASE", label: "Backoff base" },
  { value: "DEGRADATION_MULTIPLIER", label: "Degradation multiplier" },
];

export function SweepControls({ onChange }: SweepControlsProps) {
  const id = useId();
  const [parameter, setParameter] = useState<SweepParameter>("ARRIVAL_RATE");
  const [target, setTarget] = useState("");
  const [valueList, setValueList] = useState("");
  const [error, setError] = useState<string | null>(null);
  const needsLink = parameter === "LINK_TIMEOUT" || parameter === "MAX_ATTEMPTS" || parameter === "BACKOFF_BASE";
  const needsService = parameter === "DEGRADATION_MULTIPLIER";
  const needsTarget = needsLink || needsService;

  const apply = () => {
    const parts = valueList.split(",").map((value) => value.trim());
    const values = parts.map(Number);
    if (parts.some((value) => value === "") || values.some((value) => !Number.isFinite(value))) {
      setError("Sweep values must be valid finite numbers.");
      return;
    }
    if (parameter === "MAX_ATTEMPTS" && values.some((value) => !Number.isInteger(value))) {
      setError("Max attempts values must be integers.");
      return;
    }
    if (needsTarget && target.trim() === "") {
      setError(`${needsLink ? "Link" : "Service"} ID is required for this parameter.`);
      return;
    }
    setError(null);
    onChange({
      parameter,
      serviceId: needsService ? target.trim() : null,
      linkId: needsLink ? target.trim() : null,
      values,
    });
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
