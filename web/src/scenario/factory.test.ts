import { describe, expect, it } from "vitest";
import {
  createDefaultExecution,
  createRetryStormExample,
  createThreeServiceChain,
} from "./factory";

 describe("scenario factories", () => {
  it("creates exactly three linked services with bounded resources", () => {
    const scenario = createThreeServiceChain();

    expect(scenario.services).toHaveLength(3);
    expect(scenario.links).toHaveLength(2);
    expect(scenario.entry).toBe(scenario.services[0].id);
    expect(scenario.links.map(({ from, to }) => [from, to])).toEqual([
      [scenario.services[0].id, scenario.services[1].id],
      [scenario.services[1].id, scenario.services[2].id],
    ]);
    for (const service of scenario.services) {
      expect(service.handlers).toBeGreaterThan(0);
      expect(service.queueCapacity).toBeGreaterThanOrEqual(0);
    }
    expect(scenario.workload.arrivalRate).toBeGreaterThan(0);
    expect(scenario.workload.requestDeadlineMs).toBeGreaterThan(0);
  });

  it("creates small deterministic execution defaults", () => {
    expect(createDefaultExecution()).toEqual({
      replications: 3,
      warmupMs: 100,
      measurementMs: 1_000,
      seed: 42,
      maxRealTimeSeconds: 30,
    });
  });

  it("creates a synthetic retry-storm smoke experiment", () => {
    const { experiment } = createRetryStormExample();

    expect(experiment.schemaVersion).toBe(1);
    expect(experiment.variants).toHaveLength(2);
    expect(experiment.variants.map((variant) => variant.id)).toEqual([
      "baseline",
      "candidate",
    ]);
    const degraded = experiment.variants[1].scenario;
    expect(degraded.degradation).toMatchObject({
      serviceId: degraded.services[1].id,
      processingMultiplier: expect.any(Number),
    });
    expect(degraded.workload.requestDeadlineMs).toBeGreaterThan(0);
    expect(degraded.links[0].maxAttempts).toBeGreaterThan(1);
    expect(degraded.links[0].retry).toMatchObject({
      kind: "EXPONENTIAL_FULL_JITTER",
      base: 2,
    });
    expect(createDefaultExecution()).toEqual(experiment.execution);
  });
});
