import { describe, expect, it } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { editorReducer, initialEditorState, type EditorCommand, type EditorDocuments } from "./editor";
import {
  addFault, addVariant, nextVariantId, removeFault, removeVariant, resetVariantParam,
  setExecutionParam, setFaultParam, setVariantParam, updateVariant, variantIdError,
} from "./experimentCommands";
import { applyOverrides, elementOf, withParam } from "./params";

const documents: EditorDocuments = { model, layout, experiment };
const overrides = (result: EditorDocuments) => result.experiment.variants[1].overrides;

describe("variant parameter commands", () => {
  it("writes the exact scalar or object-field path and changes only the experiment", () => {
    const scalar = setVariantParam("no-retries", "gateway-to-middle", "timeout", "90ms", catalog)(documents);
    const nested = setVariantParam("no-retries", "gateway-to-middle", "backoff.base", "4ms", catalog)(scalar);
    expect(overrides(nested)).toEqual({
      "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1,
      "gateway-to-middle.timeout": "90ms", "gateway-to-middle.backoff.base": "4ms",
    });
    expect(nested.model).toBe(model);
    expect(nested.layout).toBe(layout);
    expect(experiment.variants[1].overrides).not.toHaveProperty("gateway-to-middle.timeout");
  });

  it("removes values equal to the model, including equivalent units and catalog defaults", () => {
    let edited = setVariantParam("no-retries", "gateway-to-middle", "timeout", "90ms", catalog)(documents);
    edited = setVariantParam("no-retries", "gateway-to-middle", "timeout", "0.08s", catalog)(edited);
    edited = setVariantParam("no-retries", "gateway", "failureRate", "0%", catalog)(edited);
    edited = setVariantParam("no-retries", "gateway-to-middle", "attempts", 3, catalog)(edited);
    expect(overrides(edited)).toEqual({ "middle-to-dependency.attempts": 1 });
  });

  it("resets one field or an entire object without removing sibling or other-element overrides", () => {
    let edited = setVariantParam("no-retries", "gateway-to-middle", "backoff.base", "4ms", catalog)(documents);
    edited = setVariantParam("no-retries", "gateway-to-middle", "backoff.max", "40ms", catalog)(edited);
    edited = resetVariantParam("no-retries", "gateway-to-middle", "backoff.base", catalog)(edited);
    expect(overrides(edited)).toEqual({
      "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1,
      "gateway-to-middle.backoff.max": "40ms",
    });
    expect(overrides(resetVariantParam("no-retries", "gateway-to-middle", "backoff", catalog)(edited)))
      .toEqual(experiment.variants[1].overrides);
  });

  it("splits an existing object override when resetting a field and preserves its effective siblings", () => {
    const input: EditorDocuments = { ...documents, experiment: { ...experiment, variants: [experiment.variants[0], {
      ...experiment.variants[1], overrides: {
        "gateway-to-middle.backoff": { kind: "fixed", base: "4ms" },
        "gateway-to-middle.backoff.base": "6ms", "middle-to-dependency.attempts": 1,
      },
    }] } };
    const result = resetVariantParam("no-retries", "gateway-to-middle", "backoff.base", catalog)(input);
    expect(overrides(result)).toEqual({
      "middle-to-dependency.attempts": 1, "gateway-to-middle.backoff.kind": "fixed", "gateway-to-middle.backoff.max": "0ms",
    });
    const effective = applyOverrides(result.model, overrides(result), catalog);
    expect(elementOf(effective, "gateway-to-middle")?.params.backoff).toMatchObject({ kind: "fixed", base: "2ms", max: "0ms" });
  });

  it("starts missing objects from catalog defaults without materializing untouched fields", () => {
    const input = { ...documents, model: withParam(model, "gateway-to-middle", "network", undefined) };
    const edited = setVariantParam("no-retries", "gateway-to-middle", "network.mean", "3ms", catalog)(input);
    expect(overrides(edited)).toEqual({ ...experiment.variants[1].overrides, "gateway-to-middle.network.mean": "3ms" });
    expect(overrides(setVariantParam("no-retries", "gateway-to-middle", "network.mean", "0s", catalog)(edited)))
      .toEqual(experiment.variants[1].overrides);
  });

  it("preserves absent optional siblings when a whole-object override becomes field overrides", () => {
    const input = { ...documents,
      model: withParam(model, "gateway", "processing", { kind: "lognormal", mean: "2ms", stdDev: "1ms" }),
      experiment: { ...experiment, variants: [experiment.variants[0], {
        ...experiment.variants[1], overrides: { "gateway.processing": { kind: "fixed", mean: "3ms" } },
      }] },
    };
    const edited = setVariantParam("no-retries", "gateway", "processing.mean", "4ms", catalog)(input);
    expect(overrides(edited)).toEqual({ "gateway.processing.kind": "fixed", "gateway.processing.mean": "4ms", "gateway.processing.stdDev": null });
    expect(elementOf(applyOverrides(edited.model, overrides(edited), catalog), "gateway")?.params.processing)
      .toEqual({ kind: "fixed", mean: "4ms", stdDev: null });
  });

  it("clears optional variant fields to catalog defaults and distinguishes this from restoring the model", () => {
    const input = { ...documents, model: withParam(model, "gateway", "processing", { kind: "lognormal", mean: "2ms", stdDev: "1ms" }) };
    const cleared = setVariantParam("no-retries", "gateway", "processing.stdDev", null, catalog)(input);
    expect(overrides(cleared)).toHaveProperty("gateway.processing.stdDev", null);
    const reset = resetVariantParam("no-retries", "gateway", "processing.stdDev", catalog)(cleared);
    expect(overrides(reset)).toEqual(experiment.variants[1].overrides);
    expect(overrides(setVariantParam("no-retries", "gateway", "processing.stdDev", null, catalog)(documents)))
      .toEqual(experiment.variants[1].overrides);
  });

  it.each([
    ["1001ms", "1.001s", true], ["1001ms", "1.001000000000001s", false],
    ["9007199254740991ms", "9007199254740990ms", false], ["60000ms", "1min", true],
    ["1000ms", "1e0s", true], ["0ms", "0e999999999999s", true],
  ])("compares decimal quantity %s against %s exactly", (base, value, equal) => {
    const input = { ...documents, model: withParam(model, "gateway-to-middle", "timeout", base) };
    const edited = setVariantParam("no-retries", "gateway-to-middle", "timeout", value, catalog)(input);
    expect(Object.hasOwn(overrides(edited), "gateway-to-middle.timeout")).toBe(!equal);
  });
});

describe("variant management commands", () => {
  it("adds an empty variant or an independent copy and finds a free identifier", () => {
    const added = addVariant("variant-1", "Variant 1")(documents);
    expect(added.experiment.variants[2]).toEqual({ id: "variant-1", label: "Variant 1", overrides: {} });
    expect(nextVariantId(added.experiment.variants)).toBe("variant-2");
    const copied = addVariant("variant-2", "Copy", "no-retries")(added);
    expect(copied.experiment.variants[3]).toEqual({ id: "variant-2", label: "Copy", overrides: experiment.variants[1].overrides });
    expect(copied.experiment.variants[3].overrides).not.toBe(experiment.variants[1].overrides);
  });

  it("renames an identifier and label without losing the variant overrides or changing other variants", () => {
    const result = updateVariant("no-retries", { id: "single-attempt", label: "Single attempt" })(documents);
    expect(result.experiment.variants[1]).toEqual({ id: "single-attempt", label: "Single attempt", overrides: experiment.variants[1].overrides });
    expect(result.experiment.variants[0]).toBe(experiment.variants[0]);
    expect(result.model).toBe(model);
    expect(updateVariant("no-retries", { label: "" })(documents).experiment.variants[1]).not.toHaveProperty("label");
  });

  it("uses the compiler ID rules, rejects duplicates and preserves at least one variant", () => {
    for (const id of ["", ".bad", "bad/id", "bad.id", "bad id", "-bad"]) expect(variantIdError(experiment.variants, id)).toBeTruthy();
    expect(variantIdError(experiment.variants, "baseline")).toBeTruthy();
    expect(variantIdError(experiment.variants, "baseline", "baseline")).toBeNull();
    expect(variantIdError(experiment.variants, "constructor")).toBeNull();
    expect(variantIdError(experiment.variants, "1_variant-2")).toBeNull();
    expect(updateVariant("no-retries", { id: "baseline" })(documents)).toBe(documents);
    expect(addVariant("baseline", "Duplicate")(documents)).toBe(documents);
    const removed = removeVariant("no-retries")(documents);
    expect(removed.experiment.variants).toEqual([experiment.variants[0]]);
    expect(removeVariant("baseline")(removed)).toBe(removed);
  });
});

describe("shared experiment commands and history", () => {
  it("edits execution and fault fields and removes cleared optional values", () => {
    let result = setExecutionParam("seed", 9_007_199_254_740_991)(documents);
    result = setExecutionParam("measurement", "2s")(result);
    result = setFaultParam(0, "target", "middle")(result);
    result = setFaultParam(0, "from", "100ms")(result);
    result = setFaultParam(0, "failureRate", undefined)(result);
    expect(result.experiment.execution).toEqual({ ...experiment.execution, seed: 9_007_199_254_740_991, measurement: "2s" });
    expect(result.experiment.faults[0]).toEqual({ target: "middle", from: "100ms", to: "700ms", processingMultiplier: 6 });
    expect(result.experiment.variants).toBe(experiment.variants);
    expect(result.model).toBe(model);
  });

  it("undoes and redoes each command atomically without changing model or layout", () => {
    const commands: EditorCommand[] = [
      setVariantParam("no-retries", "gateway-to-middle", "backoff.base", "4ms", catalog),
      resetVariantParam("no-retries", "gateway-to-middle", "attempts", catalog),
      addVariant("new", "New", "no-retries"), updateVariant("no-retries", { id: "changed", label: "Changed" }),
      removeVariant("no-retries"), setExecutionParam("replications", 5),
      setFaultParam(0, "to", "800ms"), removeFault(0),
      addFault({ target: "middle", from: "0ms", to: "1s", failureRate: "10%" }),
    ];
    const loaded = { ...documents, experimentPath: "test.experiment.json", modelPath: "test.model.json", layoutPath: "test.layout.json",
      saved: documents, versions: { model: "m", layout: "l", experiment: "e" } };
    const initial = editorReducer(initialEditorState, { type: "open", loaded });
    for (const command of commands) {
      const edited = editorReducer(initial, { type: "command", command });
      expect(edited.past).toHaveLength(1);
      expect(edited.loaded?.model).toBe(model);
      expect(edited.loaded?.layout).toBe(layout);
      const undone = editorReducer(edited, { type: "undo" });
      expect(undone.loaded).toEqual(loaded);
      expect(editorReducer(undone, { type: "redo" }).loaded).toEqual(edited.loaded);
    }
  });
});
