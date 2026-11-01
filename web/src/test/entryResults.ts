import { model, summary } from "./fixtures";

/** Two populations with independent saved metrics; request type status is shared by both clients. */
export function entryResults() {
  const source = structuredClone(model);
  source.blocks.client.params = { deadline: "250ms", classes: [
    { id: "status", load: { points: [{ time: "0s", rate: "80/s" }] } },
    { id: "checkout", load: { points: [{ time: "0s", rate: "20/s" }] } },
  ] };
  source.blocks.partner = { type: "client", params: { deadline: "250ms", classes: [
    { id: "status", load: { points: [{ time: "0s", rate: "10/s" }] } },
  ] } };
  source.connections.push({ id: "partner-request", type: "request", from: "partner", to: "gateway", params: {} });
  const run = structuredClone(summary);
  const metric = (mean: number) => ({ count: 10, mean, min: mean, max: mean, stdDev: 0.01 });
  for (const [index, variant] of run.variants.entries()) {
    variant.replications = 10;
    const entry = { pooledLatency: {}, successRate: metric(index === 0 ? 0.8 : 0.9),
      p95LatencyMs: metric(42), p99LatencyMs: metric(85), degradedRate: metric(index === 0 ? 0 : 0.046),
      failuresByReason: { timeout: metric(0.04), circuitOpen: metric(0.03), error: metric(0.03), queueFull: metric(0.01) } };
    variant.points[0].aggregate.entries = { total: entry,
      clients: { client: entry, partner: { ...entry, successRate: metric(1) } },
      classes: { checkout: { ...entry, successRate: metric(0.5) },
        status: { ...entry, successRate: metric(1), failuresByReason: index === 0 ? {} : { timeout: metric(0.02) } } },
    };
  }
  return { model: source, summary: run };
}
