import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScenarioEditor } from "./useScenarioEditor";

describe("useScenarioEditor", () => {
  it("exposes independent baseline and candidate variants", () => {
    const { result } = renderHook(() => useScenarioEditor());
    const originalBaseline = result.current.baseline;
    const originalCandidate = result.current.candidate;
    const originalExecution = result.current.execution;

    act(() => {
      result.current.updateService("baseline", originalBaseline.services[0].id, {
        handlers: 8,
      });
    });

    expect(result.current.baseline.services[0].handlers).toBe(8);
    expect(result.current.candidate).toBe(originalCandidate);
    expect(result.current.execution).toBe(originalExecution);
    expect(result.current.baseline).not.toBe(originalBaseline);
    expect(originalBaseline.services[0].handlers).not.toBe(8);
  });

  it("selects the active variant and updates only that variant", () => {
    const { result } = renderHook(() => useScenarioEditor());
    const baseline = result.current.baseline;

    act(() => result.current.selectActiveVariant("candidate"));
    act(() => {
      result.current.updateWorkload({ arrivalRate: 20 });
    });

    expect(result.current.activeVariantId).toBe("candidate");
    expect(result.current.candidate.workload.arrivalRate).toBe(20);
    expect(result.current.baseline).toBe(baseline);
  });

  it("adds and deletes a service with its attached links", () => {
    const { result } = renderHook(() => useScenarioEditor());
    const link = result.current.baseline.links[1];

    act(() => result.current.addService());
    expect(result.current.baseline.services).toHaveLength(4);
    expect(result.current.baseline.services[3].id).toBe("service-4");
    expect(result.current.issues.some((issue) => issue.message.includes("connected"))).toBe(true);

    act(() => result.current.deleteService(result.current.baseline.services[2].id));
    expect(result.current.baseline.services).toHaveLength(3);
    expect(result.current.baseline.links.some(({ id }) => id === link.id)).toBe(false);
  });

  it("allocates unique service and link IDs for batched calls", () => {
    const { result } = renderHook(() => useScenarioEditor());

    act(() => {
      result.current.addService();
      result.current.addService();
    });
    act(() => {
      result.current.connectServices("service-1", "service-3");
      result.current.connectServices("service-3", "service-4");
    });

    expect(result.current.baseline.services.map(({ id }) => id)).toEqual([
      "service-1",
      "service-2",
      "service-3",
      "service-4",
      "service-5",
    ]);
    expect(result.current.baseline.links.map(({ id }) => id)).toEqual([
      "link-1",
      "link-2",
      "link-3",
      "link-4",
    ]);
  });

  it("connects services without duplicating an edge", () => {
    const { result } = renderHook(() => useScenarioEditor());
    const firstLink = result.current.baseline.links[0];
    const originalLinks = result.current.baseline.links;

    act(() => result.current.connectServices(firstLink.from, firstLink.to));
    expect(result.current.baseline.links).toHaveLength(2);

    act(() => result.current.connectServices(firstLink.from, firstLink.to));
    expect(result.current.baseline.links).toBe(originalLinks);
  });

  it("updates link, degradation, and execution state immutably", () => {
    const { result } = renderHook(() => useScenarioEditor());
    const scenario = result.current.baseline;
    const execution = result.current.execution;
    const linkId = scenario.links[0].id;

    act(() => result.current.updateLink(linkId, { timeoutMs: 250 }));
    act(() => {
      result.current.updateDegradation({
        serviceId: scenario.services[1].id,
        startMs: 100,
        endMs: 500,
        processingMultiplier: 2,
        failureRate: null,
      });
    });
    act(() => result.current.updateExecution({ replications: 5 }));

    expect(result.current.baseline.links[0].timeoutMs).toBe(250);
    expect(result.current.baseline.degradation?.processingMultiplier).toBe(2);
    expect(result.current.execution.replications).toBe(5);
    expect(scenario.links[0].timeoutMs).not.toBe(250);
    expect(scenario.degradation).toBeNull();
    expect(execution.replications).not.toBe(5);
  });

  it("loads a fresh three-service chain and the retry-storm example", () => {
    const { result } = renderHook(() => useScenarioEditor());
    const beforeReset = result.current.baseline;

    act(() => result.current.newThreeServiceChain());
    expect(result.current.baseline).not.toBe(beforeReset);
    expect(result.current.baseline.services).toHaveLength(3);

    act(() => result.current.loadRetryStormExample());
    expect(result.current.baseline.degradation).toBeNull();
    expect(result.current.candidate.degradation).not.toBeNull();
    expect(result.current.candidate.links[0].retry.base).toBe(2);
    expect(result.current.activeVariantId).toBe("baseline");
  });
});
