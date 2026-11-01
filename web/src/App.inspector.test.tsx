import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";
import { experimentPath, manifest, modelPath } from "./test/fixtures";
import { setupAppTests, server, open, selectGateway, button, editField } from "./test/app";

setupAppTests();

it("reveals run settings on every click even with the Inspector and execution section collapsed", async () => {
  localStorage.setItem("resilience-lab.inspector-execution-open", "false");
  server(); await open();
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(button("Collapse inspector"));
    expect(screen.queryByRole("heading", { name: "Run settings" })).toBeNull();
    fireEvent.click(button("Run settings"));
    expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Seed" })).toBeTruthy();
    fireEvent.click(screen.getByText("Run", { selector: "summary h3" }));
  }
});

it("marks settings pressed only while the visible Inspector shows them", async () => {
  server(); await open();
  const settings = button("Run settings");
  expect(settings.getAttribute("aria-pressed")).toBe("true");
  await selectGateway();
  expect(settings.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(settings);
  expect(settings.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTestId("rf__node-gateway").classList.contains("selected")).toBe(false);
  expect(screen.getByText("retry-storm", { selector: ".inspector-type" })).toBeTruthy();
  fireEvent.click(button("Collapse inspector"));
  expect(settings.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button("Expand inspector"));
  expect(settings.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(settings.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("heading", { name: "Baseline" })).toBeTruthy();
  expect(screen.getByText("Variant", { selector: ".inspector-type" })).toBeTruthy();
});


it("shows available element results first and opens Parameters for Problems and canvas editing", async () => {
  server(url => {
    if (url.endsWith("/manifest")) return { body: { ...manifest, series: null } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: true, diagnostics: [
      { code: "LINT", severity: "WARNING", message: "Inspect gateway handlers", variant: "baseline", document: modelPath,
        pointer: "/blocks/gateway/params/handlers", path: "gateway" },
    ] } };
    return undefined;
  });
  await open(); fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" })); await selectGateway();
  const parameters = () => document.querySelector<HTMLDetailsElement>(".inspector-parameters")!;
  expect(parameters().open).toBe(false);
  const results = within(screen.getByRole("complementary", { name: "Inspector" })).getByRole("region", { name: "Results" });
  expect(results.compareDocumentPosition(parameters()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.doubleClick(screen.getByTestId("canvas-param-gateway-handlers"));
  await waitFor(() => expect(parameters().open).toBe(true));
  const inline = within(screen.getByTestId("canvas-param-gateway-handlers")).getByRole("textbox", { name: "Handlers" });
  expect(document.activeElement).toBe(inline);
  fireEvent.keyDown(inline, { key: "Escape" });
  fireEvent.click(within(parameters()).getByText("Parameters", { selector: "summary" }));
  await waitFor(() => expect(parameters().open).toBe(false));
  fireEvent.click(button("Errors: 0 · Warnings: 1"));
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Inspect gateway handlers/ }));
  await waitFor(() => expect(parameters().open).toBe(true));
  expect(document.activeElement).toBe(within(parameters()).getByRole("textbox", { name: "Handlers" }));
});

it("opens collapsed variant parameters from a model-page diagnostic link and focuses the field", async () => {
  server(url => {
    if (url.endsWith("/manifest")) return { body: { ...manifest, series: null } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: true, diagnostics: [
      { code: "LINT", severity: "WARNING", message: "Inspect baseline handlers", variant: "baseline", document: modelPath,
        pointer: "/blocks/gateway/params/handlers", path: "gateway" },
    ] } };
    return undefined;
  });
  await open(); fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" })); await selectGateway();
  const parameters = () => document.querySelector<HTMLDetailsElement>(".inspector-parameters")!;
  expect(parameters().open).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect(parameters().open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "More about: Warnings in variants: Baseline" }));
  fireEvent.click(screen.getByRole("link", { name: "In variants: Baseline — 1 warning" }));
  expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(parameters().open).toBe(true));
  expect(document.activeElement).toBe(within(parameters()).getByRole("textbox", { name: "Handlers" }));
  expect(button("Save").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
});

it("shows only the current Inspector target and keeps target navigation out of history", async () => {
  server(); await open();
  await selectGateway();
  expect(screen.queryByRole("heading", { name: "Run settings" })).toBeNull();
  expect(screen.queryByLabelText("Variant ID")).toBeNull();
  fireEvent.click(screen.getByTestId("rf__edge-gateway-to-middle"));
  expect(screen.getByRole("heading", { name: "gateway → middle (gateway-to-middle)" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(screen.getByLabelText("Timeout")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(screen.getByLabelText("Variant ID")).toBeTruthy();
  expect(screen.queryByLabelText("Timeout")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Run settings" })).toBeNull();
  await selectGateway();
  fireEvent.click(document.querySelector(".react-flow__pane")!);
  expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
  expect(screen.queryByLabelText("Handlers")).toBeNull();
  await selectGateway(); fireEvent.click(button("Run settings"));
  expect(screen.getByLabelText("Replications")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect(screen.getByLabelText("Replications")).toBeTruthy();
  expect(button("Undo").disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
});

it("follows a selected element through rename, undo and redo, then forgets a deleted target", async () => {
  server(); await open(); await selectGateway();
  editField("Identifier", "entry");
  expect(screen.getByRole("heading", { name: "entry" })).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("heading", { name: "gateway" })).toBeTruthy();
  fireEvent.click(button("Redo"));
  expect(screen.getByRole("heading", { name: "entry" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Delete" });
  expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "entry" })).toBeNull();
});

it("falls back to the experiment when undo removes a newly selected block or variant", async () => {
  server(); await open();
  fireEvent.doubleClick(within(screen.getByRole("complementary", { name: "Palette" })).getByRole("button", { name: "Service" }));
  await screen.findByRole("heading", { name: "service-1" });
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
  fireEvent.click(button("Add variant"));
  expect(screen.getByLabelText("Variant ID")).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
});

it("opens and focuses the variant field named by a Problem", async () => {
  server(url => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: false, diagnostics: [
    { code: "VARIANT_ID", severity: "ERROR", message: "Invalid variant identifier", document: experimentPath,
      pointer: "/variants/1/id", path: null },
  ] } } : undefined);
  render(<App />); await screen.findByRole("heading", { name: "Run settings" }); await selectGateway();
  fireEvent.click(await screen.findByRole("button", { name: /Invalid variant identifier/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Variant ID"));
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("no-retries");
  expect(screen.queryByLabelText("Handlers")).toBeNull();
});

it("selects a service from Findings in the Inspector", async () => {
  server(); await open(); fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  const service = [...document.querySelectorAll(".summary-services summary")].find(row => row.textContent?.includes("gateway"))!;
  fireEvent.click(service);
  expect(screen.getByRole("heading", { name: "gateway" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Run settings" })).toBeNull();
});

it("falls back to the experiment when the last multi-selected target disappears on Undo", async () => {
  server(); await open();
  fireEvent.doubleClick(within(screen.getByRole("complementary", { name: "Palette" })).getByRole("button", { name: "Service" }));
  await screen.findByRole("heading", { name: "service-1" });
  fireEvent.click(screen.getByTestId("rf__node-gateway"), { ctrlKey: true });
  const added = await screen.findByTestId("rf__node-service-1");
  fireEvent.click(added, { ctrlKey: true });
  fireEvent.click(added, { ctrlKey: true });
  expect(screen.getByRole("heading", { name: "service-1" })).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("heading", { name: "Run settings" })).toBeTruthy();
  expect(screen.queryByLabelText("Handlers")).toBeNull();
  expect(screen.getByTestId("rf__node-gateway").classList.contains("selected")).toBe(true);
});

it.each(["Run settings", "Variant", "Rename", "Problem", "Model"])("reveals the requested Inspector target from Analysis via %s", async (action) => {
  server(url => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: true, diagnostics: [{
    code: "SEED_HINT", severity: "WARNING", message: "Review the shared seed", document: experimentPath,
    pointer: "/execution/seed", path: null,
  }] } } : undefined);
  await open(); fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  const baseline = screen.getByRole("tab", { name: "Baseline" });
  fireEvent.click(baseline); fireEvent.click(button("Analysis"));
  expect(button("Run settings").getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Seed" })).toBeNull();
  if (action === "Run settings") fireEvent.click(button("Run settings"));
  else if (action === "Variant") fireEvent.click(baseline);
  else if (action === "Rename") {
    fireEvent.contextMenu(baseline); fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  } else if (action === "Model") {
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  } else {
    fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
    fireEvent.click(screen.getByRole("button", { name: /Review the shared seed/ }));
  }
  expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
  expect(screen.getByLabelText(action === "Variant" || action === "Rename" ? "Variant label" : "Seed")).toBeTruthy();
  if (action === "Run settings") expect(button("Run settings").getAttribute("aria-pressed")).toBe("true");
});
