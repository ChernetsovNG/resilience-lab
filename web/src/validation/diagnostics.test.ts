import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../api/apiTypes";
import { experiment, experimentPath, model, modelPath } from "../test/fixtures";
import { diagnosticTarget, summarizeDiagnostics } from "./diagnostics";

const documents = { experiment, experimentPath, model, modelPath };
const diagnostic = (document: string | null, pointer: string | null, path: string | null = null): Diagnostic => ({
  code: "PARAM_RANGE", severity: "ERROR", message: "Invalid value", document, pointer, path,
});

describe("diagnostic locations", () => {
  it.each([
    [modelPath, "/blocks/gateway/params/handlers", "gateway", "handlers", null],
    [modelPath, "/blocks/gateway/params/processing/mean", "gateway", "processing.mean", null],
    [modelPath, "/blocks/gateway/scenario/1/connection", "gateway", "scenario.1.connection", null],
    [modelPath, "/blocks/gateway/scenario/0/processing/mean", "gateway", "scenario.0.processing.mean", null],
    [modelPath, "/blocks/gateway/scenario", "gateway", "scenario", null],
    [modelPath, "/connections/1/params/backoff/base", "gateway-to-middle", "backoff.base", null],
    [experimentPath, "/variants/1/overrides/gateway-to-middle.timeout", "gateway-to-middle", "timeout", "no-retries"],
    [experimentPath, "/variants/0/overrides/gateway.processing/mean", "gateway", "processing.mean", "baseline"],
    [experimentPath, "/execution/replications", null, "execution.replications", null],
    [experimentPath, "/faults/0/failureRate", null, "faults.0.failureRate", null],
    [experimentPath, "/grid", null, "grid", null],
    [experimentPath, "/grid/0/path", null, "grid.0.path", null],
    [experimentPath, "/grid/1/values/2", null, "grid.1.values.2", null],
  ])("maps %s#%s to its page, element and field", (document, pointer, element, field, variant) => {
    expect(diagnosticTarget(diagnostic(document, pointer), documents)).toEqual({ element, field, variant });
  });

  it("decodes JSON Pointer escapes and keeps diagnostics without elements in Problems", () => {
    const escaped = { ...documents, model: { ...model, blocks: { "api/core~v1": model.blocks.gateway } } };
    expect(diagnosticTarget(diagnostic(modelPath, "/blocks/api~1core~0v1/params/handlers"), escaped))
      .toEqual({ element: "api/core~v1", field: "handlers", variant: null });
    expect(diagnosticTarget(diagnostic(null, null), documents)).toEqual({ element: null, field: null, variant: null });
    expect(diagnosticTarget(diagnostic("other.model.json", "/blocks/gateway/params/handlers", "gateway"), documents))
      .toEqual({ element: null, field: null, variant: null });
    expect(diagnosticTarget(diagnostic(modelPath, "/connections/999/params/timeout"), documents).element).toBeNull();
  });

  it("routes a missing scenario on the block itself to the scenario section", () => {
    expect(diagnosticTarget({ ...diagnostic(modelPath, "/blocks/gateway"), code: "SCENARIO_REQUIRED" }, documents))
      .toEqual({ element: "gateway", field: "scenario", variant: null });
  });

  it("uses a valid element path for topology diagnostics without a field pointer", () => {
    expect(diagnosticTarget(diagnostic(modelPath, null, "gateway"), documents))
      .toEqual({ element: "gateway", field: null, variant: null });
  });

  it("uses explicit variant metadata for a model value and prefers it over pointer inference", () => {
    const finding = { ...diagnostic(modelPath, "/connections/1/params/timeout"), variant: "baseline" };
    expect(diagnosticTarget(finding, documents))
      .toEqual({ element: "gateway-to-middle", field: "timeout", variant: "baseline" });
    expect(diagnosticTarget({ ...finding, document: experimentPath, pointer: "/variants/1/overrides/gateway.handlers" }, documents).variant)
      .toBe("baseline");
  });

  it("keeps an explicit null variant common even when the pointer names an override", () => {
    const finding = { ...diagnostic(experimentPath, "/variants/1/overrides/gateway.handlers"), variant: null };
    expect(diagnosticTarget(finding, documents))
      .toEqual({ element: "gateway", field: "handlers", variant: null });
  });

  it("counts findings and gives errors precedence over warnings", () => {
    const error = diagnostic(modelPath, null);
    expect(summarizeDiagnostics([])).toBeNull();
    expect(summarizeDiagnostics([{ ...error, severity: "WARNING" }])).toEqual({ count: 1, severity: "WARNING" });
    expect(summarizeDiagnostics([{ ...error, severity: "WARNING" }, error])).toEqual({ count: 2, severity: "ERROR" });
  });
});
