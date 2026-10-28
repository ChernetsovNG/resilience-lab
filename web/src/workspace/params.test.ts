import { describe, expect, it } from "vitest";
import { catalog, model } from "../test/fixtures";
import { applyOverrides, elementOf, isOverridden, withParam } from "./params";

describe("withParam", () => {
  it("sets and removes parameters of blocks and connections without changing the source", () => {
    const changed = withParam(model, "gateway", "handlers", 6);
    expect(changed.blocks.gateway.params.handlers).toBe(6);
    expect(model.blocks.gateway.params.handlers).toBe(4);

    expect("queue" in withParam(model, "gateway", "queue", undefined).blocks.gateway.params).toBe(false);
    expect(elementOf(withParam(model, "gateway-to-middle", "attempts", 1), "gateway-to-middle")?.params.attempts).toBe(1);
    expect(elementOf(model, "missing")).toBeNull();
  });

  it("updates a nested parameter without replacing its sibling fields", () => {
    const changed = withParam(model, "gateway", "processing.mean", "3ms");

    expect(changed.blocks.gateway.params.processing).toEqual({ kind: "fixed", mean: "3ms" });
    expect(model.blocks.gateway.params.processing).toEqual({ kind: "fixed", mean: "1ms" });
  });

  it("removes a nested parameter without removing its sibling fields", () => {
    const changed = withParam(model, "gateway", "processing.mean", undefined);

    expect(changed.blocks.gateway.params.processing).toEqual({ kind: "fixed" });
    expect(model.blocks.gateway.params.processing).toEqual({ kind: "fixed", mean: "1ms" });
  });

  it("treats inherited names such as constructor as ordinary IDs", () => {
    const withConstructor = {
      ...model,
      connections: model.connections.map((connection) =>
        connection.id === "gateway-to-middle" ? { ...connection, id: "constructor" } : connection,
      ),
    };

    expect(elementOf(model, "constructor")).toBeNull();
    expect(elementOf(withConstructor, "constructor")?.type).toBe("call");
    const overridden = applyOverrides(withConstructor, { "constructor.attempts": 1 }, catalog);
    expect(elementOf(overridden, "constructor")?.params.attempts).toBe(1);
  });
});

describe("applyOverrides", () => {
  it("applies top-level and nested overrides; a missing object starts from its catalog default", () => {
    const withoutNetwork = withParam(model, "middle-to-dependency", "network", undefined);

    const effective = applyOverrides(
      withoutNetwork,
      { "gateway-to-middle.attempts": 1, "middle-to-dependency.network.mean": "3ms", "unknown.attempts": 1 },
      catalog,
    );

    expect(elementOf(effective, "gateway-to-middle")?.params.attempts).toBe(1);
    expect(elementOf(effective, "middle-to-dependency")?.params.network).toEqual({ kind: "fixed", mean: "3ms" });
    expect(applyOverrides(model, {}, catalog)).toBe(model);
  });

  it("applies an object override before overrides of its fields whatever their order, like the core compiler", () => {
    const effective = applyOverrides(
      model,
      { "gateway.processing.mean": "3ms", "gateway.processing": { kind: "fixed", mean: "2ms" } },
      catalog,
    );

    expect(elementOf(effective, "gateway")?.params.processing).toEqual({ kind: "fixed", mean: "3ms" });
  });
});

describe("isOverridden", () => {
  it("marks an overridden parameter, the object that holds it and its fields", () => {
    const overrides = { "gateway-to-middle.backoff.base": "5ms", "gateway-to-middle.attempts": 1 };

    expect(isOverridden(overrides, "gateway-to-middle", "attempts")).toBe(true);
    expect(isOverridden(overrides, "gateway-to-middle", "backoff")).toBe(true);
    expect(isOverridden(overrides, "gateway-to-middle", "backoff.base")).toBe(true);
    expect(isOverridden(overrides, "gateway-to-middle", "backoff.max")).toBe(false);
    expect(isOverridden(overrides, "middle-to-dependency", "attempts")).toBe(false);
  });
});
