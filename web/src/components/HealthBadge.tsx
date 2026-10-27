import type { HealthView } from "../api/apiTypes";

interface HealthBadgeProps {
  health: HealthView | null;
  error: string | null;
}

export function HealthBadge({ health, error }: HealthBadgeProps) {
  if (error !== null) {
    return (
      <div className="health-badge health-badge--error" role="alert">
        Backend unavailable: {error}
      </div>
    );
  }

  if (health === null) {
    return (
      <div className="health-badge" role="status">
        Checking backend health…
      </div>
    );
  }

  return (
    <div className="health-badge health-badge--healthy" role="status">
      Backend healthy · v{health.applicationVersion} · KSL {health.kslVersion}
    </div>
  );
}
