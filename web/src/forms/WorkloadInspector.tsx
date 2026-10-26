import type { WorkloadSpec } from "../api/types";
import { NumberField } from "./NumberField";

interface WorkloadInspectorProps {
  workload: WorkloadSpec;
  onChange: (patch: Partial<WorkloadSpec>) => void;
}

export function WorkloadInspector({ workload, onChange }: WorkloadInspectorProps) {
  return (
    <form className="parameter-form" aria-label="Workload parameters" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend>Workload</legend>
        <NumberField
          label="Arrival rate"
          name="arrivalRate"
          value={workload.arrivalRate}
          min={0}
          positive
          hint="Positive rate with a finite interarrival mean."
          errorMessage="Must be positive with a finite interarrival mean."
          isValid={(arrivalRate) => Number.isFinite(1 / arrivalRate) && 1 / arrivalRate > 0}
          onCommit={(arrivalRate) => {
            if (arrivalRate !== null) onChange({ arrivalRate });
          }}
        />
        <NumberField
          label="Request deadline (ms)"
          name="requestDeadlineMs"
          value={workload.requestDeadlineMs}
          min={0}
          positive
          hint="Finite duration greater than zero."
          errorMessage="Must be greater than 0."
          onCommit={(requestDeadlineMs) => {
            if (requestDeadlineMs !== null) onChange({ requestDeadlineMs });
          }}
        />
      </fieldset>
    </form>
  );
}
