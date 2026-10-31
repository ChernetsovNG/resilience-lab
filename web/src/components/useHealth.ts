import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { api, ApiError } from "../api/apiClient";
import type { HealthView } from "../api/apiTypes";

interface HealthState {
  health: HealthView | null;
  error: { error: unknown; recoveryRequested?: true } | null;
}

/** Backend health, read once on start; retries only while unavailable. A successful poll triggers one immediate retry per outage. */
export function useHealth() {
  const [state, setState] = useState<HealthState>({ health: null, error: null });
  const reportFailure = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status < 500) return;
    setState(current => current.error === null ? { health: null, error: { error: reason } } : current);
  }, []);
  const reportSuccess = useCallback(() => {
    setState(current => current.error === null || current.error.recoveryRequested ? current
      : { ...current, error: { ...current.error, recoveryRequested: true } });
  }, []);

  useEffect(() => {
    let active = true;
    void api
      .health()
      .then((value) => {
        if (active) setState(current => current.health === null && current.error === null ? { health: value, error: null } : current);
      })
      .catch((reason: unknown) => {
        if (active) setState(current => current.health === null && current.error === null ? { health: null, error: { error: reason } } : current);
      });
    return () => {
      active = false;
    };
  }, []);

  // The failure object identifies an outage even if recovery and a new failure are batched.
  useEffect(() => {
    if (state.error === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = [1000, 2000, 5000, 10_000];
    let attempt = 1;
    const retry = async () => {
      try {
        const health = await api.health();
        if (active) setState({ health, error: null });
      } catch {
        if (!active) return;
        timer = setTimeout(() => void retry(), delays[Math.min(attempt++, delays.length - 1)]);
      }
    };
    if (state.error.recoveryRequested) void retry();
    else timer = setTimeout(() => void retry(), delays[0]);
    return () => { active = false; clearTimeout(timer); };
  }, [state.error]);

  return {
    health: state.health,
    error: state.error === null ? null : state.error.error instanceof Error ? state.error.error.message : t("app.health.failed"),
    reportFailure,
    reportSuccess,
  };
}
