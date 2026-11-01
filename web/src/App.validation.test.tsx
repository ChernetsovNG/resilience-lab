import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";
import { catalog, documentViews, experiment, experimentPath, model, modelPath } from "./test/fixtures";
import { setupAppTests, server, open, selectGateway, editHandlers, button } from "./test/app";

setupAppTests();


it("opens counted warnings on demand and leaves new warnings collapsed", async () => {
  let checks = 0;
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: true, diagnostics: [
    { code: "LINT", severity: "WARNING", message: `Budget warning ${++checks}`, document: modelPath, pointer: null, path: "gateway" },
  ] } } : undefined);
  await open();
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Errors: 0 · Warnings: 1" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("Budget warning 1");
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  await selectGateway(); editHandlers("5");
  expect(button("Errors: 0 · Warnings: 1")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Problems" }).textContent).toContain("1");
  await waitFor(() => expect(checks).toBe(2));
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();
});

it("reveals new errors but preserves dismissal through pending checks of the same error", async () => {
  const first = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "Handler error", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway" };
  let findings = [first];
  let checks = 0;
  server((url) => {
    if (url !== "/api/v1/validate") return undefined;
    checks++;
    return { body: { experiment: experimentPath, valid: findings.length === 0, diagnostics: findings } };
  });
  render(<App />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  editHandlers("5");
  await waitFor(() => expect(checks).toBe(2));
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();

  findings = [first, { ...first, message: "Another handler error" }];
  editHandlers("6");
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Another handler error/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  findings = [];
  editHandlers("7");
  await waitFor(() => expect(checks).toBe(4));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  findings = [first];
  editHandlers("8");
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel")).toBeTruthy();
});

it("validates unsaved values, shows errors in every view and removes them after correction", async () => {
  server((url, init) => {
    if (url !== "/api/v1/validate") return undefined;
    const body = JSON.parse(String(init?.body));
    const invalid = body.drafts.some((draft: { content: { model?: typeof model } }) => draft.content.model?.blocks.gateway.params.handlers === 0);
    return { body: { experiment: experimentPath, valid: !invalid, diagnostics: invalid ? [
      { code: "PARAM_RANGE", severity: "ERROR", message: "At least one handler", document: modelPath, pointer: "/blocks/gateway/params/handlers", path: "gateway" },
    ] : [] } };
  });
  await open(); await selectGateway(); editHandlers("0");
  await screen.findByRole("img", { name: "1 problems: error" });
  expect(within(screen.getByRole("complementary", { name: "Inspector" })).getByText(/At least one handler/).closest(".param-field")?.textContent).toContain("Handlers");
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  expect(within(screen.getByRole("tabpanel")).getByText(/PARAM_RANGE/)).toBeTruthy();
  expect(button("Run").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /At least one handler/ }));
  expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("heading", { name: "gateway" })).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
  await waitFor(() => expect(screen.queryByRole("img", { name: "1 problems: error" })).toBeNull());
  expect(screen.queryByText(/At least one handler/)).toBeNull();
  await waitFor(() => expect(button("Run").disabled).toBe(false));
});

it("blocks Run on saved validation errors and navigates to an override's variant and element", async () => {
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: false, diagnostics: [
    { code: "PARAM_RANGE", severity: "ERROR", message: "Invalid override timeout", document: experimentPath,
      pointer: "/variants/1/overrides/gateway-to-middle.timeout", path: "gateway-to-middle" },
  ] } } : undefined);
  render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(await screen.findByRole("button", { name: /Invalid override timeout/ }));
  expect(screen.getByRole("tab", { name: "No retries" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("heading", { name: "gateway → middle (gateway-to-middle)" })).toBeTruthy();
  expect(within(screen.getByRole("complementary", { name: "Inspector" })).getByText(/Invalid override timeout/).closest(".param-field")).toBeTruthy();
  expect(button("Run").disabled).toBe(true);
  expect(button("Run").title).toContain("validation errors");
});

it("shows override diagnostics only at fields on their own variant page and blocks Run on every page", async () => {
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: false, diagnostics: [
    { code: "PARAM_RANGE", severity: "ERROR", message: "Baseline mean error", document: experimentPath,
      pointer: "/variants/0/overrides/gateway.processing/mean", path: "gateway" },
    { code: "PARAM_RANGE", severity: "ERROR", message: "No retries mean error", document: experimentPath,
      pointer: "/variants/1/overrides/gateway.processing.mean", path: "gateway" },
  ] } } : undefined);
  render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  await waitFor(() => expect(button("Run").title).toContain("validation errors"));
  await selectGateway();
  const inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
  expect(inspector.queryByText("PARAM_RANGE: Baseline mean error")).toBeNull();
  expect(inspector.queryByText("PARAM_RANGE: No retries mean error")).toBeNull();
  for (const [page, own, other] of [["Baseline", "Baseline mean error", "No retries mean error"],
    ["No retries", "No retries mean error", "Baseline mean error"]]) {
    fireEvent.click(screen.getByRole("tab", { name: page }));
    expect(screen.getByLabelText("Mean").closest(".param-field")?.textContent).toContain(own);
    expect(inspector.queryByText(`PARAM_RANGE: ${other}`)).toBeNull();
    expect(button("Run").disabled).toBe(true);
  }
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Baseline mean error/ }));
  expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByLabelText("Mean").closest(".param-field")?.textContent).toContain("Baseline mean error");
});

it("opens shared settings diagnostics from Problems while an element is selected", async () => {
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: false, diagnostics: [
    { code: "SEED_RANGE", severity: "ERROR", message: "Invalid shared seed", document: experimentPath, pointer: "/execution/seed", path: null },
    { code: "FAULT_INTERVAL", severity: "ERROR", message: "Invalid fault end", document: experimentPath, pointer: "/faults/0/to", path: "dependency" },
  ] } } : undefined);
  render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  await waitFor(() => expect(button("Run").title).toContain("validation errors"));
  await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  expect(screen.queryByLabelText("Seed")).toBeNull();
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Invalid shared seed/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Seed"));
  expect(screen.queryByLabelText("Handlers")).toBeNull();
  expect(screen.getByLabelText("Seed").closest(".param-field")?.textContent).toContain("Invalid shared seed");
  expect(screen.getByLabelText("Fault end").closest(".param-field")?.textContent).toContain("Invalid fault end");
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Invalid fault end/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Fault end"));
  expect(button("Run").disabled).toBe(true);
});

it("shares grid field diagnostics across pages while scoping canvas badges to their variant", async () => {
  const gridCatalog = structuredClone(catalog);
  gridCatalog.types.find((type) => type.id === "call")!.params.find((param) => param.name === "timeout")!.sweepable = true;
  server((url) => {
    if (url === "/api/v1/catalog") return { body: gridCatalog };
    if (url.startsWith("/api/v1/workspace/document?") && decodeURIComponent(url).endsWith(experimentPath)) {
      return { body: { ...documentViews[experimentPath], content: { experiment: { ...experiment,
        grid: [{ path: "gateway-to-middle.timeout", values: ["0ms"] }],
      } } } };
    }
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: false, diagnostics: [{
      code: "PARAM_RANGE", severity: "ERROR", message: "Grid timeout must be positive", document: experimentPath,
      pointer: "/grid/0/values/0", path: "gateway-to-middle", variant: "baseline",
    }] } };
  });
  render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  await waitFor(() => expect(screen.getByLabelText("Axis 1 value 1").closest(".param-field")?.textContent).toContain("Grid timeout must be positive"));
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").classList.contains("diagnostic--error")).toBe(false);
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").classList.contains("diagnostic--error")).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").classList.contains("diagnostic--error")).toBe(false);
  expect(screen.getByLabelText("Axis 1 value 1").getAttribute("aria-invalid")).toBe("true");
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Grid timeout must be positive/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Axis 1 value 1"));
  expect(button("Run").disabled).toBe(true);
});

it("focuses Add value when a grid diagnostic names an empty value list", async () => {
  const gridCatalog = structuredClone(catalog);
  gridCatalog.types.find(type => type.id === "call")!.params.find(param => param.name === "timeout")!.sweepable = true;
  server(url => {
    if (url === "/api/v1/catalog") return { body: gridCatalog };
    if (url.includes(encodeURIComponent(experimentPath))) return { body: { ...documentViews[experimentPath], content: {
      experiment: { ...experiment, grid: [{ path: "gateway-to-middle.timeout", values: [] }] },
    } } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: false, diagnostics: [{
      code: "GRID_VALUES", severity: "ERROR", message: "Axis values must not be empty", document: experimentPath,
      pointer: "/grid/0/values", path: "gateway-to-middle",
    }] } };
  });
  render(<App />); await screen.findByRole("heading", { name: "Run settings" }); await selectGateway();
  fireEvent.click(await screen.findByRole("button", { name: /Axis values must not be empty/ }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /Add value/ }));
});
