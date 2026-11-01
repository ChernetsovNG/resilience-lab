import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";
import { catalog, documentViews, experiment, experimentPath, model, modelPath } from "./test/fixtures";
import { setupAppTests, deferred, server, open, selectGateway, editHandlers, button } from "./test/app";

setupAppTests();


it("opens counted warnings on demand and leaves new warnings collapsed", async () => {
  let checks = 0;
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: true, diagnostics: [
    { code: "LINT", severity: "WARNING", message: `Budget warning ${++checks}`, document: modelPath, pointer: null, path: "gateway" },
  ] } } : undefined);
  await open();
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Errors: 0 · Warnings: 1 · Advice: 0" }));
  expect(screen.getByRole("tabpanel").textContent).toContain("Budget warning 1");
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  await selectGateway(); editHandlers("5");
  expect(button("Errors: 0 · Warnings: 1 · Advice: 0")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Problems" }).textContent).toContain("1");
  await waitFor(() => expect(checks).toBe(2));
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();
});

it("keeps new and recurring validation errors collapsed while updating counts", async () => {
  const first = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "Handler error", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway" };
  let findings: typeof first[] = [];
  let checks = 0;
  server((url) => {
    if (url !== "/api/v1/validate") return undefined;
    checks++;
    return { body: { experiment: experimentPath, valid: findings.length === 0, diagnostics: findings } };
  });
  await open();
  await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  findings = [first];
  editHandlers("5");
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();

  findings = [first, { ...first, message: "Another handler error" }];
  editHandlers("6");
  await screen.findByRole("button", { name: "Errors: 2 · Warnings: 0 · Advice: 0" });
  expect(screen.queryByRole("tabpanel")).toBeNull();
  findings = [];
  editHandlers("7");
  await waitFor(() => expect(checks).toBe(4));
  expect(screen.queryByRole("tabpanel")).toBeNull();
  findings = [first];
  editHandlers("8");
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tabpanel")).toBeNull();
});

it("keeps the panel collapsed when an added block produces a validation error", async () => {
  server((url, init) => {
    if (url !== "/api/v1/validate") return undefined;
    const drafts = JSON.parse(String(init?.body)).drafts;
    const added = drafts.some((draft: { content: { model?: typeof model } }) => draft.content.model?.blocks["service-1"] !== undefined);
    return { body: { experiment: experimentPath, valid: !added, diagnostics: added ? [{
      code: "TOPOLOGY_GRAPH", severity: "ERROR", message: "Connect service to the model", document: modelPath,
      pointer: "/blocks/service-1", path: "service-1",
    }] : [] } };
  });
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  fireEvent.doubleClick(button("Service"));
  const node = await screen.findByTestId("rf__node-service-1");
  await waitFor(() => expect(node.classList.contains("selected")).toBe(true));
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(button("Run"));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toContain("Connect service to the model");
});

it.each(["Run", "Estimate", "Fix validation errors before running", "Ctrl+Enter"])("opens validation problems on %s without submitting invalid documents", async action => {
  let invalid = false;
  const requests = server(url => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: !invalid, diagnostics: invalid ? [{
    code: "PARAM_RANGE", severity: "ERROR", message: "Handler error", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway",
  }] : [] } } : undefined);
  await open(); await selectGateway();
  invalid = true;
  editHandlers("0");
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  fireEvent.click(button("Collapse results"));
  if (action === "Ctrl+Enter") fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
  else fireEvent.click(button(action));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toContain("Handler error");
  expect(requests.mock.calls.some(([url, init]) => url === "/api/v1/estimate" || url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
});

it("preserves an expanded tab when validation finds a new error", async () => {
  let invalid = false;
  server(url => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: !invalid, diagnostics: invalid ? [{
    code: "PARAM_RANGE", severity: "ERROR", message: "Handler error", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway",
  }] : [] } } : undefined);
  await open(); await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Assumptions" }));
  invalid = true;
  editHandlers("0");
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  expect(screen.getByRole("tab", { name: "Assumptions" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel")).toBeTruthy();
});

it.each(["Run", "Estimate"])("opens Problems when %s receives validation errors from the estimate API", async action => {
  const requests = server(url => url === "/api/v1/estimate" ? { status: 400, body: {
    code: "EXPERIMENT_INVALID", message: "Experiment has errors", diagnostics: [{
      code: "PARAM_RANGE", severity: "ERROR", message: "Estimate handler error", document: modelPath,
      pointer: "/blocks/gateway/params/handlers", path: "gateway",
    }],
  } } : undefined);
  await open();
  fireEvent.click(button(action));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toContain("Estimate handler error");
  expect(button("Errors: 1 · Warnings: 0 · Advice: 0")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(requests.mock.calls.some(([url, init]) => url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
});

it.each(["Run", "Estimate"])("preserves the tab chosen during %s when the estimate API repeats the same error", async action => {
  const gate = deferred();
  let estimates = 0;
  server(async url => {
    if (url !== "/api/v1/estimate") return undefined;
    if (++estimates === 2) await gate.promise;
    return { status: 400, body: { code: "EXPERIMENT_INVALID", message: "Experiment has errors", diagnostics: [{
      code: "PARAM_RANGE", severity: "ERROR", message: "Estimate handler error", document: modelPath,
      pointer: "/blocks/gateway/params/handlers", path: "gateway",
    }] } };
  });
  await open();
  fireEvent.click(button(action));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  fireEvent.click(button(action));
  await waitFor(() => expect(estimates).toBe(2));
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  await act(async () => gate.release());
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0 · Advice: 0" });
  expect(screen.getByRole("tab", { name: "Findings" }).getAttribute("aria-selected")).toBe("true");
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
  expect(button("Run").title).toContain("validation errors");
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
    expect(button("Run").title).toContain("validation errors");
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
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Invalid shared seed/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Seed"));
  expect(screen.queryByLabelText("Handlers")).toBeNull();
  expect(screen.getByLabelText("Seed").closest(".param-field")?.textContent).toContain("Invalid shared seed");
  expect(screen.getByLabelText("Fault end").closest(".param-field")?.textContent).toContain("Invalid fault end");
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Invalid fault end/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Fault end"));
  expect(button("Run").title).toContain("validation errors");
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
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /Grid timeout must be positive/ }));
  expect(document.activeElement).toBe(screen.getByLabelText("Axis 1 value 1"));
  expect(button("Run").title).toContain("validation errors");
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
  fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
  fireEvent.click(await screen.findByRole("button", { name: /Axis values must not be empty/ }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /Add value/ }));
});
