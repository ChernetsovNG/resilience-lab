import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { experimentPath, summary } from "./test/fixtures";
import { setupAppTests, otherPath, completed, deferred, server, open, selectGateway, editHandlers, button, experimentSelect, measuredWorkspace } from "./test/app";

setupAppTests();


it("starts with collapsed results and preserves manual expansion across experiment changes", async () => {
  server(); await open();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(button("Expand results"));
  await selectGateway(); editHandlers("5");
  await waitFor(() => expect(button("Save").disabled).toBe(false));
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  fireEvent.click(button("Undo"));
  fireEvent.change(experimentSelect(), { target: { value: otherPath } });
  await screen.findByRole("heading", { name: "Run settings" });
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  fireEvent.change(experimentSelect(), { target: { value: experimentPath } });
  await screen.findByRole("heading", { name: "Run settings" });
  expect(screen.getByRole("tabpanel")).toBeTruthy();
});

it("keeps a manual collapse made while a run is pending after completion", async () => {
  const gate = deferred();
  let submitted = false;
  server(async url => {
    if (url !== "/api/v1/jobs") return undefined;
    submitted = true; await gate.promise;
    return { status: 202, body: completed };
  });
  await open(); fireEvent.click(button("Run"));
  await waitFor(() => expect(submitted).toBe(true));
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  fireEvent.click(button("Collapse results"));
  await act(async () => gate.release());
  await screen.findByText("COMPLETED", { exact: true });
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  expect(screen.queryByRole("tabpanel")).toBeNull();
});

it("opens collapsed results for Estimate and preserves a later manual collapse", async () => {
  server(); await open();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(button("Estimate"));
  await screen.findByRole("region", { name: "Cost estimate" });
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  fireEvent.click(button("Collapse results"));
  await selectGateway();
  expect(screen.queryByRole("tabpanel")).toBeNull();
});

it("resizes the results with keys and dragging within bounds without editing documents", async () => {
  measuredWorkspace();
  const fetchMock = server();
  await open();
  fireEvent.click(button("Expand results"));
  const divider = screen.getByRole("separator", { name: "Resize results panel" });
  const height = () => Number(divider.getAttribute("aria-valuenow"));
  const initial = height();
  fireEvent.keyDown(divider, { key: "ArrowUp" });
  expect(height()).toBe(initial + 16);
  fireEvent.keyDown(divider, { key: "ArrowDown" });
  expect(height()).toBe(initial);
  Object.assign(divider, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  fireEvent(divider, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 500 }));
  fireEvent(divider, new MouseEvent("pointermove", { bubbles: true, clientY: 460 }));
  expect(height()).toBe(initial + 40);
  fireEvent(divider, new MouseEvent("pointermove", { bubbles: true, clientY: -10000 }));
  expect(document.querySelector(".workspace-panels--expanded")).not.toBeNull();
  fireEvent(divider, new MouseEvent("pointerup", { bubbles: true }));
  fireEvent.doubleClick(divider);
  expect(height()).toBe(initial + 40);
  fireEvent.keyDown(divider, { key: "Home" });
  expect(height()).toBe(160);
  fireEvent.keyDown(divider, { key: "ArrowDown" });
  expect(height()).toBe(160);
  fireEvent.keyDown(divider, { key: "End" });
  expect(height()).toBe(360);
  fireEvent.keyDown(divider, { key: "ArrowUp" });
  expect(document.querySelector(".workspace-panels--expanded")).not.toBeNull();
  fireEvent.doubleClick(divider);
  expect(height()).toBe(360);
  fireEvent.click(button("Collapse results"));
  expect(screen.queryByRole("separator", { name: "Resize results panel" })).toBeNull();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(button("Expand results"));
  expect(height()).toBe(360);
  expect(screen.queryByRole("button", { name: "Expand results" })).toBeNull();
  expect(button("Undo").disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
});

it("remembers separate heights for all five result tabs across remounts", async () => {
  measuredWorkspace();
  const grid = { ...summary, grid: [{ path: "gateway.handlers", values: [4] }] };
  server(url => url.endsWith("/summary") ? { body: grid } : undefined);
  let view = await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  const height = () => Number(screen.getByRole("separator", { name: "Resize results panel" }).getAttribute("aria-valuenow"));
  const answer = height();
  fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
  await waitFor(() => expect(height()).toBeGreaterThan(answer));
  const sizes = new Map<string, number>();
  for (const [index, tab] of ["Findings", "Timeline", "Assumptions", "Map", "Problems"].entries()) {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize results panel" }), { key: "Home" });
    for (let step = 0; step <= index; step++) fireEvent.keyDown(screen.getByRole("separator", { name: "Resize results panel" }), { key: "ArrowUp" });
    sizes.set(tab, height());
  }
  view.unmount();
  view = await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  for (const [tab, size] of sizes) {
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    await waitFor(() => expect(height()).toBe(size));
  }
  view.unmount();
});

it.each(["button", "Escape"])("enters Analysis and exits via %s while preserving the selection", async way => {
  server();
  await open();
  expect(screen.queryByRole("button", { name: "Analysis" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  expect(button("Analysis").title).toContain("Esc");
  fireEvent.click(button("Analysis"));
  expect(button("Analysis").getAttribute("aria-pressed")).toBe("true");
  expect((document.querySelector(".palette") as HTMLElement).hidden).toBe(true);
  expect((document.querySelector(".inspector") as HTMLElement).hidden).toBe(false);
  expect(screen.queryByRole("textbox", { name: "Seed" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED");
  if (way === "button") fireEvent.click(button("Analysis"));
  else fireEvent.keyDown(screen.getByRole("separator", { name: "Resize results panel" }), { key: "Escape" });
  expect(button("Analysis").getAttribute("aria-pressed")).toBe("false");
  expect((document.querySelector(".palette") as HTMLElement).hidden).toBe(false);
  expect((document.querySelector(".inspector") as HTMLElement).hidden).toBe(false);
  expect(button("Save").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
});

it("exits Analysis on the Model page and restores palette and parameter editing", async () => {
  server(); await open();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  await selectGateway();
  fireEvent.click(button("Analysis"));
  expect(screen.queryByRole("textbox", { name: "Handlers" })).toBeNull();

  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect((document.querySelector(".palette") as HTMLElement).hidden).toBe(false);
  expect(button("Service").disabled).toBe(false);
  expect((screen.getByRole("textbox", { name: "Handlers" }) as HTMLInputElement).value).toBe("4");
  expect(button("Save").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
  editHandlers("5");
  await waitFor(() => expect(button("Save").disabled).toBe(false));
  expect(screen.getByTestId("canvas-param-gateway-handlers").textContent).toBe("5");
  fireEvent.click(button("Undo"));
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(button("Analysis").getAttribute("aria-pressed")).toBe("false");
});
