import type { Diagnostic, HealthView, JobView } from "../api/apiTypes";
import { HealthBadge } from "../components/HealthBadge";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";

export interface StatusBarProps {
  job: JobView | null;
  health: HealthView | null;
  healthError: string | null;
  diagnostics: readonly Diagnostic[];
  stale: boolean;
  cursorMs: number | null;
  zoom: number | null;
  onProblems: () => void;
}

/** Persistent status for the current experiment; commands remain in the top bar. */
export function StatusBar({ job, health, healthError, diagnostics, stale, cursorMs, zoom, onProblems }: StatusBarProps) {
  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "ERROR").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "WARNING").length;
  const status = job === null ? t("status.ready") : t(`app.job.status.${job.status}`);
  return (
    <footer className="status-bar" role="region" aria-label={t("status.title")}>
      <span data-testid="job-status" role="status">{active && job !== null ? t("status.progress", {
        status, completed: formatNumber(job.completedTasks), total: job.totalTasks === 0 ? t("results.unknownTotal") : formatNumber(job.totalTasks),
        cancelling: job.cancelRequested ? t("results.cancellationRequested") : "",
      }) : status}</span>
      <button type="button" className={errors > 0 ? "diagnostic--error" : warnings > 0 ? "diagnostic--warning" : undefined} onClick={onProblems}>
        {t("status.problems", { errors: formatNumber(errors), warnings: formatNumber(warnings) })}
      </button>
      {stale ? <span className="canvas-results-stale">{t("status.stale")}</span> : null}
      {cursorMs === null ? null : <span>{t("status.cursor", { time: formatDuration(cursorMs) })}</span>}
      <span className="spacer" />
      <div className="status-backend" title={healthError ?? undefined}><HealthBadge health={health} error={healthError} /></div>
      {zoom === null ? null : <span>{t("status.zoom", { zoom: formatPercent(zoom) })}</span>}
    </footer>
  );
}
