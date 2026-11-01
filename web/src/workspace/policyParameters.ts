import type { ModelFile } from "../api/apiTypes";
import { elementOf, isObject, ownEntry } from "./params";

/** Policy editing is introduced by T4; existing policy values remain readable and preserved. */
export const readOnlyPolicies = new Set(["circuitBreaker", "retryBudget", "fallback", "rateLimit", "healthCheck", "outlierDetection"]);

const outputPolicies: Record<string, string> = {
  circuitOpenShare: "circuitBreaker",
  circuitRejectionsPerSecond: "circuitBreaker",
  retriesDeniedPerSecond: "retryBudget",
  fallbacksPerSecond: "fallback",
  degradedPerSecond: "fallback",
  rateLimitedPerSecond: "rateLimit",
  rateLimitedRate: "rateLimit",
  probeFailuresPerSecond: "healthCheck",
  notReadyShare: "healthCheck",
  ejectionsCount: "outlierDetection",
  ejectedShare: "outlierDetection",
};

const poolOutputs = new Set(["poolUtilization", "meanPoolQueue", "poolAcquireTimeouts"]);

/** Connection-pool outputs require a pool in at least one displayed effective model. */
export function poolOutputAvailable(output: string, id: string, models: readonly ModelFile[]): boolean {
  return !poolOutputs.has(output) || models.some(model => isObject(elementOf(model, id)?.params.pool));
}

function clientHasFallback(model: ModelFile, id: string): boolean {
  const classes = ownEntry(model.blocks, id)?.params.classes;
  const requestClasses = Array.isArray(classes)
    ? classes.flatMap(value => isObject(value) && typeof value.id === "string" ? [value.id] : []) : ["default"];
  return requestClasses.some(requestClass => {
    const reachable = new Set([id]);
    for (const from of reachable) for (const connection of model.connections) {
      if (connection.from !== from || (connection.classes != null && !connection.classes.includes(requestClass))) continue;
      const scenario = ownEntry(model.blocks, from)?.scenario;
      if (connection.type === "call" && scenario != null && !scenario.some(step => step.type === "call"
        && step.connection === connection.id && (step.classes == null || step.classes.includes(requestClass)))) continue;
      if (connection.type === "call" && isObject(connection.params?.fallback)) return true;
      reachable.add(connection.to);
    }
    return false;
  });
}

/** Policy outputs are relevant when an effective variant enables the policy, including replica overrides. */
export function policyOutputAvailable(output: string, id: string, models: readonly ModelFile[], replica?: number): boolean {
  const policy = ownEntry(outputPolicies, output);
  if (policy === undefined) return true;
  return models.some(model => {
    if (replica !== undefined) {
      const owner = ownEntry(model.blocks, id)
        ?? ownEntry(model.blocks, model.connections.find(connection => connection.id === id)?.from ?? "");
      if (replica > Number(owner?.params.replicas ?? 1)) return false;
    }
    if (policy === "outlierDetection") {
      const replicas = Number(ownEntry(model.blocks, id)?.params.replicas ?? 1);
      return model.connections.some(edge => edge.to === id && (
        (edge.type === "call" && replicas > 1 && isObject(edge.params?.outlierDetection))
        || (edge.type === "route" && replicas === 1 && isObject(ownEntry(model.blocks, edge.from)?.params.outlierDetection))
      ));
    }
    const element = elementOf(model, id);
    if (element?.type === "client" && policy === "fallback") return clientHasFallback(model, id);
    const enabled = isObject(element?.params[policy]);
    const block = ownEntry(model.blocks, id);
    if (block?.type !== "service") return enabled;
    if (replica !== undefined) {
      const override = block.replicaOverrides?.[String(replica)];
      return override !== undefined && Object.hasOwn(override, policy) ? isObject(override[policy]) : enabled;
    }
    const overrides = Object.values(block.replicaOverrides ?? {});
    return (enabled && overrides.length < Number(block.params.replicas ?? 1))
      || overrides.some(params => Object.hasOwn(params, policy) ? isObject(params[policy]) : enabled);
  });
}
