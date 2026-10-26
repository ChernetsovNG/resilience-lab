import type { ExperimentJob } from "../api/types";

interface JobStatusProps {
  job: ExperimentJob | null;
  isRunning: boolean;
  error?: string | null;
}

export function JobStatus({ job, isRunning, error }: JobStatusProps) {
  return (
    <div className="job-status">
      <div role="status" data-testid="job-status">
        {job?.status ?? (isRunning ? "Submitting experiment…" : "Not started")}
      </div>
      {error ? <div role="alert">{error}</div> : null}
    </div>
  );
}
