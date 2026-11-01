import { expect, it } from "vitest";
import type { ModelFile } from "../api/apiTypes";
import { model } from "../test/fixtures";
import { policyOutputAvailable, policyNames } from "./policyParameters";

it("keeps outlier settings read-only and hides their outputs while disabled", () => {
  expect(policyNames.has("outlierDetection")).toBe(true);
  expect(policyOutputAvailable("ejectionsCount", "middle", [model])).toBe(false);
  expect(policyOutputAvailable("ejectedShare", "middle", [model])).toBe(false);
});

it("finds outlier detection on the selector that directly chooses the service instance", () => {
  const direct = { ...model, blocks: { ...model.blocks, middle: { ...model.blocks.middle, params: { ...model.blocks.middle.params, replicas: 3 } } },
    connections: [{ id: "call", type: "call", from: "gateway", to: "middle", params: { outlierDetection: {} } }] };
  expect(policyOutputAvailable("ejectedShare", "middle", [direct])).toBe(true);
  expect(policyOutputAvailable("ejectedShare", "dependency", [direct])).toBe(false);
  const routed: ModelFile = { ...model, blocks: { ...model.blocks,
    router: { type: "router", params: { outlierDetection: {} } }, nested: { type: "router", params: {} },
  }, connections: [
    { id: "branch", type: "route", from: "router", to: "nested", params: {} },
    { id: "target", type: "route", from: "nested", to: "middle", params: {} },
  ] };
  expect(policyOutputAvailable("ejectionsCount", "middle", [routed])).toBe(false);
  expect(policyOutputAvailable("ejectionsCount", "dependency", [routed])).toBe(false);
  routed.blocks.nested.params = { outlierDetection: {} };
  expect(policyOutputAvailable("ejectionsCount", "middle", [routed])).toBe(true);
  routed.blocks.middle = { ...model.blocks.middle, params: { ...model.blocks.middle.params, replicas: 3 } };
  expect(policyOutputAvailable("ejectionsCount", "middle", [routed])).toBe(false);
});
