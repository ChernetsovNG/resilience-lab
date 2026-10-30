import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { Catalog, ExperimentFile, ModelFile, OutputDescriptor, RunSummary } from "../api/apiTypes";
import type { NodeSeriesMetrics } from "./series";
import type { DecodedConnection } from "./series/types";
import { outputsOf, outputValue } from "./outputs";
import { elementIdentity } from "../workspace/editor";
import { applyOverrides, ownEntry } from "../workspace/params";

interface ElementCanvasValues {
  values: Record<string, number | null>;
  outputs: OutputDescriptor[];
  /** Parameters of the immutable run context, including defaults, variant and grid overrides. */
  params: Record<string, unknown>;
}

export interface ServiceCanvasResults extends ElementCanvasValues {
  windowed?: boolean;
  firstSaturation: string | null;
}

/** Service metric controlling node color; values and labels keep their original units. */
export type NodeOverlayMetric = string;
export type ConnectionOverlayMetric = string;

export interface ConnectionCanvasResults extends ElementCanvasValues {
  from: string;
  to: string;
  type: string;
  hasOwnSeries: boolean;
}

export interface CanvasResults {
  /** Loading/error tooltip; without a recorded window, metric rows reserve empty space. */
  pending?: string;
  window?: number;
  services: ReadonlyMap<string, ServiceCanvasResults>;
  connections: ReadonlyMap<string, ConnectionCanvasResults>;
}

const valuesOf = (outputs: readonly OutputDescriptor[], context: unknown, windowed = false) =>
  Object.fromEntries(outputs.map(output => [output.id, outputValue(output, context, windowed).value]));

export const emptyCanvasValues = (values: Record<string, number | null>) =>
  Object.fromEntries(Object.keys(values).map(key => [key, null]));

/** Summary metrics for the run's model; an absent variant, point or element never borrows another result. */
export function canvasResults(
  summary: RunSummary, model: ModelFile, variantId: string, pointId: string, catalog: Catalog,
  currentModel: ModelFile = model, experiment?: ExperimentFile,
): CanvasResults | null {
  const variant = summary.variants.find(candidate => candidate.id === variantId);
  const point = variant?.points.find(candidate => candidate.id === pointId);
  if (variant === undefined || point === undefined) return null;
  const effective = applyOverrides(applyOverrides(model,
    experiment?.variants.find(variant => variant.id === variantId)?.overrides ?? {}, catalog), point.coordinates, catalog);
  const paramsOf = (type: string, params: Record<string, unknown>) => ({
    ...Object.fromEntries((catalog.types.find(candidate => candidate.id === type)?.params ?? []).map(param => [param.name, param.default])), ...params,
  });
  const first = point.saturation.firstNodes[0];
  const services = new Map<string, ServiceCanvasResults>();
  for (const [id, aggregate] of Object.entries(point.aggregate.services)) {
    const original = ownEntry(model.blocks, id), current = ownEntry(currentModel.blocks, id);
    if (original === undefined || current?.type !== original.type || elementIdentity(original) !== elementIdentity(current)) continue;
    const outputs = outputsOf(catalog, original.type).filter(output => output.overlay != null).sort((a, b) => a.overlay!.order - b.overlay!.order);
    if (outputs.length === 0) continue;
    const params = paramsOf(original.type, effective.blocks[id]?.params ?? {});
    services.set(id, { outputs, params,
      values: valuesOf(outputs, { ...aggregate, params, replications: variant.replications }),
      firstSaturation: first?.node === id ? t("results.canvas.firstSaturation", { count: formatNumber(first.replicationCount), replications: formatNumber(variant.replications) }) : null,
    });
  }
  const connections = new Map<string, ConnectionCanvasResults>();
  const currentConnections = new Map(currentModel.connections.map(connection => [connection.id, connection]));
  for (const connection of model.connections) {
    const current = currentConnections.get(connection.id);
    const own = ownEntry(point.aggregate.connections, connection.id);
    if ((!services.has(connection.to) && own === undefined) || current === undefined || elementIdentity(current) !== elementIdentity(connection)) continue;
    const outputs = outputsOf(catalog, connection.type).filter(output => output.overlay != null).sort((a, b) => a.overlay!.order - b.overlay!.order);
    if (outputs.length === 0) continue;
    const params = paramsOf(connection.type, effective.connections.find(candidate => candidate.id === connection.id)?.params ?? {});
    connections.set(connection.id, { from: connection.from, to: connection.to, type: connection.type,
      outputs, params, hasOwnSeries: own !== undefined,
      values: valuesOf(outputs, { ...own, params, replications: variant.replications, target: ownEntry(point.aggregate.services, connection.to) }),
    });
  }
  return { services, connections };
}

/** Project one recorded window onto the elements already matched to this run's model. */
export function windowCanvasResults(summary: CanvasResults, nodes: readonly NodeSeriesMetrics[], window: number, fromWindow = 0, connectionSeries: readonly DecodedConnection[] = []): CanvasResults | null {
  if (!Number.isInteger(window) || window < fromWindow) return null;
  const metrics = new Map(nodes.map(node => [node.id, node.windows[window - fromWindow]]));
  const services = new Map<string, ServiceCanvasResults>();
  for (const [id, service] of summary.services) {
    const frame = metrics.get(id);
    if (frame === undefined) return null;
    services.set(id, { ...service, windowed: true,
      values: valuesOf(service.outputs, { ...frame, params: service.params }, true) });
  }
  const connections = new Map<string, ConnectionCanvasResults>();
  for (const [id, connection] of summary.connections) {
    const frame = connectionSeries.find(candidate => candidate.id === id)?.windows[window - fromWindow];
    if (connection.hasOwnSeries && frame === undefined) return null;
    const target = metrics.get(connection.to);
    connections.set(id, { ...connection,
      values: valuesOf(connection.outputs, { ...frame, params: connection.params, target, client: target?.client }, true) });
  }
  return { services, connections, window };
}

/** Clamp only the color scale; labels retain the summary's actual value. */
export const utilizationColor = (value: number) => `hsl(${120 * (1 - Math.max(0, Math.min(1, value)))} 65% 90%)`;
