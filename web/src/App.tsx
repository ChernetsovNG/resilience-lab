import { useEffect, useState } from "react";
import { health as getHealth } from "./api/client";
import type { HealthView } from "./api/types";
import { HealthBadge } from "./components/HealthBadge";
import { ChainCanvas } from "./editor/ChainCanvas";

export function App() {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void getHealth()
      .then((value) => {
        if (active) {
          setHealth(value);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Health check failed");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Resilience Lab</h1>
          <p>Experiment design and analysis</p>
        </div>
        <HealthBadge health={health} error={error} />
      </header>
      <main className="workspace">
        <section className="editor-shell" aria-labelledby="editor-title">
          <h2 id="editor-title">Experiment editor</h2>
          <ChainCanvas />
        </section>
      </main>
    </div>
  );
}
