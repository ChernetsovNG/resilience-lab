import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../test/stubFetch";
import { useHealth } from "./useHealth";

afterEach(() => vi.unstubAllGlobals());

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

  it("ignores health arriving after unmount", async () => {
    let release!: () => void;
    stubFetch(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { body: health };
    });
    const { result, unmount } = renderHook(useHealth);
    unmount();
    await act(async () => { release(); });
    expect(result.current).toEqual({ health: null, error: null });
  });
});
