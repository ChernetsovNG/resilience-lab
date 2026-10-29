import { useEffect, useState } from "react";
import { t } from "../i18n";
import { api } from "../api/apiClient";
import type { HealthView } from "../api/apiTypes";

/** Backend health, read once on start. */
export function useHealth(): { health: HealthView | null; error: string | null } {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [error, setError] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .health()
      .then((value) => {
        if (active) setHealth(value);
      })
      .catch((reason: unknown) => {
        if (active) setError({ error: reason });
      });
    return () => {
      active = false;
    };
  }, []);

  return { health, error: error === null ? null : error.error instanceof Error ? error.error.message : t("app.health.failed") };
}
