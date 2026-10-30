import type { JobView } from "../api/apiTypes";
import type { ReactNode } from "react";
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
  estimatePanel?: ReactNode;
  fileMenu?: ReactNode;
}

/**
 * Top bar (stage 1 design §6.1): model and its experiment, unsaved changes, save, estimate, run/resume/cancel; job status and backend health belong to the status bar. Switching waits
 * for opening, saving, running and invalid drafts; saving and running wait for valid drafts and saved changes.
 */
export function TopBar(props: TopBarProps) {
  const { experiments, experiment, onExperiment, loading, dirty, invalid, conflict, saving, onSave, running, onRun, onCancel, job, canUndo, canRedo, onUndo, onRedo } =
    props;
  const active = job !== null && (job.status === "QUEUED" || job.status === "RUNNING");
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
            {path}
          </option>
        ))}
        <option value="__create__" disabled={experiment === null}>{t("app.topBar.newExperiment")}</option>
      </select>
      <button type="button" onClick={props.onInspectExperiment} disabled={experiment === null || loading || invalid}
        aria-pressed={props.runSettingsPressed}
        aria-label={t("app.topBar.runSettings")} title={t("app.topBar.runSettings")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M10 2h4l.6 3 2.1 1.2 2.9-1 2 3.5-2.3 2v2.6l2.3 2-2 3.5-2.9-1-2.1 1.2L14 22h-4l-.6-3-2.1-1.2-2.9 1-2-3.5 2.3-2v-2.6l-2.3-2 2-3.5 2.9 1L9.4 5Z" />
        </svg>
      </button>
      <button type="button" onClick={onUndo} disabled={!canUndo || invalid || loading} title={t("app.topBar.undoTitle")}>
        {t("app.topBar.undo")}
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo || invalid || loading} title={t("app.topBar.redoTitle")}>
        {t("app.topBar.redo")}
      </button>
      {dirty ? <span className="dirty-mark" title={t("app.topBar.unsavedChanges")}>{t("app.topBar.unsavedChanges")}</span> : null}
      <button type="button" onClick={onSave} disabled={(!dirty && !props.savePending) || invalid || conflict || saving || loading}>
        {t("app.topBar.save")}
      </button>
      <div className="run-actions">
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
      {props.estimatePanel}
      </div>
      <ViewMenu />
    </header>
  );
}
