import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { costEstimate } from "./test/fixtures";
import { setupAppTests, otherPath, completed, deferred, server, open, button, experimentSelect } from "./test/app";

setupAppTests();


it.each(["Estimate", "Run"])("keeps Analysis while %s follows its estimate visibility policy", async action => {
  server(); await open();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Answer" });
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(button("Analysis"));
  fireEvent.click(button("Collapse results"));
  fireEvent.click(button(action));
  if (action === "Estimate") await screen.findByRole("region", { name: "Cost estimate" });
  else {
    await waitFor(() => expect(button("Run").disabled).toBe(false));
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
  }
  expect(document.querySelector(".workspace-panels")!.className).toContain("workspace-panels--analysis");
  expect(document.querySelector(".app")!.className).toContain("app--results-normal");
});

it("keeps ordinary Run estimates hidden during estimation and after completion", async () => {
  const gate = deferred();
  server(async url => {
    if (url !== "/api/v1/estimate") return undefined;
    await gate.promise;
    return { body: costEstimate };
  });
  await open();
  fireEvent.click(button("Run"));
  expect(screen.queryByRole("region", { name: "Estimate" })).toBeNull();
  await act(async () => gate.release());
  await screen.findByRole("table", { name: "Answer" });
  expect(screen.queryByRole("region", { name: "Estimate" })).toBeNull();
  fireEvent.click(button("Estimate"));
  await screen.findByRole("region", { name: "Cost estimate" });
});

it.each(["ESTIMATE_UI_CACHE", "ESTIMATE_EXTRAPOLATION"])("shows %s only until the submitted job starts", async code => {
  const gate = deferred();
  let submitted = false;
  const nativeConfirm = vi.spyOn(window, "confirm");
  server(async url => {
    if (url === "/api/v1/estimate") return { body: { ...costEstimate, warnings: [{ code, message: "Run cost warning" }] } };
    if (url === "/api/v1/jobs") { submitted = true; await gate.promise; return { status: 202, body: completed }; }
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  if (code === "ESTIMATE_UI_CACHE") {
    const dialog = await screen.findByRole("dialog", { name: "Start run?" });
    expect(submitted).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start run" }));
  }
  await waitFor(() => expect(submitted).toBe(true));
  expect(screen.getByRole("region", { name: "Cost estimate" }).textContent).toContain("Run cost warning");
  await act(async () => gate.release());
  await screen.findByRole("table", { name: "Answer" });
  expect(screen.queryByRole("region", { name: "Estimate" })).toBeNull();
  expect(nativeConfirm).not.toHaveBeenCalled();
});

it("keeps an automatically closed estimate hidden while another experiment opens", async () => {
  const gate = deferred();
  server(async url => {
    if (url === "/api/v1/estimate") return { body: { ...costEstimate,
      warnings: [{ code: "ESTIMATE_EXTRAPOLATION", message: "Timing anchors exceeded" }],
    } };
    if (url.startsWith("/api/v1/workspace/document?") && new URL(url, "http://localhost").searchParams.get("path") === otherPath) {
      await gate.promise;
    }
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Answer" });
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  expect(screen.queryByRole("region", { name: "Estimate" })).toBeNull();
  fireEvent.change(experimentSelect(), { target: { value: otherPath } });
  expect(screen.queryByRole("region", { name: "Estimate" })).toBeNull();
  await act(async () => gate.release());
  await waitFor(() => expect(experimentSelect().value).toBe(otherPath));
  expect(screen.queryByRole("region", { name: "Estimate" })).toBeNull();
});

it.each(["Timeline", "Problems"])("preserves a tab selected during Run estimation: %s", async tab => {
  const pending = deferred();
  const fetchMock = server(async url => {
    if (url !== "/api/v1/estimate") return undefined;
    await pending.promise;
    return { body: costEstimate };
  });
  await open();
  fireEvent.click(button("Run"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/estimate")).toBe(true));
  fireEvent.click(screen.getByRole("tab", { name: tab }));
  await act(async () => pending.release());
  await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED"));
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  expect(screen.getByRole("tab", { name: tab }).getAttribute("aria-selected")).toBe("true");
});

it.each(["Estimate", "Run"])("reveals the prior tab when %s never submits a new job", async action => {
  const nativeConfirm = vi.spyOn(window, "confirm");
  const fetchMock = server(url => url === "/api/v1/estimate" ? { body: { ...costEstimate,
    warnings: [{ code: "ESTIMATE_UI_CACHE", message: "Cache budget exceeded" }],
  } } : undefined);
  await open();
  fireEvent.click(button("Run"));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Start run?" })).getByRole("button", { name: "Start run" }));
  await screen.findByRole("table", { name: "Answer" });
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(button("Collapse results"));
  fireEvent.click(button(action));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/estimate")).toHaveLength(2));
  if (action === "Run") {
    const dialog = await screen.findByRole("dialog", { name: "Start run?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Review estimate" }));
  }
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  expect(nativeConfirm).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector(".app")!.className).toContain("app--results-normal");
});
