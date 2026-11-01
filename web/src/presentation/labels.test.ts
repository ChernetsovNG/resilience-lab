import { expect, it } from "vitest";
import { model } from "../test/fixtures";
import { diagnosticMessage, elementLabel, parameterLabel } from "./labels";

it.each([
  ["gateway-to-middle", "gateway → middle (gateway-to-middle)"],
  ["gateway-to-middle#2", "gateway#2 → middle (gateway-to-middle#2)"],
  ["client-to-gateway", "client → gateway (client-to-gateway)"],
  ["gateway", "gateway"],
  ["gateway#2", "gateway#2"],
  ["missing", "missing"],
])("identifies connection endpoints without changing %s", (id, label) => {
  expect(elementLabel(id, model)).toBe(label);
});

it("shows endpoints for manual connection ids and retains unknown ids without a model", () => {
  const source = { ...model, connections: [{ ...model.connections[1], id: "rpc" }] };
  expect(elementLabel("rpc", source)).toBe("gateway → middle (rpc)");
  expect(elementLabel("rpc")).toBe("rpc");
});

it("formats diagnostic connection arguments while retaining their navigation identity", () => {
  const diagnostic = { code: "SCENARIO_CONNECTION", message: "Invalid connection", path: "gateway",
    args: { service: "gateway", connection: "gateway-to-middle" } };
  expect(diagnosticMessage(diagnostic, undefined, model)).toContain("gateway → middle (gateway-to-middle)");
  expect(diagnostic.args.connection).toBe("gateway-to-middle");
});

const named = { ...model, blocks: { ...model.blocks,
  client: { ...model.blocks.client, title: "Мобильное приложение" },
  gateway: { ...model.blocks.gateway, title: "Магазин" },
  middle: { ...model.blocks.middle, title: "Магазин" },
} };

it("uses display names for blocks, connection endpoints and replica copies without changing identifiers", () => {
  expect(elementLabel("client", named)).toBe("Мобильное приложение");
  expect(elementLabel("gateway", named)).toBe("Магазин");
  expect(elementLabel("middle", named)).toBe("Магазин");
  expect(elementLabel("gateway#2", named)).toContain("Магазин");
  expect(elementLabel("gateway#2", named)).toContain("2");
  expect(elementLabel("client-to-gateway", named)).toBe("Мобильное приложение → Магазин (client-to-gateway)");
  expect(elementLabel("dependency", named)).toBe("dependency");
  expect(elementLabel("missing", named)).toBe("missing");
});

it("uses the display name in grid axes and diagnostic arguments, retaining source paths", () => {
  expect(parameterLabel("gateway.handlers", undefined, named)).toContain("Магазин");
  const diagnostic = { code: "SCENARIO_CONNECTION", message: "Invalid connection", path: "gateway",
    args: { service: "gateway", connection: "gateway-to-middle" } };
  expect(diagnosticMessage(diagnostic, undefined, named)).toContain("Магазин");
  expect(diagnosticMessage(diagnostic, undefined, named)).toContain("service 'Магазин'");
  expect(diagnostic.args.service).toBe("gateway");
});
