import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { button, editHandlers, health, server, setupAppTests } from "./test/app";

setupAppTests();
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function ready() {
  render(<App />);
  await advance(0);
  await advance(500);
  expect(button("Run").disabled).toBe(false);
}

describe("backend availability", () => {
  it("uses successful workspace polls without additional health checks", async () => {
    const fetch = server();
    await ready();
    await advance(15_000);
    expect(screen.getByText(/Backend healthy/)).toBeTruthy();
    expect(fetch.mock.calls.filter(([url]) => url === "/api/v1/health")).toHaveLength(1);
    expect(button("Run").disabled).toBe(false);
  });

  it.each(["network", "5xx"])("recovers within one poll after a %s outage with long health backoff and keeps drafts", async (failure) => {
    let unavailable = false;
    let recovered = false;
    const reason = failure === "network" ? "Connection refused" : "Maintenance";
    const fetch = server((url) => {
      if (url !== "/api/v1/health" && !url.startsWith("/api/v1/workspace/changes")) return;
      if (unavailable) {
        if (failure === "network") throw new TypeError(reason);
        return { status: 503, body: { code: "UNAVAILABLE", message: reason, diagnostics: [] } };
      }
      if (url === "/api/v1/health") return { body: { ...health, applicationVersion: recovered ? "recovered" : "test" } };
    });
    const healthCalls = () => fetch.mock.calls.filter(([url]) => url === "/api/v1/health").length;
    await ready();
    unavailable = true;
    await advance(500);

    expect(screen.getAllByText(`Backend unavailable: ${reason}`).length).toBeGreaterThan(0);
    expect(button("Run").disabled).toBe(true);
    expect(button("Estimate").disabled).toBe(true);
    fireEvent.click(screen.getByTestId("rf__node-gateway"));
    editHandlers("8");
    expect(button("Save").disabled).toBe(true);
    for (const command of ["Run", "Estimate", "Save"]) expect(button(command).title).toContain(reason);

    let calls = 1;
    for (const delay of [1000, 2000, 5000, 10_000, 10_000]) {
      await advance(delay - 1);
      expect(healthCalls()).toBe(calls);
      await advance(1);
      expect(healthCalls()).toBe(++calls);
    }

    unavailable = false;
    recovered = true;
    await advance(1000);
    expect(screen.getByText(/Backend healthy · vrecovered/)).toBeTruthy();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("8");
    expect(button("Save").disabled).toBe(false);
    expect(button("Estimate").disabled).toBe(false);
    expect(button("Run").disabled).toBe(false);
    fireEvent.click(button("Undo"));
    await advance(500);
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
    expect(button("Run").disabled).toBe(false);
    await advance(15_000);
    expect(healthCalls()).toBe(calls + 1);
  });

  it.each([400, 409])("does not treat HTTP %i as a server outage", async (status) => {
    let rejectPoll = false;
    const fetch = server((url) => rejectPoll && url.startsWith("/api/v1/workspace/changes")
      ? { status, body: { code: "CURSOR_INVALID", message: "Invalid cursor", diagnostics: [] } } : undefined);
    await ready();
    rejectPoll = true;
    await advance(10_000);
    expect(screen.getByText(/Backend healthy/)).toBeTruthy();
    expect(button("Run").disabled).toBe(false);
    expect(fetch.mock.calls.filter(([url]) => url === "/api/v1/health")).toHaveLength(1);
  });
});
