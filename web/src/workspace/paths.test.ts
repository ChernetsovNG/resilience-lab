import { describe, expect, it } from "vitest";
import { resolveRef } from "./paths";

describe("resolveRef", () => {
  it("resolves references against the document directory", () => {
    expect(resolveRef("a/b.experiment.json", "m.model.json")).toBe("a/m.model.json");
    expect(resolveRef("a/b.experiment.json", "../m.model.json")).toBe("m.model.json");
    expect(resolveRef("b.experiment.json", "./x/m.model.json")).toBe("x/m.model.json");
  });

  it("rejects references that leave the workspace or are not relative", () => {
    expect(resolveRef("b.experiment.json", "../m.model.json")).toBeNull();
    expect(resolveRef("b.experiment.json", "/m.model.json")).toBeNull();
    expect(resolveRef("b.experiment.json", "https://x/m.model.json")).toBeNull();
  });
});
