export type JobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type DistributionKind = "FIXED" | "EXPONENTIAL" | "LOGNORMAL";
export type RetryKind = "NONE" | "FIXED" | "EXPONENTIAL_FULL_JITTER";
export type SweepParameter =
  | "ARRIVAL_RATE"
  | "LINK_TIMEOUT"
  | "MAX_ATTEMPTS"
  | "BACKOFF_BASE"
  | "DEGRADATION_MULTIPLIER";

export interface DurationDistribution {
  kind: DistributionKind;
  meanMs: number;
  stdDevMs: number | null;
}

export interface RetrySpec {
  kind: RetryKind;
  baseBackoffMs: number;
  maxBackoffMs: number;
  base: number;
}

export interface ServiceSpec {
  id: string;
  handlers: number;
  queueCapacity: number;
  processing: DurationDistribution;
  failureRate: number;
}

export interface LinkSpec {
  id: string;
  from: string;
  to: string;
  network: DurationDistribution;
  timeoutMs: number;
  maxAttempts: number;
  retry: RetrySpec;
}

export interface WorkloadSpec {
  arrivalRate: number;
  requestDeadlineMs: number;
}

export interface DegradationSpec {
  serviceId: string;
  startMs: number;
  endMs: number;
  processingMultiplier: number;
  failureRate: number | null;
}

export interface Scenario {
  entry: string;
  services: ServiceSpec[];
  links: LinkSpec[];
  workload: WorkloadSpec;
  degradation: DegradationSpec | null;
}

export interface Execution {
  replications: number;
  warmupMs: number;
  measurementMs: number;
  seed: number;
  maxRealTimeSeconds: number;
}

export interface ExperimentVariant {
  id: string;
  label: string;
  scenario: Scenario;
  sweepParameter: SweepParameter | null;
  sweepValue: number | null;
}

export interface ExperimentDocument {
  schemaVersion: number;
  execution: Execution;
  variants: ExperimentVariant[];
}

export interface SweepSpec {
  parameter: SweepParameter;
  serviceId: string | null;
  linkId: string | null;
  values: number[];
}

export interface SweepDocument {
  schemaVersion: number;
  execution: Execution;
  baseScenario: Scenario;
  sweep: SweepSpec;
}

export interface ExperimentSubmission {
  experiment: ExperimentDocument | null;
  sweep: SweepDocument | null;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface HealthView {
  status: string;
  applicationVersion: string;
  kslVersion: string;
}

export interface ExperimentJob {
  id: string;
  status: JobStatus;
  result?: ExperimentResult | null;
  error?: string | null;
}

export interface ExperimentResult {
  schemaVersion: number;
  applicationVersion: string;
  kslVersion: string;
  variants: VariantResult[];
}

export interface VariantResult {
  id: string;
  label: string;
  sweepParameter: SweepParameter | null;
  sweepValue: number | null;
  replications: ReplicationResult[];
  aggregate: AggregateMetrics;
}

export interface ReplicationResult {
  arrivalTimesMs: number[];
  allLatenciesMs: number[];
  successfulLatenciesMs: number[];
  failedLatenciesMs: number[];
  originalArrivals: number;
  successes: number;
  failures: number;
  services: Record<string, ServiceMetrics>;
}

export interface ServiceMetrics {
  offeredAttempts: number;
  admittedAttempts: number;
  timeouts: number;
  retries: number;
  failures: number;
  queueRejections: number;
  handlerUtilization: number;
  meanQueueLength: number;
  p95QueueLength: number;
}

export interface AggregateMetrics {
  pooledLatency: LatencySummary;
  successRate: MetricSummary | null;
  p95LatencyMs: MetricSummary | null;
  p99LatencyMs: MetricSummary | null;
  services: Record<string, AggregateServiceMetrics>;
}

export interface LatencySummary {
  all: LatencyDistribution | null;
  successful: LatencyDistribution | null;
  failed: LatencyDistribution | null;
}

export interface LatencyDistribution {
  meanMs: number;
  p95Ms: number;
  p99Ms: number;
}

export interface MetricSummary {
  mean: number;
  stdDev: number | null;
  ci95Low: number | null;
  ci95High: number | null;
  min: number;
  max: number;
}

export interface AggregateServiceMetrics {
  admittedAmplification: MetricSummary | null;
  offeredAmplification: MetricSummary | null;
}
