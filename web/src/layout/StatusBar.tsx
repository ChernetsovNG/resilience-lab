import { useId, useImperativeHandle, useState, type Ref } from "react";
import { HelpHint } from "../help/HelpHint";
import type { Diagnostic, HealthView, JobView } from "../api/apiTypes";
import { HealthBadge } from "../components/HealthBadge";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatPercent } from "../i18n/format";
import { groupDiagnostics } from "../validation/diagnostics";

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

/** Own frequent viewport updates without rendering the editor that supplies the other status fields. */
export function ZoomStatusBar({ ref, hasModel, ...props }: Omit<StatusBarProps, "zoom"> & {
  ref: Ref<(zoom: number) => void>; hasModel: boolean;
}) {
  const [zoom, setZoom] = useState<number | null>(null);
  useImperativeHandle(ref, () => setZoom, []);
  return <StatusBar {...props} zoom={hasModel ? zoom : null} />;
}

/** Persistent status for the current experiment; commands remain in the top bar. */
export function StatusBar({ job, health, healthError, diagnostics, stale, cursorMs, zoom, onProblems }: StatusBarProps) {
  const hintId = useId();
  const active = job?.status === "QUEUED" || job?.status === "RUNNING";
  const groups = groupDiagnostics(diagnostics);
  const errors = groups.filter(({ diagnostic }) => diagnostic.severity === "ERROR").length;
  const warnings = groups.filter(({ diagnostic }) => diagnostic.severity === "WARNING").length;
  const status = job === null ? t("status.ready") : t(`app.job.status.${job.status}`);
  const progress = active && job !== null ? t("status.progress", {
    status, completed: formatNumber(job.completedTasks), total: job.totalTasks === 0 ? t("results.unknownTotal") : formatNumber(job.totalTasks),
    cancelling: job.cancelRequested ? t("results.cancellationRequested") : "",
  }) : status;
  const problems = t("status.problems", { errors: formatNumber(errors), warnings: formatNumber(warnings) });
  const cursor = cursorMs === null ? null : t("status.cursor", { time: formatDuration(cursorMs) });
  const scale = zoom === null ? null : t("status.zoom", { zoom: formatPercent(zoom) });
  return (
    <footer className="status-bar" role="region" aria-label={t("status.title")}>
      <div className="status-job">
        <span data-testid="job-status" role="status" aria-describedby={active ? hintId : undefined}>{progress}</span>
        {active && job !== null ? <HelpHint id={hintId} label={t("app.estimate.tasks")}>
          {job.totalTasks === 0 ? t("help.tasks.unknown") : t("help.tasks.progress", {
            completed: formatNumber(job.completedTasks), total: formatNumber(job.totalTasks),
          })}{" "}{t("help.tasks")}
        </HelpHint> : null}
      </div>
      <button type="button" title={problems} className={errors > 0 ? "diagnostic--error" : warnings > 0 ? "diagnostic--warning" : undefined} onClick={onProblems}>
        {problems}
      </button>
      {stale ? <span className="canvas-results-stale" title={t("status.stale")}>{t("status.stale")}</span> : null}
      {cursor === null ? null : <span title={cursor}>{cursor}</span>}
      <span className="spacer" />
      <div className="status-backend" title={healthError ?? undefined}><HealthBadge health={health} error={healthError} /></div>
      {scale === null ? null : <span title={scale}>{scale}</span>}
    </footer>
  );
}
