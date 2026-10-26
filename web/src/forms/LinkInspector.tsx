import type { LinkSpec, RetryKind } from "../api/types";
import { DistributionFields } from "./DistributionFields";
import { NumberField } from "./NumberField";

interface LinkInspectorProps {
  link: LinkSpec;
  onChange: (patch: Partial<LinkSpec>) => void;
}

export function LinkInspector({ link, onChange }: LinkInspectorProps) {
  const updateRetry = (patch: Partial<LinkSpec["retry"]>) => onChange({ retry: { ...link.retry, ...patch } });

  return (
    <form className="parameter-form" aria-label="Link parameters" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend>Link {link.id}</legend>
        <DistributionFields
          label="Network"
          name="network"
          distribution={link.network}
          onChange={(network) => onChange({ network })}
        />
        <NumberField
          label="Timeout (ms)"
          name="timeoutMs"
          value={link.timeoutMs}
          min={0}
          positive
          hint="Finite duration greater than zero."
          errorMessage="Must be greater than 0."
          onCommit={(timeoutMs) => {
            if (timeoutMs !== null) onChange({ timeoutMs });
          }}
        />
        <NumberField
          label="Maximum attempts"
          name="maxAttempts"
          value={link.maxAttempts}
          min={1}
          max={2_147_483_647}
          integer
          hint="Integer greater than zero, including the initial attempt."
          errorMessage="Must be an integer greater than 0."
          onCommit={(maxAttempts) => {
            if (maxAttempts !== null) onChange({ maxAttempts });
          }}
        />
        <div className="parameter-field">
          <label htmlFor={`${link.id}-retry-kind`}>Retry kind</label>
          <select
            id={`${link.id}-retry-kind`}
            name="retryKind"
            value={link.retry.kind}
            onChange={(event) => updateRetry({ kind: event.target.value as RetryKind })}
          >
            <option value="NONE">None</option>
            <option value="FIXED">Fixed</option>
            <option value="EXPONENTIAL_FULL_JITTER">Exponential with full jitter</option>
          </select>
        </div>
        <NumberField
          label="Base backoff (ms)"
          name="baseBackoffMs"
          value={link.retry.baseBackoffMs}
          min={0}
          hint="Finite, zero or greater."
          errorMessage="Must be zero or greater."
          onCommit={(baseBackoffMs) => {
            if (baseBackoffMs !== null) updateRetry({ baseBackoffMs });
          }}
        />
        <NumberField
          label="Maximum backoff (ms)"
          name="maxBackoffMs"
          value={link.retry.maxBackoffMs}
          min={0}
          hint="Finite, zero or greater."
          errorMessage="Must be zero or greater."
          onCommit={(maxBackoffMs) => {
            if (maxBackoffMs !== null) updateRetry({ maxBackoffMs });
          }}
        />
        <NumberField
          label="Retry base"
          name="retryBase"
          value={link.retry.base}
          min={0}
          positive
          hint="Finite and greater than zero."
          errorMessage="Must be greater than 0."
          onCommit={(base) => {
            if (base !== null) updateRetry({ base });
          }}
        />
      </fieldset>
    </form>
  );
}
