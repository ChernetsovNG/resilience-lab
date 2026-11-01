import { expect, it } from "vitest";
import { model } from "../test/fixtures";
import { diagnosticMessage, elementLabel } from "./labels";

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
