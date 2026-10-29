import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { ModelFile, RunSummary } from "../api/apiTypes";
import type { NodeSeriesMetrics } from "./series";
import { elementIdentity } from "../workspace/editor";
import { ownEntry } from "../workspace/params";

export interface ServiceCanvasResults {
  windowed?: boolean;
  utilization: number | null;
  meanQueue: number | null;
  queueRejectionRate: number | null;
  firstSaturation: string | null;
}

export interface CanvasResults {
  window?: number;
  services: ReadonlyMap<string, ServiceCanvasResults>;
  connections: ReadonlyMap<string, { from: string; to: string; type: string; amplification: number | null }>;
}

const ratio = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;

/** Summary metrics for the run's model; an absent variant, point or element never borrows another result. */
export function canvasResults(
  summary: RunSummary, model: ModelFile, variantId: string, pointId: string, currentModel: ModelFile = model,
): CanvasResults | null {
  const variant = summary.variants.find((candidate) => candidate.id === variantId);
  const point = variant?.points.find((candidate) => candidate.id === pointId);
  if (variant === undefined || point === undefined) return null;
  const first = point.saturation.firstNodes[0];
  const services = new Map<string, ServiceCanvasResults>();
  const metrics = new Map(Object.entries(point.aggregate.services));
  for (const [id, service] of metrics) {
    const original = ownEntry(model.blocks, id);
    const current = ownEntry(currentModel.blocks, id);
    if (original?.type !== "service" || current?.type !== "service" || elementIdentity(original) !== elementIdentity(current)) continue;
    const totals = service.totals;
    services.set(id, {
      utilization: ratio(totals.busyHandlerTimeMs, totals.handlerCapacityTimeMs),
      meanQueue: ratio(totals.queueLengthIntegralMs, totals.measurementMs),
      queueRejectionRate: ratio(totals.queueRejections, totals.offeredAttempts),
      firstSaturation: first?.node === id ? t("results.canvas.firstSaturation", { count: formatNumber(first.replicationCount), replications: formatNumber(variant.replications) }) : null,
    });
  }
  const connections = new Map<string, { from: string; to: string; type: string; amplification: number | null }>();
  const currentConnections = new Map(currentModel.connections.map((connection) => [connection.id, connection]));
  for (const connection of model.connections) {
    const current = currentConnections.get(connection.id);
    if (!services.has(connection.to) || current === undefined || elementIdentity(current) !== elementIdentity(connection)) continue;
    connections.set(connection.id, {
      from: connection.from, to: connection.to, type: connection.type,
      amplification: metrics.get(connection.to)?.admittedAmplification?.mean ?? null,
    });
  }
  return { services, connections };
}

/** Project one recorded window onto the elements already matched to this run's model. */
export function windowCanvasResults(summary: CanvasResults, nodes: readonly NodeSeriesMetrics[], window: number, fromWindow = 0): CanvasResults | null {
  if (!Number.isInteger(window) || window < fromWindow) return null;
  const metrics = new Map(nodes.map((node) => [node.id, node.windows[window - fromWindow]]));
  const services = new Map<string, ServiceCanvasResults>();
  for (const [id, service] of summary.services) {
    const metric = metrics.get(id);
    if (metric === undefined) return null;
    services.set(id, {
      ...service, windowed: true, utilization: metric.handlerUtilization, meanQueue: metric.meanQueueLength,
      queueRejectionRate: ratio(metric.queueRejectionsPerSecond, metric.offeredAttemptsPerSecond),
    });
  }
  const connections = new Map([...summary.connections].map(([id, connection]) => [
    id, { ...connection, amplification: metrics.get(connection.to)?.amplification ?? null },
  ]));
  return { services, connections, window };
}

/** Clamp only the color scale; labels retain the summary's actual value. */
export const utilizationColor = (value: number) => `hsl(${120 * (1 - Math.max(0, Math.min(1, value)))} 65% 90%)`;
