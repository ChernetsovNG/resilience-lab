import type { JobView } from "../api/apiTypes";
import { t } from "../i18n";

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
  estimating: boolean;
  onEstimate: () => void;
  canResume: boolean;
  onResume: () => void;
  onCancel: () => void;
  /** Validation errors, an unfinished check or an unavailable validator prevent running. */
  runBlockedReason?: string;
  job: JobView | null;
}

/**
 * Top bar (stage 1 design §6.1): experiment, unsaved changes, save, estimate, run/resume/cancel; job status and backend health belong to the status bar. Switching waits
 * for opening, saving, running and invalid drafts; saving and running wait for valid drafts and saved changes.
 */
export function TopBar(props: TopBarProps) {
  const { experiments, experiment, onExperiment, loading, dirty, invalid, conflict, saving, onSave, running, onRun, onCancel, job, canUndo, canRedo, onUndo, onRedo } =
    props;
  const active = job !== null && (job.status === "QUEUED" || job.status === "RUNNING");
  return (
    <header className="top-bar">
      <h1>{t("app.name")}</h1>
      <span className="top-bar-label">{t("app.topBar.experiment")}</span>
      <select
        aria-label={t("app.topBar.experiment")}
        value={experiment ?? ""}
        disabled={loading || saving || running || props.estimating || invalid}
        onChange={(event) => onExperiment(event.target.value)}
      >
        {experiment === null ? <option value="">{t("app.topBar.noExperiment")}</option> : null}
        {experiments.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </select>
      <button type="button" onClick={onUndo} disabled={!canUndo || invalid || loading} title={t("app.topBar.undoTitle")}>
        {t("app.topBar.undo")}
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo || invalid || loading} title={t("app.topBar.redoTitle")}>
        {t("app.topBar.redo")}
      </button>
      {dirty ? <span className="dirty-mark">{t("app.topBar.unsavedChanges")}</span> : null}
      <button type="button" onClick={onSave} disabled={!dirty || invalid || conflict || saving || loading}>
        {t("app.topBar.save")}
      </button>
      <button type="button" onClick={props.onEstimate}
        disabled={experiment === null || loading || saving || invalid || running || props.estimating}>
        {t("app.estimate.label")}
      </button>
      <button
        type="button"
        className="primary"
        onClick={onRun}
        disabled={experiment === null || loading || saving || dirty || invalid || running || props.estimating || props.runBlockedReason !== undefined}
        title={props.runBlockedReason ?? (invalid ? t("app.topBar.fixInvalid") : dirty ? t("app.topBar.saveBeforeRun") : undefined)}
      >
        {t("app.topBar.run")}
      </button>
      {props.canResume ? <button type="button" onClick={props.onResume}
        disabled={loading || saving || dirty || invalid || running || props.estimating}
        title={dirty ? t("app.topBar.saveBeforeResume") : undefined}>{t("app.topBar.resume")}</button> : null}
      {active ? <button type="button" onClick={onCancel} disabled={job.cancelRequested}>{t("app.topBar.cancel")}</button> : null}
    </header>
  );
}
