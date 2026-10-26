import type { Execution } from "../api/types";
import { NumberField } from "./NumberField";

interface ExecutionInspectorProps {
  execution: Execution;
  onChange: (patch: Partial<Execution>) => void;
}

export function ExecutionInspector({ execution, onChange }: ExecutionInspectorProps) {
  return (
    <form className="parameter-form" aria-label="Execution parameters" onSubmit={(event) => event.preventDefault()}>
      <fieldset>
        <legend>Execution</legend>
        <NumberField
          label="Replications"
          name="replications"
          value={execution.replications}
          min={1}
          max={2_147_483_647}
          integer
          hint="Integer greater than zero."
          errorMessage="Must be an integer greater than 0."
          onCommit={(replications) => {
            if (replications !== null) onChange({ replications });
          }}
        />
        <NumberField
          label="Warm-up (ms)"
          name="warmupMs"
          value={execution.warmupMs}
          min={0}
          hint="Non-negative; warm-up plus measurement must be finite."
          errorMessage="Must be non-negative and keep warm-up plus measurement finite."
          isValid={(warmupMs) => Number.isFinite(warmupMs + execution.measurementMs)}
          onCommit={(warmupMs) => {
            if (warmupMs !== null) onChange({ warmupMs });
          }}
        />
        <NumberField
          label="Measurement (ms)"
          name="measurementMs"
          value={execution.measurementMs}
          min={0}
          positive
          hint="Positive; warm-up plus measurement must be finite."
          errorMessage="Must be positive and keep warm-up plus measurement finite."
          isValid={(measurementMs) => Number.isFinite(execution.warmupMs + measurementMs)}
          onCommit={(measurementMs) => {
            if (measurementMs !== null) onChange({ measurementMs });
          }}
        />
        <NumberField
          label="Seed"
          name="seed"
          value={execution.seed}
          min={-Number.MAX_SAFE_INTEGER}
          max={Number.MAX_SAFE_INTEGER}
          integer
          hint="Safe integer used to reproduce random streams."
          errorMessage="Must be a safe integer."
          onCommit={(seed) => {
            if (seed !== null) onChange({ seed });
          }}
        />
        <NumberField
          label="Maximum real time (seconds)"
          name="maxRealTimeSeconds"
          value={execution.maxRealTimeSeconds}
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          integer
          hint="Positive integer cap per replication."
          errorMessage="Must be an integer greater than 0."
          onCommit={(maxRealTimeSeconds) => {
            if (maxRealTimeSeconds !== null) onChange({ maxRealTimeSeconds });
          }}
        />
      </fieldset>
    </form>
  );
}
