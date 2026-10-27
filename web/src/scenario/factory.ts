import type {
  Execution,
  ExperimentDocument,
  LinkSpec,
  Scenario,
  ServiceSpec,
} from "../api/types";
import { rpsToArrivalRate } from "./arrivalRate";

export function createDefaultExecution(): Execution {
  return {
    replications: 3,
    warmupMs: 100,
    measurementMs: 1_000,
    seed: 42,
    maxRealTimeSeconds: 30,
  };
}

function createService(id: string): ServiceSpec {
  return {
    id,
    handlers: 4,
    queueCapacity: 32,
    processing: { kind: "FIXED", meanMs: 10, stdDevMs: null },
    failureRate: 0,
  };
}

function createLink(id: string, from: string, to: string): LinkSpec {
  return {
    id,
    from,
    to,
    network: { kind: "FIXED", meanMs: 1, stdDevMs: null },
    timeoutMs: 100,
    maxAttempts: 1,
    retry: {
      kind: "NONE",
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      base: 2,
    },
  };
}

export function createThreeServiceChain(): Scenario {
  return {
    entry: "service-1",
    services: [createService("service-1"), createService("service-2"), createService("service-3")],
    links: [
      createLink("link-1", "service-1", "service-2"),
      createLink("link-2", "service-2", "service-3"),
    ],
    workload: { arrivalRate: rpsToArrivalRate(100), requestDeadlineMs: 1_000 },
    degradation: null,
  };
}

export function createRetryStormExample(): { experiment: ExperimentDocument } {
  const baseline = createThreeServiceChain();
  const candidate = createThreeServiceChain();
  candidate.workload = { ...candidate.workload, requestDeadlineMs: 500 };
  candidate.links = candidate.links.map((link) => ({
    ...link,
    maxAttempts: 3,
    retry: {
      kind: "EXPONENTIAL_FULL_JITTER",
      baseBackoffMs: 20,
      maxBackoffMs: 100,
      base: 2,
    },
  }));
  candidate.degradation = {
    serviceId: "service-2",
    startMs: 200,
    endMs: 800,
    processingMultiplier: 4,
    failureRate: null,
  };

  return {
    experiment: {
      schemaVersion: 1,
      execution: createDefaultExecution(),
      variants: [
        {
          id: "baseline",
          label: "Baseline",
          scenario: baseline,
          sweepParameter: null,
          sweepValue: null,
        },
        {
          id: "candidate",
          label: "Retry storm",
          scenario: candidate,
          sweepParameter: null,
          sweepValue: null,
        },
      ],
    },
  };
}
