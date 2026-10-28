import type { HealthView, JobView } from "../api/apiTypes";
import { HealthBadge } from "../components/HealthBadge";

export interface TopBarProps {
  experiments: string[];
  experiment: string | null;
  onExperiment: (path: string) => void;
  /** An experiment is being opened. */
  loading: boolean;
  dirty: boolean;
  /** Some field holds a draft that cannot be committed. */
  invalid: boolean;
  /** A version conflict requires reloading before another save. */
  conflict: boolean;
  saving: boolean;
  onSave: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  running: boolean;
  onRun: () => void;
  onCancel: () => void;
  /** Validation errors, an unfinished check or an unavailable validator prevent running. */
  runBlockedReason?: string;
  job: JobView | null;
  health: HealthView | null;
  healthError: string | null;
}

/**
 * Top bar (stage 1 design §6.1): experiment, unsaved changes, save, run/cancel, job status, backend health. Switching waits
 * for opening, saving, running and invalid drafts; saving and running wait for valid drafts and saved changes.
 */
export function TopBar(props: TopBarProps) {
  const { experiments, experiment, onExperiment, loading, dirty, invalid, conflict, saving, onSave, running, onRun, onCancel, job, health, healthError, canUndo, canRedo, onUndo, onRedo } =
    props;
  const active = job !== null && (job.status === "QUEUED" || job.status === "RUNNING");
  return (
    <header className="top-bar">
      <h1>Resilience Lab</h1>
      <span className="top-bar-label">Experiment</span>
      <select
        aria-label="Experiment"
        value={experiment ?? ""}
        disabled={loading || saving || running || invalid}
        onChange={(event) => onExperiment(event.target.value)}
      >
        {experiment === null ? <option value="">No experiment</option> : null}
        {experiments.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </select>
      <button type="button" onClick={onUndo} disabled={!canUndo || invalid || loading} title="Undo (Ctrl/Cmd+Z)">
        Undo
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo || invalid || loading} title="Redo (Ctrl/Cmd+Shift+Z or Ctrl+Y)">
        Redo
      </button>
      {dirty ? <span className="dirty-mark">Unsaved changes</span> : null}
      <button type="button" onClick={onSave} disabled={!dirty || invalid || conflict || saving || loading}>
        Save
      </button>
      <button
        type="button"
        className="primary"
        onClick={onRun}
        disabled={experiment === null || loading || saving || dirty || invalid || running || props.runBlockedReason !== undefined}
        title={props.runBlockedReason ?? (invalid ? "Fix invalid values first" : dirty ? "Save changes before running" : undefined)}
      >
        Run
      </button>
      {active ? <button type="button" onClick={onCancel} disabled={job.cancelRequested}>Cancel</button> : null}
      <span className="job-status" data-testid="job-status">
        {job === null ? "" : `${job.status}${active && job.cancelRequested ? " · cancellation requested" : ""}`}
      </span>
      <span className="spacer" />
      <HealthBadge health={health} error={healthError} />
    </header>
  );
}
