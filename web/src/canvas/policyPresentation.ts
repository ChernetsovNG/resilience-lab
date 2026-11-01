import { t } from "../i18n";
import { formatNumber, formatPercent } from "../i18n/format";
import type { PolicyWindowState } from "../results/policyState";
import { isObject, type Params } from "../workspace/params";
import { servicePolicyAvailable } from "../workspace/policyParameters";

const policies: Record<string, readonly string[]> = {
  call: ["circuitBreaker", "fallback", "retryBudget", "outlierDetection"],
  service: ["rateLimit", "healthCheck"], router: ["outlierDetection"],
};

/** Effective canvas policies and the inspector field owning each one. */
export function canvasPolicyPaths(type: string, params: Params, targetGroup = false, replicaOverrides?: Record<string, Params> | null) {
  return (policies[type] ?? []).flatMap(policy => {
    if (policy === "outlierDetection" && type === "call" && !targetGroup) return [];
    if (type === "service" && !servicePolicyAvailable(policy, { params, replicaOverrides })) return [];
    if (isObject(params[policy])) return [{ policy, path: policy }];
    const replica = type === "service" ? Object.entries(replicaOverrides ?? {}).find(([, params]) => isObject(params[policy]))?.[0] : undefined;
    return replica === undefined ? [] : [{ policy, path: `replicaOverrides.${replica}.${policy}` }];
  });
}

/** Only recorded positive shares describe an active state; summary badges remain neutral. */
export function policyStateDescription(state?: PolicyWindowState, copies = 1): string {
  return (["circuitOpenShare", "ejectedShare", "notReadyShare"] as const).flatMap(key => {
    const share = state?.[key];
    return share == null || share <= 0 ? [] : [t("results.timeline.policyWindow", {
      state: t(`results.timeline.policyValue.${key}`), share: formatPercent(share),
    }) + (key === "circuitOpenShare" && copies > 1 ? t("results.timeline.policyCallers", { copies: formatNumber(copies) }) : "")];
  }).join("; ");
}
