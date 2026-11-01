import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationView } from "../api/apiTypes";
import { experiment, experimentPath, layout, layoutPath, model, modelPath } from "../test/fixtures";
import { stubFetch } from "../test/stubFetch";
import type { LoadedExperiment } from "../workspace/editor";
import { withParam } from "../workspace/params";
import { useValidation } from "./useValidation";

const loaded: LoadedExperiment = {
  experimentPath, experiment, modelPath, model, layoutPath, layout,
  saved: { experiment, model, layout }, versions: { model: "m", experiment: "e", layout: "l" },
};
const valid: ValidationView = { experiment: experimentPath, valid: true, diagnostics: [] };
const invalid: ValidationView = { ...valid, valid: false, diagnostics: [
  { code: "PARAM_RANGE", severity: "ERROR", message: "At least one handler", document: modelPath, pointer: "/blocks/gateway/params/handlers", path: "gateway" },
] };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("draft validation", () => {
  it("waits 500 ms after the last edit and sends every changed document", async () => {
    const fetch = stubFetch(() => ({ body: invalid }));
    const { result, rerender } = renderHook((document: LoadedExperiment) => useValidation(document), { initialProps: loaded });
    await advance(300);
    rerender({
      ...loaded, model: withParam(model, "gateway", "handlers", 0),
      layout: { ...layout, positions: { gateway: { x: 10, y: 20 } } },
      experiment: { ...experiment, execution: { ...experiment.execution, replications: 0 } },
    });
    await advance(499);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);
    await advance(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/v1/validate");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.experiment).toBe(experimentPath);
    expect(body.drafts.map((draft: { path: string }) => draft.path).sort()).toEqual([experimentPath, layoutPath, modelPath]);
    expect(body.drafts.find((draft: { path: string }) => draft.path === modelPath).content.model.blocks.gateway.params.handlers).toBe(0);
    expect(result.current.report?.valid).toBe(false);
    expect(result.current.pending).toBe(false);
  });

  it("ignores a late invalid response after a newer valid edit", async () => {
    const resolve: ((response: { body: ValidationView }) => void)[] = [];
    stubFetch(() => new Promise((done) => { resolve.push(done); }));
    const { result, rerender } = renderHook((document: LoadedExperiment) => useValidation(document), { initialProps: loaded });
    await advance(500);
    rerender({ ...loaded, model: withParam(model, "gateway", "handlers", 6) });
    await advance(500);
    await act(async () => { resolve[1]({ body: valid }); });
    await act(async () => { resolve[0]({ body: invalid }); });
    expect(result.current.report).toEqual(valid);
    expect(result.current.problem).toBeNull();
  });

  it("keeps the last diagnostics while edits are waiting for validation", async () => {
    let resolve!: (response: { body: ValidationView }) => void;
    let checks = 0;
    stubFetch(() => ++checks === 1 ? { body: invalid } : new Promise(done => { resolve = done; }));
    const { result, rerender } = renderHook((document: LoadedExperiment) => useValidation(document), { initialProps: loaded });
    await advance(500);
    rerender({ ...loaded, model: withParam(model, "gateway", "handlers", 8) });
    expect(result.current.pending).toBe(true);
    expect(result.current.report).toEqual(invalid);
    await advance(500);
    expect(result.current.pending).toBe(true);
    expect(result.current.report).toEqual(invalid);
    await act(async () => { resolve({ body: valid }); });
    expect(result.current.report).toEqual(valid);
    expect(result.current.pending).toBe(false);
  });

  it("does not carry diagnostics to another experiment or model", async () => {
    stubFetch(() => ({ body: invalid }));
    const { result, rerender } = renderHook((document: LoadedExperiment | null) => useValidation(document), { initialProps: loaded as LoadedExperiment | null });
    await advance(500);
    expect(result.current.report?.valid).toBe(false);
    rerender({ ...loaded, modelPath: "other.model.json" });
    expect(result.current.report).toBeNull();
    expect(result.current.pending).toBe(true);
    rerender({ ...loaded, experimentPath: "other.experiment.json" });
    expect(result.current.report).toBeNull();
    rerender(null);
    await advance(500);
    expect(result.current.pending).toBe(false);
  });

  it("shows transport failures and ignores failures from an obsolete request", async () => {
    let reject!: (reason: Error) => void;
    let first = true;
    stubFetch(() => {
      if (first) { first = false; return new Promise((_, fail) => { reject = fail; }); }
      throw new Error("Validation offline");
    });
    const { result, rerender } = renderHook((document: LoadedExperiment) => useValidation(document), { initialProps: loaded });
    await advance(500);
    rerender({ ...loaded, model: withParam(model, "gateway", "handlers", 5) });
    await advance(500);
    expect(result.current.problem?.message).toBe("Validation offline");
    await act(async () => { reject(new Error("Old failure")); });
    expect(result.current.problem?.message).toBe("Validation offline");
  });
});
