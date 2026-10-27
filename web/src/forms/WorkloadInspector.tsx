import { useState } from "react";
import type { WorkloadSpec } from "../api/types";
import { arrivalRateToRps, rpsToArrivalRate } from "../scenario/arrivalRate";
import { NumberField } from "./NumberField";

interface WorkloadInspectorProps {
  workload: WorkloadSpec;
  onChange: (patch: Partial<WorkloadSpec>) => void;
}

export function WorkloadInspector({ workload, onChange }: WorkloadInspectorProps) {
  const [committedRps, setCommittedRps] = useState<number | null>(null);
  // Preserve the entered RPS while the stored rate echoes back with floating-point noise.
  const rps = committedRps !== null && rpsToArrivalRate(committedRps) === workload.arrivalRate
    ? committedRps
    : arrivalRateToRps(workload.arrivalRate);

  return (
    <form className="parameter-form" aria-label="Workload parameters" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend>Workload</legend>
        <NumberField
          label="Arrival rate (RPS)"
          name="arrivalRate"
          value={rps}
          min={0}
          positive
          hint="Requests per second; must give a finite interarrival mean."
          errorMessage="Must be positive with a finite interarrival mean."
          isValid={(rps) => {
            const meanMs = 1 / rpsToArrivalRate(rps);
            return Number.isFinite(meanMs) && meanMs > 0;
          }}
          onCommit={(rps) => {
            if (rps !== null) {
              setCommittedRps(rps);
              onChange({ arrivalRate: rpsToArrivalRate(rps) });
            }
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
