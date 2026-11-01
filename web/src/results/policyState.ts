export type PolicyState = "circuitOpenShare" | "ejectedShare" | "notReadyShare";

interface PolicyWindow {
  durationMs: number;
  circuitOpenMs?: number;
  ejectedMs?: number;
  notReadyMs?: number;
}

/** Saved event-time integrals, shared by Timeline and canvas playback. Group rows sum instance time. */
export function policyWindowState(window: PolicyWindow, copies = 1): Record<PolicyState, number | null> {
  const share = (integral: number | undefined) => integral === undefined || !Number.isFinite(integral)
    || !(window.durationMs > 0) || !(copies > 0) ? null : integral / (window.durationMs * copies);
  return { circuitOpenShare: share(window.circuitOpenMs), ejectedShare: share(window.ejectedMs), notReadyShare: share(window.notReadyMs) };
}
