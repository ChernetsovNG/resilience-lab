import { t } from "../i18n";
import type { HealthView } from "../api/apiTypes";

interface HealthBadgeProps {
  health: HealthView | null;
  error: string | null;
}

export function HealthBadge({ health, error }: HealthBadgeProps) {
  if (error !== null) {
    return (
      <div className="health-badge health-badge--error" role="alert">
        {t("app.health.unavailable", { error })}
      </div>
    );
  }

  if (health === null) {
    return (
      <div className="health-badge" role="status">
        {t("app.health.checking")}
      </div>
    );
  }

  return (
    <div className="health-badge health-badge--healthy" role="status">
      {t("app.health.healthy", { applicationVersion: health.applicationVersion, kslVersion: health.kslVersion })}
    </div>
  );
}
