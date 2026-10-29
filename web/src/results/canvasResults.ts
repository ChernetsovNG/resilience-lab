import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { Catalog, ExperimentFile, ModelFile, RunSummary } from "../api/apiTypes";
import type { NodeSeriesMetrics } from "./series";
import type { DecodedConnection } from "./series/types";
import { elementIdentity } from "../workspace/editor";
import { applyOverrides, ownEntry } from "../workspace/params";

export interface ServiceCanvasResults {
  windowed?: boolean;
  utilization: number | null;
  meanQueue: number | null;
  queueRejectionRate: number | null;
  firstSaturation: string | null;
}

/** Service metric controlling node color; values and labels keep their original units. */
export type NodeOverlayMetric = "utilization" | "meanQueue" | "queueRejectionRate";

export type ConnectionOverlayMetric = "amplification" | "sentAttemptsPerSecond" | "timeoutRate" | "meanOrphaned";

export interface ConnectionCanvasResults {
  from: string;
  to: string;
  type: string;
  amplification: number | null;
  sentAttemptsPerSecond?: number | null;
  timeoutRate?: number | null;
  meanOrphaned?: number | null;
}

export interface CanvasResults {
  /** Loading/error tooltip; without a recorded window, metric rows reserve empty space. */
  pending?: string;
  window?: number;
  services: ReadonlyMap<string, ServiceCanvasResults>;
  connections: ReadonlyMap<string, ConnectionCanvasResults>;
}

const ratio = (numerator: number, denominator: number) => denominator === 0 ? null : numerator / denominator;

/** Queue capacities from the run snapshot: grid coordinates override the variant; omitted queues use the catalog default. */
export function canvasQueueCapacities(
  model: ModelFile, experiment: ExperimentFile, catalog: Catalog, variantId: string, coordinates: Record<string, unknown>,
): ReadonlyMap<string, number> {
  const variant = experiment.variants.find(candidate => candidate.id === variantId);
  if (variant === undefined) return new Map();
  const effective = applyOverrides(applyOverrides(model, variant.overrides ?? {}, catalog), coordinates, catalog);
  const fallback = catalog.types.find(type => type.id === "service")?.params.find(param => param.name === "queue")?.default;
  return new Map(Object.entries(effective.blocks).flatMap(([id, block]) => {
    const capacity = block.params.queue ?? fallback;
    return block.type === "service" && typeof capacity === "number" && Number.isInteger(capacity) && capacity >= 0
      ? [[id, capacity] as const] : [];
  }));
}

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
  const connections = new Map<string, ConnectionCanvasResults>();
  const currentConnections = new Map(currentModel.connections.map((connection) => [connection.id, connection]));
  for (const connection of model.connections) {
    const current = currentConnections.get(connection.id);
    const own = ownEntry(point.aggregate.connections, connection.id);
    if ((!services.has(connection.to) && own === undefined) || current === undefined || elementIdentity(current) !== elementIdentity(connection)) continue;
    connections.set(connection.id, {
      from: connection.from, to: connection.to, type: connection.type,
      amplification: metrics.get(connection.to)?.admittedAmplification?.mean ?? null,
      ...(own === undefined ? {} : {
        sentAttemptsPerSecond: ratio(own.totals.sentAttempts * 1000, own.totals.measurementMs),
        timeoutRate: own.timeoutRate?.mean ?? null,
        meanOrphaned: ratio(own.totals.orphanedIntegralMs, own.totals.measurementMs),
      }),
    });
  }
  return { services, connections };
}

/** Project one recorded window onto the elements already matched to this run's model. */
export function windowCanvasResults(summary: CanvasResults, nodes: readonly NodeSeriesMetrics[], window: number, fromWindow = 0, connectionSeries: readonly DecodedConnection[] = []): CanvasResults | null {
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
  const connections = new Map<string, ConnectionCanvasResults>();
  for (const [id, connection] of summary.connections) {
    const metric = connectionSeries.find(candidate => candidate.id === id)?.windows[window - fromWindow];
    if (connection.sentAttemptsPerSecond !== undefined && metric === undefined) return null;
    connections.set(id, {
      ...connection, amplification: metrics.get(connection.to)?.amplification ?? null,
      ...(metric === undefined ? {} : {
        sentAttemptsPerSecond: ratio(metric.sentAttempts * 1000, metric.durationMs),
        timeoutRate: ratio(metric.timeouts, metric.sentAttempts),
        meanOrphaned: ratio(metric.orphanedIntegralMs, metric.durationMs),
      }),
    });
  }
  return { services, connections, window };
}

/** Clamp only the color scale; labels retain the summary's actual value. */
export const utilizationColor = (value: number) => `hsl(${120 * (1 - Math.max(0, Math.min(1, value)))} 65% 90%)`;
