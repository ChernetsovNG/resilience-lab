import { afterEach, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { deleteElements } from "../workspace/structure";
import { deletionMessage } from "./deletion";

const documents = () => structuredClone({ model, layout, experiment });
afterEach(async () => { await setLanguage("en"); });

it.each(["en", "ru"] as const)("lists only removed experiment settings with their context in %s", async locale => {
  await setLanguage(locale);
  const before = documents();
  before.experiment.grid = [
    { path: "middle-to-dependency.timeout", values: ["40ms", "80ms"] },
    { path: "gateway.handlers", values: [2, 4] },
  ];
  before.experiment.variants[1].overrides["gateway.handlers"] = 3;
  const message = deletionMessage(before, deleteElements(["dependency"])(before), catalog, "shop/psp-outage.experiment.json")!;
  expect(message).toContain("psp-outage");
  expect(message).toContain("dependency");
  expect(message).toContain("middle → dependency (middle-to-dependency)");
  expect(message).toContain(locale === "ru" ? "Замедление" : "Slowdown");
  expect(message).toContain(locale === "ru" ? "Таймаут · middle → dependency" : "Timeout · middle → dependency");
  expect(message).toContain("No retries");
  expect(message).toContain("Undo");
  expect(message).not.toContain("gateway.handlers");
  expect(message).not.toContain("gateway → middle");
  expect(before.experiment.faults).toHaveLength(1);
});

it("does not confirm links or isolated blocks without removed experiment references", () => {
  const before = documents();
  before.experiment = { ...before.experiment, faults: [], grid: [], variants: [{ id: "baseline", overrides: {} }] };
  before.model.blocks.unused = { type: "service", params: {} };
  for (const selection of [["middle"], ["client-to-gateway"], ["unused"]]) {
    expect(deletionMessage(before, deleteElements(selection)(before), catalog, "shop.experiment.json")).toBeNull();
  }
});

it("includes settings removed with nested repeat steps on a surviving block", () => {
  const before = documents();
  before.model.blocks.gateway.scenario = [{ type: "parallel", branches: [[{
    type: "call", id: "retry", connection: "gateway-to-middle", repeat: { count: 2, mode: "parallel" },
  }]] }];
  before.experiment.grid = [{ path: "gateway.steps.retry.repeat.count", values: [2, 3] }];
  before.experiment.variants[1].overrides = { "gateway.steps.retry.repeat.count": 4 };
  const after = deleteElements(["gateway-to-middle"])(before);
  const message = deletionMessage(before, after, catalog, "shop.experiment.json")!;
  expect(message).toContain("retry");
  expect(message).toContain("No retries");
  expect(message).toContain("shop");
});

it("bounds long lists without losing the variant count or hidden item count", () => {
  const before = documents();
  before.experiment.faults = Array.from({ length: 10 }, () => ({
    target: "dependency", from: "0ms", to: "1s", kind: "blackhole" as const,
  }));
  const message = deletionMessage(before, deleteElements(["dependency"])(before), catalog, "shop.experiment.json")!;
  expect(message.match(/Black hole/g)).toHaveLength(5);
  expect(message).toContain("and 5 more");
});
