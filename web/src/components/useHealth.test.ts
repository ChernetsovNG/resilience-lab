import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/apiClient";
import { stubFetch } from "../test/stubFetch";
import { useHealth } from "./useHealth";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const health = { status: "ok", applicationVersion: "0.1.0", kslVersion: "R1.8.1" };

describe("useHealth", () => {
  it("loads backend health once and retains it through rerenders", async () => {
    const fetch = stubFetch(() => ({ body: health }));
    const { result, rerender } = renderHook(useHealth);
    await waitFor(() => expect(result.current.health).toEqual(health));
    expect(result.current.error).toBeNull();
    rerender();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/v1/health", undefined);
  });

  it("reports health request errors", async () => {
    stubFetch(() => { throw new Error("Connection refused"); });
    const { result } = renderHook(useHealth);
    await waitFor(() => expect(result.current.error).toBe("Connection refused"));
    expect(result.current.health).toBeNull();
  });

  it("retries an initial failure and stops retrying after recovery", async () => {
    vi.useFakeTimers();
    let unavailable = true;
    const fetch = stubFetch(() => {
      if (unavailable) throw new TypeError("offline");
      return { body: health };
    });
    const { result } = renderHook(useHealth);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.error).toBe("offline");
    unavailable = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.health).toEqual(health);
    expect(result.current.error).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("clears retry timers on unmount", async () => {
    vi.useFakeTimers();
    const fetch = stubFetch(() => { throw new TypeError("offline"); });
    const { unmount } = renderHook(useHealth);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks health immediately once after a successful poll despite long backoff", async () => {
    vi.useFakeTimers();
    let unavailable = true;
    let release!: () => void;
    const fetch = stubFetch(async () => {
      if (unavailable) throw new TypeError("offline");
      await new Promise<void>(resolve => { release = resolve; });
      return { body: health };
    });
    const { result } = renderHook(useHealth);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(fetch).toHaveBeenCalledTimes(4);

    unavailable = false;
    await act(async () => {
      result.current.reportSuccess();
      result.current.reportSuccess();
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(result.current.health).toBeNull();
    expect(result.current.error).toBe("offline");
    await act(async () => {
      result.current.reportSuccess();
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetch).toHaveBeenCalledTimes(5);

    await act(async () => { release(); });
    expect(result.current.health).toEqual(health);
    expect(result.current.error).toBeNull();
    await act(async () => {
      result.current.reportSuccess();
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("keeps backoff after a failed immediate check and allows one new check per outage", async () => {
    vi.useFakeTimers();
    let unavailable = true;
    const fetch = stubFetch(() => {
      if (unavailable) throw new TypeError("offline");
      return { body: health };
    });
    const { result } = renderHook(useHealth);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { result.current.reportSuccess(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe("offline");
    await act(async () => {
      result.current.reportSuccess();
      result.current.reportSuccess();
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    unavailable = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.current.health).toEqual(health);
    expect(result.current.error).toBeNull();
    act(() => result.current.reportFailure(new TypeError("new outage")));
    await act(async () => { result.current.reportSuccess(); });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.current.health).toEqual(health);
    expect(result.current.error).toBeNull();
  });

  it("keeps recovering when a successful retry and a new poll failure are batched", async () => {
    vi.useFakeTimers();
    let resolveRetry!: (value: typeof health) => void;
    const pendingRetry = new Promise<typeof health>(resolve => { resolveRetry = resolve; });
    const check = vi.spyOn(api, "health").mockResolvedValueOnce(health).mockReturnValueOnce(pendingRetry).mockResolvedValue(health);
    const { result } = renderHook(useHealth);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.reportFailure(new TypeError("first outage")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => {
      resolveRetry(health);
      await Promise.resolve();
      result.current.reportFailure(new TypeError("new failed poll"));
    });
    expect(result.current.error).toBe("new failed poll");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.error).toBeNull();
    expect(result.current.health).toEqual(health);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does not let a late initial health response erase a reported outage", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let initial = true;
    stubFetch(async () => {
      if (initial) {
        initial = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return { body: health };
    });
    const { result } = renderHook(useHealth);
    act(() => result.current.reportFailure(new TypeError("offline")));
    await act(async () => { release(); });
    expect(result.current.error).toBe("offline");
    expect(result.current.health).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.error).toBeNull();
    expect(result.current.health).toEqual(health);
  });

  it("ignores health arriving after unmount", async () => {
    let release!: () => void;
    stubFetch(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { body: health };
    });
    const { result, unmount } = renderHook(useHealth);
    unmount();
    await act(async () => { release(); });
    expect(result.current).toMatchObject({ health: null, error: null });
  });
});
