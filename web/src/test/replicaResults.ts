import { experiment, model, slotPoolResource, summary } from "./fixtures";

/** Hand-checked group: 34% pooled, replica #2 at 97%; pooled p99 is not the mean of replica p99s. */
export function replicaFixture() {
  const runModel = structuredClone(model);
  runModel.blocks.gateway.params.replicas = 3;
  runModel.blocks.gateway.replicaOverrides = { "2": { processing: { mean: "99ms" } } };
  const run = structuredClone(summary);
  run.variants = [run.variants[0]];
  const aggregate = run.variants[0].points[0].aggregate;
  const base = structuredClone(aggregate.services.gateway);
  for (const [index, busy] of [40, 1940, 60].entries()) {
    const value = structuredClone(base);
    value.totals.slotPools.handlers.busyIntegralMs = busy;
    value.totals.slotPools.handlers.queueIntegralMs = index === 1 ? 300 : 50;
    value.totals.slotPools.handlers.queueFullCount = index === 1 ? 20 : 0;
    value.pooledLatency = { meanMs: index === 1 ? 500 : 10, p95Ms: 20, statistics: { count: 2, sumMs: 20, sketch: [0, 1, 2] }, p99Ms: index === 1 ? 990 : 20 };
    aggregate.services[`gateway#${index + 1}`] = value;
  }
  const group = aggregate.services.gateway;
  group.totals = { ...group.totals, originalArrivals: 600, offeredAttempts: 780, admittedAttempts: 720,
    timeouts: 60, retries: 120, failures: 30 };
  group.totals.slotPools.handlers = { ...group.totals.slotPools.handlers, busyIntegralMs: 2040,
    capacityIntegralMs: 6000, queueIntegralMs: 400,
    replicaExtrema: { minUtilization: 0.02, maxUtilization: 0.97, maxUtilizationReplica: 2,
      minMeanQueueLength: 0.025, maxMeanQueueLength: 0.15, maxMeanQueueLengthReplica: 2 } };
  group.pooledLatency = { meanMs: 123, p95Ms: 500, p99Ms: 876, statistics: { count: 6, sumMs: 738, sketch: [0, 1, 6] } };
  aggregate.groups = [{ id: "gateway", kind: "NODE", instances: [1, 2, 3].map(replica => ({ id: `gateway#${replica}`, replica })) }];
  run.variants[0].points[0].saturation.firstNodes = [{ node: "gateway#2", ...slotPoolResource("gateway#2"),
    replicationCount: 2, medianStartMs: 100, minStartMs: 100, maxStartMs: 100 }];
  return { run, runModel, runExperiment: { ...structuredClone(experiment), variants: [{ id: "baseline", label: "Baseline", overrides: {} }] } };
}
