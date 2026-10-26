import { useId, useState } from "react";
import { parseFiniteNumber } from "./numberInput";

interface NumberFieldProps {
  label: string;
  name: string;
  value: number | null;
  min?: number;
  max?: number;
  integer?: boolean;
  positive?: boolean;
  allowEmpty?: boolean;
  hint: string;
  errorMessage: string;
  isValid?: (value: number) => boolean;
  onCommit: (value: number | null) => void;
}

export function NumberField({
  label,
  name,
  value,
  min,
  max,
  integer = false,
  positive = false,
  allowEmpty = false,
  hint,
  errorMessage,
  isValid,
  onCommit,
}: NumberFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [raw, setRaw] = useState(value === null ? "" : String(value));
  const [blurred, setBlurred] = useState(false);
  const [previousValue, setPreviousValue] = useState(value);

  if (previousValue !== value) {
    setPreviousValue(value);
    setRaw(value === null ? "" : String(value));
    setBlurred(false);
  }

  const validate = (candidate: string): boolean => {
    if (candidate.trim() === "") return allowEmpty;
    const parsed = parseFiniteNumber(candidate);
    return (
      parsed !== null &&
      (min === undefined || parsed >= min) &&
      (max === undefined || parsed <= max) &&
      (!positive || parsed > 0) &&
      (!integer || Number.isSafeInteger(parsed)) &&
      (isValid === undefined || isValid(parsed))
    );
  };
  const valid = validate(raw);
  const showError = blurred && !valid;

  return (
    <div className="parameter-field">
      <label htmlFor={id}>{label}</label>
      <span id={hintId} className="parameter-hint">
        {hint}
      </span>
      <input
        id={id}
        name={name}
        type="number"
        inputMode="decimal"
        required={!allowEmpty}
        min={positive ? Number.MIN_VALUE : min}
        max={max}
        step={integer ? 1 : "any"}
        value={raw}
        aria-describedby={showError ? `${hintId} ${errorId}` : hintId}
        aria-errormessage={showError ? errorId : undefined}
        aria-invalid={showError ? true : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          setBlurred(false);
          if (!validate(next)) return;
          onCommit(next.trim() === "" ? null : parseFiniteNumber(next));
        }}
        onBlur={() => setBlurred(true)}
      />
      {showError ? (
        <span id={errorId} className="parameter-error" role="alert">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
