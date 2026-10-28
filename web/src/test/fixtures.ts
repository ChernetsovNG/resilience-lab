import type {
  Catalog,
  DocumentView,
  ExperimentFile,
  LayoutFile,
  ModelFile,
  ParamDescriptor,
  RunSummary,
} from "../api/apiTypes";

type QuantityUnit = ParamDescriptor["units"][number];

const unit = (symbol: string, numerator: number, denominator: number): QuantityUnit => ({ symbol, numerator, denominator });

/** Units and scales the server catalog lists for each dimension. */
export const unitsOf: Record<string, QuantityUnit[]> = {
  DURATION: [unit("ms", 1, 1), unit("s", 1000, 1), unit("min", 60000, 1)],
  RATE: [unit("/ms", 1, 1), unit("/s", 1, 1000), unit("/min", 1, 60000)],
  PROBABILITY: [unit("%", 1, 100)],
};

function param(partial: Partial<ParamDescriptor> & Pick<ParamDescriptor, "name" | "kind" | "title">): ParamDescriptor {
  const units = partial.dimension == null ? [] : unitsOf[partial.dimension];
  return { description: "", required: false, options: [], fields: [], sweepable: false, units, ...partial };
}

function distribution(name: string, title: string, fallback?: ParamDescriptor["default"]): ParamDescriptor {
  return param({
    name,
    kind: "OBJECT",
    title,
    required: fallback === undefined,
    default: fallback,
    fields: [
      param({ name: "kind", kind: "CHOICE", title: "Distribution", required: true, options: ["fixed", "exponential", "lognormal"] }),
      param({ name: "mean", kind: "QUANTITY", title: "Mean", required: true, dimension: "DURATION" }),
      param({ name: "stdDev", kind: "QUANTITY", title: "Standard deviation", dimension: "DURATION" }),
    ],
  });
}

export const catalog: Catalog = {
  schemaVersion: 1,
  types: [
    {
      id: "client",
      version: 1,
      category: "BLOCK",
      title: "Client",
      description: "Open Poisson stream of original requests with an end-to-end deadline.",
      ports: [{ id: "out", direction: "OUT" }],
      params: [
        param({ name: "rate", kind: "QUANTITY", title: "Arrival rate", required: true, dimension: "RATE" }),
        param({ name: "deadline", kind: "QUANTITY", title: "Deadline", required: true, dimension: "DURATION" }),
      ],
    },
    {
      id: "service",
      version: 1,
      category: "BLOCK",
      title: "Service",
      description: "Blocking service.",
      ports: [
        { id: "in", direction: "IN" },
        { id: "out", direction: "OUT" },
      ],
      params: [
        param({ name: "handlers", kind: "INTEGER", title: "Handlers", required: true, minimum: 1 }),
        param({ name: "queue", kind: "INTEGER", title: "Queue capacity", default: 0, minimum: 0 }),
        distribution("processing", "Processing time"),
        param({ name: "failureRate", kind: "QUANTITY", title: "Failure rate", default: "0%", dimension: "PROBABILITY", minimum: 0, maximum: 1 }),
      ],
    },
    {
      id: "request",
      version: 1,
      category: "CONNECTION",
      title: "Request",
      description: "Delivers original requests to the entry service.",
      ports: [],
      connects: { fromType: "client", toType: "service" },
      params: [],
    },
    {
      id: "call",
      version: 1,
      category: "CONNECTION",
      title: "Call",
      description: "Synchronous call with timeout, retries and backoff.",
      ports: [],
      connects: { fromType: "service", toType: "service" },
      params: [
        distribution("network", "Network delay", { kind: "fixed", mean: "0ms" }),
        param({ name: "timeout", kind: "QUANTITY", title: "Timeout", required: true, dimension: "DURATION" }),
        param({ name: "attempts", kind: "INTEGER", title: "Attempts", default: 1, minimum: 1 }),
        param({
          name: "backoff",
          kind: "OBJECT",
          title: "Backoff",
          default: { kind: "none" },
          fields: [
            param({ name: "kind", kind: "CHOICE", title: "Kind", required: true, options: ["none", "fixed", "exponential-full-jitter"] }),
            param({ name: "base", kind: "QUANTITY", title: "Base delay", default: "0ms", dimension: "DURATION" }),
            param({ name: "max", kind: "QUANTITY", title: "Maximum delay", default: "0ms", dimension: "DURATION" }),
            param({ name: "multiplier", kind: "NUMBER", title: "Multiplier", default: 2 }),
          ],
        }),
      ],
    },
  ],
};

const backoff = { base: "2ms", kind: "exponential-full-jitter", max: "20ms", multiplier: 2 };
const service = (handlers: number, queue: number, mean: string) => ({
  type: "service",
  params: { handlers, processing: { kind: "fixed", mean }, queue },
});

export const model: ModelFile = {
  schemaVersion: 1,
  blocks: {
    client: { type: "client", params: { deadline: "250ms", rate: "120/s" } },
    dependency: service(2, 8, "8ms"),
    gateway: service(4, 16, "1ms"),
    middle: service(4, 12, "2ms"),
  },
  connections: [
    { id: "client-to-gateway", type: "request", from: "client", to: "gateway", params: {} },
    {
      id: "gateway-to-middle",
      type: "call",
      from: "gateway",
      to: "middle",
      params: { attempts: 3, backoff, network: { kind: "fixed", mean: "0.5ms" }, timeout: "80ms" },
    },
    {
      id: "middle-to-dependency",
      type: "call",
      from: "middle",
      to: "dependency",
      params: { attempts: 3, backoff, network: { kind: "fixed", mean: "0.5ms" }, timeout: "60ms" },
    },
  ],
};

export const layout: LayoutFile = {
  schemaVersion: 1,
  positions: {
    client: { x: 0, y: 100 },
    dependency: { x: 780, y: 100 },
    gateway: { x: 260, y: 100 },
    middle: { x: 520, y: 100 },
  },
};

export const experimentPath = "retry-storm/retry-storm.experiment.json";
export const modelPath = "retry-storm/retry-storm.model.json";
export const layoutPath = "retry-storm/retry-storm.layout.json";

export const experiment: ExperimentFile = {
  schemaVersion: 1,
  modelRef: "retry-storm.model.json",
  layoutRef: "retry-storm.layout.json",
  execution: { replications: 2, warmup: "0ms", measurement: "1s", seed: 20261025, maxRealTime: "30s" },
  faults: [{ target: "dependency", from: "200ms", to: "700ms", processingMultiplier: 6, failureRate: "5%" }],
  grid: [],
  variants: [
    { id: "baseline", label: "Baseline", overrides: {} },
    { id: "no-retries", label: "No retries", overrides: { "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1 } },
  ],
};

/** Server views of the example documents by path. */
export const documentViews: Record<string, DocumentView> = {
  [experimentPath]: { path: experimentPath, kind: "EXPERIMENT", version: "v-experiment", content: { experiment } },
  [modelPath]: { path: modelPath, kind: "MODEL", version: "v-model", content: { model } },
  [layoutPath]: { path: layoutPath, kind: "LAYOUT", version: "v-layout", content: { layout } },
};

export const summary: RunSummary = {
  schemaVersion: 3,
  experiment: experimentPath,
  variants: [
    {
      id: "baseline",
      label: "Baseline",
      replications: 2,
      points: [{ id: "p0", coordinates: {}, aggregate: {
        pooledLatency: {},
        successRate: { mean: 0.975, stdDev: 0.01, ci95Low: 0.95, ci95High: 1, min: 0.97, max: 0.98 },
        p95LatencyMs: { mean: 41.25, min: 40, max: 42.5 },
        p99LatencyMs: { mean: 80, min: 79, max: 81 },
        services: {
          gateway: {
            admittedAmplification: { mean: 1.2, min: 1.1, max: 1.3 },
            totals: {
              originalArrivals: 200, offeredAttempts: 260, admittedAttempts: 240,
              timeouts: 20, retries: 40, failures: 10, queueRejections: 20,
              busyHandlerTimeMs: 1000, handlerCapacityTimeMs: 2000,
              queueLengthIntegralMs: 200, measurementMs: 2000,
            },
          },
        },
      } }],
    },
    {
      id: "no-retries",
      label: "No retries",
      replications: 2,
      points: [{ id: "p0", coordinates: {}, aggregate: { pooledLatency: {}, services: {} } }],
    },
  ],
};
