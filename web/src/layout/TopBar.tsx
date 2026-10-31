import { Icon } from "./Icon";
import type { JobView } from "../api/apiTypes";
import { useId, type ReactNode } from "react";
import { t } from "../i18n";
import { ViewMenu } from "./ViewMenu";

export interface TopBarProps {
  models: string[];
  model: string | null;
  onModel: (path: string) => void;
  onNewModel: () => void;
  experiments: string[];
  experiment: string | null;
  onExperiment: (path: string) => void;
  onNewExperiment: () => void;
  onInspectExperiment: () => void;
  runSettingsPressed: boolean;
  /** An experiment is being opened. */
  loading: boolean;
  dirty: boolean;
  /** A model-only workspace has a default question that has not been saved yet. */
  savePending?: boolean;
  /** Some field holds a draft that cannot be committed. */
  invalid: boolean;
  /** A version conflict requires reloading before another save. */
  conflict: boolean;
  saving: boolean;
  /** A server outage blocks commands that need the API, with the shared status reason. */
  backendError?: string;
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
  /** A failed save is explained beside Run; another attempt may retry it. */
  runProblem?: string;
  job: JobView | null;
  estimatePanel?: ReactNode;
  fileMenu?: ReactNode;
}

/**
 * Top bar (stage 1 design §6.1): model and its experiment, unsaved changes, save, estimate, run/resume/cancel; job status and backend health belong to the status bar. Switching waits
 * for opening, saving, running and invalid drafts; Run saves valid document edits before submitting.
 */
export function TopBar(props: TopBarProps) {
  const { experiments, experiment, onExperiment, loading, dirty, invalid, conflict, saving, onSave, running, onRun, onCancel, job, canUndo, canRedo, onUndo, onRedo } =
    props;
  const active = job !== null && (job.status === "QUEUED" || job.status === "RUNNING");
  const reasonId = useId();
  const reason = props.backendError ?? (conflict ? t("app.topBar.reloadBeforeRun") : invalid ? t("app.topBar.fixInvalid") : props.runBlockedReason) ?? props.runProblem;
  return (
    <header className="top-bar">
      <h1 title={t("app.name")}>{t("app.name")}</h1>
      {props.fileMenu}
      <span className="top-bar-label">{t("app.topBar.model")}</span>
      <select aria-label={t("app.topBar.model")} value={props.model ?? ""} title={props.model ?? t("app.topBar.noModel")}
        disabled={loading || saving || running || props.estimating || invalid}
        onChange={event => event.target.value === "__create__" ? props.onNewModel() : props.onModel(event.target.value)}>
        {props.model === null ? <option value="">{t("app.topBar.noModel")}</option> : null}
        {props.models.map(path => <option key={path} value={path}>{path.replace(/\.model\.json$/, "")}</option>)}
        <option value="__create__">{t("app.topBar.newModel")}</option>
      </select>
      <span className="top-bar-label">{t("app.topBar.experiment")}</span>
      <select
        aria-label={t("app.topBar.experiment")}
        value={experiment ?? ""}
        title={experiment ?? t("app.topBar.noExperiment")}
        disabled={loading || saving || running || props.estimating || invalid}
        onChange={event => event.target.value === "__create__" ? props.onNewExperiment() : onExperiment(event.target.value)}
      >
        {experiment === null ? <option value="">{t("app.topBar.noExperiment")}</option> : null}
        {experiments.map((path) => (
          <option key={path} value={path}>
            {path.replace(/\.experiment\.json$/, "")}
          </option>
        ))}
        <option value="__create__" disabled={experiment === null}>{t("app.topBar.newExperiment")}</option>
      </select>
      <button type="button" onClick={props.onInspectExperiment} disabled={experiment === null || loading || invalid}
        aria-pressed={props.runSettingsPressed}
        aria-label={t("app.topBar.runSettings")} title={t("app.topBar.runSettings")}>
        <Icon name="settings" />
      </button>
      <button type="button" onClick={onUndo} disabled={!canUndo || invalid || loading} title={t("app.topBar.undoTitle")}>
        {t("app.topBar.undo")}
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo || invalid || loading} title={t("app.topBar.redoTitle")}>
        {t("app.topBar.redo")}
      </button>
      {dirty ? <span className="dirty-mark" title={t("app.topBar.unsavedChanges")}>{t("app.topBar.unsavedChanges")}</span> : null}
      <div className="run-actions">
      <button type="button" onClick={onSave} disabled={(!dirty && !props.savePending) || invalid || conflict || saving || loading || props.backendError !== undefined}
        title={props.backendError ?? t("app.topBar.saveTitle")}>
        {t("app.topBar.save")}
      </button>
      <button type="button" onClick={props.onEstimate}
        disabled={experiment === null || loading || saving || invalid || running || props.estimating || props.backendError !== undefined}
        title={props.backendError}>
        {t("app.estimate.label")}
      </button>
      {/* Keep focus until onRun commits the draft and queues validation. */}
      <button
        type="button"
        className="primary"
        onMouseDown={event => event.preventDefault()}
        onClick={onRun}
        disabled={experiment === null || loading || saving || conflict || invalid || running || props.estimating || props.runBlockedReason !== undefined || props.backendError !== undefined}
        title={reason ?? t("app.topBar.runTitle")}
        aria-describedby={reason === undefined ? undefined : reasonId}
      >
        {t("app.topBar.run")}
      </button>
      {reason === undefined ? null : <span id={reasonId} className="run-blocked-reason" role="status">{reason}</span>}
      {props.canResume ? <button type="button" onClick={props.onResume}
        disabled={loading || saving || dirty || invalid || running || props.estimating}
        title={dirty ? t("app.topBar.saveBeforeResume") : undefined}>{t("app.topBar.resume")}</button> : null}
      {active ? <button type="button" onClick={onCancel} disabled={job.cancelRequested}>{t("app.topBar.cancel")}</button> : null}
      {props.estimatePanel}
      </div>
      <ViewMenu />
    </header>
  );
}
