import { describe, expect, it } from "vitest";
import { createThreeServiceChain } from "./factory";
import { validateChain } from "./chainGuards";

function messages(scenario: ReturnType<typeof createThreeServiceChain>) {
  return validateChain(scenario).map((issue) => issue.message).join("\n");
}

describe("linear chain guards", () => {
  it("accepts the factory chain", () => {
    expect(validateChain(createThreeServiceChain())).toEqual([]);
  });

  it("reports a disconnected service", () => {
    const scenario = createThreeServiceChain();
    scenario.links = scenario.links.slice(0, 1);

    expect(messages(scenario)).toContain("connected to the entry chain");
  });

  it("reports an outgoing branch", () => {
    const scenario = createThreeServiceChain();
    scenario.links.push({
      ...scenario.links[0],
      id: "branch",
      to: scenario.services[2].id,
    });

    expect(messages(scenario)).toContain("at most one outgoing link");
  });

  it("reports an incoming branch", () => {
    const scenario = createThreeServiceChain();
    scenario.links = [scenario.links[0]];
    scenario.links.push({
      ...scenario.links[0],
      id: "incoming-branch",
      from: scenario.services[2].id,
      to: scenario.services[1].id,
    });

    expect(messages(scenario)).toContain("at most one incoming link");
  });

  it("reports a cycle", () => {
    const scenario = createThreeServiceChain();
    scenario.links.push({
      ...scenario.links[0],
      id: "cycle",
      from: scenario.services[2].id,
      to: scenario.services[0].id,
    });

    expect(messages(scenario)).toContain("must not close a cycle");
  });

  it("reports duplicate service and link IDs", () => {
    const scenario = createThreeServiceChain();
    scenario.services.push({ ...scenario.services[0] });
    scenario.links.push({ ...scenario.links[0] });

    const result = messages(scenario);
    expect(result).toContain(`Service ID '${scenario.services[0].id}' is duplicated`);
    expect(result).toContain(`Link ID '${scenario.links[0].id}' is duplicated`);
  });

  it("reports a duplicate edge", () => {
    const scenario = createThreeServiceChain();
    scenario.links.push({ ...scenario.links[0], id: "duplicate-edge" });

    expect(messages(scenario)).toContain("Duplicate edge");
  });

  it("reports links to unknown services and an invalid entry", () => {
    const scenario = createThreeServiceChain();
    scenario.entry = "missing-entry";
    scenario.links[0].to = "missing-service";

    const result = messages(scenario);
    expect(result).toContain("entry must reference an existing service");
    expect(result).toContain("must reference an existing service");
  });
});
