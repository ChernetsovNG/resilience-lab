import type { CSSProperties } from "react";
import type { Catalog } from "../api/apiTypes";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { Icon, type IconName } from "../layout/Icon";
import type { Params } from "../workspace/params";
import type { PolicyWindowState } from "../results/policyState";
import { canvasPolicyPaths, policyStateDescription } from "./policyPresentation";
import "./PolicyBadges.css";

const icons: Record<string, IconName> = {
  circuitBreaker: "circuit-breaker", fallback: "fallback", retryBudget: "retry-budget",
  outlierDetection: "outlier-detection", rateLimit: "rate-limit", healthCheck: "health-check",
};

/** Two icons and an overflow keep policies outside the measured node and connection label. */
export function PolicyBadges({ id, type, params, catalog, targetGroup, disabled, onOpen, className = "", style, state, copies, replicaOverrides, owner = id }: {
  id: string; type: string; params: Params; catalog: Catalog; targetGroup?: boolean; disabled?: boolean;
  onOpen: (path: string) => void; className?: string; style?: CSSProperties;
  state?: PolicyWindowState; copies?: number;
  replicaOverrides?: Record<string, Params> | null;
  owner?: string;
}) {
  const enabled = canvasPolicyPaths(type, params, targetGroup, replicaOverrides);
  if (enabled.length === 0) return null;
  const title = (policy: string) => catalog.types.find(entry => entry.id === type)?.params.find(param => param.name === policy)?.title ?? policy;
  const badge = ({ policy, path }: (typeof enabled)[number]) => <button key={policy} type="button" aria-label={title(policy)}
    title={[owner, title(policy), policyStateDescription(state, copies)].filter(Boolean).join(" · ")} disabled={disabled}
    className={policy === "circuitBreaker" && (state?.circuitOpenShare ?? 0) > 0 ? "policy-badge--active" : undefined}
    onClick={event => {
      event.stopPropagation();
      event.currentTarget.closest("details")?.removeAttribute("open");
      onOpen(path);
    }}><Icon name={icons[policy]} size={16} /></button>;
  return <div className={`policy-badges nodrag nopan ${className}`} style={style} data-testid={`canvas-policies-${id}`} role="group" aria-label={owner}
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    {enabled.slice(0, 2).map(badge)}
    {enabled.length <= 2 ? null : <details className="policy-badges-more">
      <summary title={enabled.map(({ policy }) => title(policy)).join(", ")} aria-label={t("editor.canvas.morePolicies", { count: formatNumber(enabled.length - 2) })}>
        {t("editor.canvas.policyOverflow", { count: formatNumber(enabled.length - 2) })}
      </summary>
      <div>{enabled.slice(2).map(entry => <span key={entry.policy}>{badge(entry)}<span>{title(entry.policy)}</span></span>)}</div>
    </details>}
  </div>;
}
