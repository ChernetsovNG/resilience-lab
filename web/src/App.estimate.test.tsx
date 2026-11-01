import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { costEstimate, experimentPath, modelPath } from "./test/fixtures";
import { setupAppTests, deferred, server, open, selectGateway, editHandlers, button, editField } from "./test/app";

setupAppTests();

it("waits for current validation before estimating a corrected draft with warnings", async () => {
  const gate = deferred();
  let checkingCorrection = false;
  const fetchMock = server(async (url, init) => {
    if (url !== "/api/v1/validate") return undefined;
    const draft = JSON.parse(String(init?.body)).drafts.find((item: { path: string }) => item.path === modelPath);
    const handlers = draft?.content.model.blocks.gateway.params.handlers ?? 4;
    if (handlers === 5) { checkingCorrection = true; await gate.promise; }
    return { body: { experiment: experimentPath, valid: handlers !== 0, diagnostics: handlers === 4 ? [] : [{
      code: "PARAM_RANGE", severity: handlers === 0 ? "ERROR" : "WARNING", message: handlers === 0 ? "Handler error" : "Handler warning",
      document: modelPath, pointer: "/blocks/gateway/params/handlers", path: "gateway",
    }] } };
  });
  await open(); await selectGateway(); editHandlers("0");
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  editHandlers("5");
  fireEvent.click(button("Estimate"));
  await waitFor(() => expect(checkingCorrection).toBe(true));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/estimate")).toBe(false);
  await act(async () => gate.release());
  await screen.findByRole("region", { name: "Cost estimate" });
  expect(button("Errors: 0 · Warnings: 1 · Advice: 0")).toBeTruthy();
  const estimate = fetchMock.mock.calls.find(([url]) => url === "/api/v1/estimate")!;
  expect(JSON.parse(String(estimate[1]?.body)).drafts.find((draft: { path: string }) => draft.path === modelPath)
    .content.model.blocks.gateway.params.handlers).toBe(5);
  expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
});

it("waits for current validation before opening Problems for a newly invalid draft", async () => {
  const gate = deferred();
  let checkingInvalid = false;
  const fetchMock = server(async (url, init) => {
    if (url !== "/api/v1/validate") return undefined;
    const draft = JSON.parse(String(init?.body)).drafts.find((item: { path: string }) => item.path === modelPath);
    const invalid = draft?.content.model.blocks.gateway.params.handlers === 0;
    if (invalid) { checkingInvalid = true; await gate.promise; }
    return { body: { experiment: experimentPath, valid: !invalid, diagnostics: invalid ? [{
      code: "PARAM_RANGE", severity: "ERROR", message: "Current handler error", document: modelPath,
      pointer: "/blocks/gateway/params/handlers", path: "gateway",
    }] : [] } };
  });
  await open(); await selectGateway(); editHandlers("0");
  fireEvent.click(button("Estimate"));
  await waitFor(() => expect(checkingInvalid).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/estimate")).toBe(false);
  expect(screen.queryByRole("tabpanel")).toBeNull();
  await act(async () => gate.release());
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toContain("Current handler error");
  expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/estimate" || url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
});

describe("cost estimate and resume", () => {

  it("estimates unsaved model and experiment drafts without saving or starting a job", async () => {
    const fetchMock = server();
    await open(); await selectGateway(); editHandlers("5");
    fireEvent.click(button("Run settings"));
    editField("Seed", "42");
    fireEvent.click(button("Estimate"));
    const estimate = await screen.findByRole("region", { name: "Cost estimate" });
    expect(within(estimate).getByLabelText("Tasks").textContent).toBe("4");
    expect(within(estimate).getByLabelText("Workers").textContent).toBe("2");
    expect(within(estimate).getByLabelText("Expected events").textContent).toBe("12,345");
    expect(within(estimate).getByLabelText("Expected rows").textContent).toBe("400");
    expect(within(estimate).getByLabelText("Estimated time").textContent).toBe("1.25 s");
    expect(within(estimate).getByLabelText("Uncompressed size").textContent).toBe("200 KiB");
    expect(within(estimate).getByLabelText("Artifact size").textContent).toBe("50 KiB");
    expect(within(estimate).getByLabelText("Parts").textContent).toBe("4");
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/v1/estimate")!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.experiment).toBe(experimentPath);
    expect(body.drafts).toHaveLength(2);
    expect(body.drafts.find((draft: { path: string }) => draft.path === modelPath).content.model.blocks.gateway.params.handlers).toBe(5);
    expect(body.drafts.find((draft: { path: string }) => draft.path === experimentPath).content.experiment.execution.seed).toBe(42);
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
    await selectGateway(); editHandlers("6");
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
  });

  it.each([false, true])("requires an explicit budget decision before Run: accepted=%s", async (accepted) => {
    const warning = { code: "ESTIMATE_UI_CACHE", message: "Estimated uncompressed task data exceed the 64 MiB UI cache budget; load selected nodes only" };
    const nativeConfirm = vi.spyOn(window, "confirm");
    const fetchMock = server((url) => url === "/api/v1/estimate" ? { body: { ...costEstimate, warnings: [warning] } } : undefined);
    await open();
    fireEvent.click(button("Run"));
    const dialog = await screen.findByRole("dialog", { name: "Start run?" });
    expect(dialog.textContent).toContain(warning.message);
    fireEvent.click(within(dialog).getByRole("button", { name: accepted ? "Start run" : "Review estimate" }));
    expect(nativeConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(button("Run").disabled).toBe(false));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs")).toHaveLength(accepted ? 1 : 0);
    if (accepted) {
      await screen.findByRole("table", { name: "Findings" });
      expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
    } else expect(screen.getByRole("region", { name: "Cost estimate" }).textContent).toContain(warning.message);
  });

  it("fetches a fresh estimate before each Run and treats extrapolation as information", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const fetchMock = server((url) => url === "/api/v1/estimate" ? { body: { ...costEstimate,
      warnings: [{ code: "ESTIMATE_EXTRAPOLATION", message: "Timing anchors exceeded" }],
    } } : undefined);
    await open();
    fireEvent.click(button("Estimate"));
    await screen.findByRole("region", { name: "Cost estimate" });
    fireEvent.click(button("Run"));
    await screen.findByRole("table", { name: "Findings" });
    const requests = fetchMock.mock.calls.map(([url]) => url).filter((url) => url === "/api/v1/estimate" || url === "/api/v1/jobs");
    expect(requests).toEqual(["/api/v1/estimate", "/api/v1/estimate", "/api/v1/jobs"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
  });

  it.each([false, true])("requires confirmation to run without an estimate: accepted=%s", async (accepted) => {
    const nativeConfirm = vi.spyOn(window, "confirm");
    const fetchMock = server((url) => url === "/api/v1/estimate" ? {
      status: 503, body: { code: "ESTIMATE_UNAVAILABLE", message: "Estimation unavailable", diagnostics: [] },
    } : undefined);
    await open(); fireEvent.click(button("Run"));
    const dialog = await screen.findByRole("dialog", { name: "Start run?" });
    expect(dialog.textContent).toContain("Estimation unavailable");
    expect(dialog.textContent).toContain("without an estimate");
    fireEvent.click(within(dialog).getByRole("button", { name: accepted ? "Start run" : "Review estimate" }));
    expect(nativeConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(button("Run").disabled).toBe(false));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs")).toHaveLength(accepted ? 1 : 0);
    if (accepted) {
      await screen.findByRole("table", { name: "Findings" });
      expect(screen.queryByText("Estimation unavailable")).toBeNull();
    }
  });

  it("shows a manual estimate failure without asking to start a run", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const fetchMock = server((url) => url === "/api/v1/estimate" ? {
      status: 503, body: { code: "ESTIMATE_UNAVAILABLE", message: "Estimation unavailable", diagnostics: [] },
    } : undefined);
    await open(); fireEvent.click(button("Estimate"));
    await screen.findByText("Estimation unavailable");
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
  });

  it("closes and reopens the estimate without editing documents or starting a run", async () => {
    const fetchMock = server();
    await open(); fireEvent.click(button("Estimate"));
    await screen.findByRole("region", { name: "Cost estimate" });
    fireEvent.click(button("Close estimate"));
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
    expect(button("Undo").disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    fireEvent.click(button("Estimate"));
    await screen.findByRole("region", { name: "Cost estimate" });
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
  });

  it.each([false, true])("discards a late estimate after an edit: rejected=%s", async (rejected) => {
    const gate = deferred();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = server(async (url) => {
      if (url !== "/api/v1/estimate") return undefined;
      await gate.promise;
      return rejected ? { status: 400, body: { code: "OLD_ESTIMATE", message: "Old estimate error", diagnostics: [] } } : { body: costEstimate };
    });
    await open(); await selectGateway(); fireEvent.click(button("Run"));
    expect(button("Run").disabled).toBe(true);
    editHandlers("5");
    await act(async () => { gate.release(); });
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
    expect(screen.queryByText("Old estimate error")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
  });

});

it("invalidates a pending Run estimate when a field becomes unparsable, then allows a fresh estimate after correction", async () => {
  const gate = deferred();
  let estimates = 0;
  const fetchMock = server(async (url) => {
    if (url !== "/api/v1/estimate") return undefined;
    if (++estimates === 1) await gate.promise;
    return { body: costEstimate };
  });
  await open(); await selectGateway();
  fireEvent.click(button("Run"));
  editHandlers("oops");
  expect(button("Run").disabled).toBe(true);
  await act(async () => { gate.release(); });
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
  expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
  editHandlers("4");
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(button("Estimate"));
  await screen.findByRole("region", { name: "Cost estimate" });
  expect(button("Run").disabled).toBe(false);
});

it.each(["button", "outside", "Escape"])("dismisses the anchored estimate via %s", async way => {
  server();
  await open();
  fireEvent.click(button("Estimate"));
  await screen.findByRole("region", { name: "Cost estimate" });
  const panel = within(screen.getByRole("banner")).getByRole("region", { name: "Estimate" });
  fireEvent.pointerDown(panel);
  expect(screen.getByRole("region", { name: "Cost estimate" })).toBeTruthy();
  if (way === "button") fireEvent.click(button("Close estimate"));
  else if (way === "outside") fireEvent.pointerDown(screen.getByRole("tab", { name: "Model" }));
  else fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
});

it("keeps an estimate dismissed when its pending request completes", async () => {
  const gate = deferred();
  server(async url => {
    if (url !== "/api/v1/estimate") return undefined;
    await gate.promise;
    return { body: costEstimate };
  });
  await open();
  fireEvent.click(button("Estimate"));
  await screen.findByText("Estimating experiment cost…");
  fireEvent.keyDown(document, { key: "Escape" });
  await act(async () => gate.release());
  await waitFor(() => expect(button("Estimate").disabled).toBe(false));
  expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
});
