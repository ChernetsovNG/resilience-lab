import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { DocumentView, JobView } from "./api/apiTypes";
import { catalog, costEstimate, documentViews, experiment, experimentPath, manifest, model, modelPath, summary } from "./test/fixtures";
import { mockReactFlowDom } from "./test/reactFlow";
import { stubFetch, type StubResponse } from "./test/stubFetch";

beforeAll(mockReactFlowDom);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const otherPath = "retry-storm/second.experiment.json";
const health = { status: "UP", applicationVersion: "test", kslVersion: "test" };
const completed: JobView = {
  id: "job-1", experiment: experimentPath, runId: "run-1", status: "COMPLETED",
  completedTasks: 4, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function server(override?: (url: string, init?: RequestInit) => StubResponse | Promise<StubResponse | undefined> | undefined) {
  const documents: Record<string, DocumentView> = {
    ...documentViews,
    [otherPath]: { path: otherPath, kind: "EXPERIMENT", version: "second", content: { experiment: { ...experiment, execution: { ...experiment.execution, seed: 99 } } } },
  };
  return stubFetch(async (url, init) => {
    const response = await override?.(url, init);
    if (response !== undefined) return response;
    if (url === "/api/v1/health") return { body: health };
    if (url === "/api/v1/catalog") return { body: catalog };
    if (url === "/api/v1/validate") return { body: { experiment: JSON.parse(String(init?.body)).experiment, valid: true, diagnostics: [] } };
    if (url === "/api/v1/workspace/documents") return { body: Object.values(documents) };
    if (url.startsWith("/api/v1/workspace/changes")) {
      const since = new URL(url, "http://localhost").searchParams.get("since");
      return { body: { cursor: since ?? "test:0", reset: false, changes: [] } };
    }
    if (url.startsWith("/api/v1/workspace/document?")) {
      const path = new URL(url, "http://localhost").searchParams.get("path")!;
      if (init?.method === "PUT") return { body: { path, kind: "MODEL", version: "saved" } };
      return { body: documents[path] };
    }
    if (url === "/api/v1/estimate") return { body: costEstimate };
    if (url === "/api/v1/jobs") return { status: 202, body: completed };
    if (url === "/api/v1/runs/run-1/summary") return { body: summary };
    if (url === "/api/v1/runs/run-1/manifest") return { body: manifest };
    throw new Error(`Unexpected request: ${url}`);
  });
}

async function open() {
  const view = render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  await screen.findByTestId("rf__node-gateway");
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  return view;
}
function selectGateway() { fireEvent.click(screen.getByTestId("rf__node-gateway")); }
function editHandlers(value: string) {
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value } });
  fireEvent.blur(screen.getByLabelText("Handlers"));
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const experimentSelect = () => screen.getByRole("combobox", { name: "Experiment" }) as HTMLSelectElement;

it("validates unsaved values, shows errors in every view and removes them after correction", async () => {
  server((url, init) => {
    if (url !== "/api/v1/validate") return undefined;
    const body = JSON.parse(String(init?.body));
    const invalid = body.drafts.some((draft: { content: { model?: typeof model } }) => draft.content.model?.blocks.gateway.params.handlers === 0);
    return { body: { experiment: experimentPath, valid: !invalid, diagnostics: invalid ? [
      { code: "PARAM_RANGE", severity: "ERROR", message: "At least one handler", document: modelPath, pointer: "/blocks/gateway/params/handlers", path: "gateway" },
    ] : [] } };
  });
  await open(); selectGateway(); editHandlers("0");
  await screen.findByRole("img", { name: "1 problems: error" });
  expect(screen.getByText(/At least one handler/).closest(".param-field")?.textContent).toContain("Handlers");
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
  expect(screen.getByRole("heading", { name: "gateway-to-middle" })).toBeTruthy();
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
  selectGateway();
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

it("keeps shared settings diagnostics beside editable fields while an element is selected", async () => {
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: false, diagnostics: [
    { code: "SEED_RANGE", severity: "ERROR", message: "Invalid shared seed", document: experimentPath, pointer: "/execution/seed", path: null },
    { code: "FAULT_INTERVAL", severity: "ERROR", message: "Invalid fault end", document: experimentPath, pointer: "/faults/0/to", path: "dependency" },
  ] } } : undefined);
  render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  await waitFor(() => expect(button("Run").title).toContain("validation errors"));
  selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  expect(screen.getByLabelText("Seed").closest(".param-field")?.textContent).toContain("Invalid shared seed");
  expect(screen.getByLabelText("Fault end").closest(".param-field")?.textContent).toContain("Invalid fault end");
  expect(button("Run").disabled).toBe(true);
});

function editField(label: string, value: string) {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

it("saves precise variant overrides only to the experiment and resets fields and objects with undo", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  fireEvent.click(await screen.findByTestId("rf__edge-gateway-to-middle"));
  editField("Timeout", "90ms");
  editField("Base delay", "4ms");
  expect((await screen.findByTestId("canvas-edge-label-gateway-to-middle")).textContent).toContain("◆");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(String(puts[0][0])).toContain(encodeURIComponent(experimentPath));
  expect(puts[0][1]?.headers).toMatchObject({ "If-Match": '"v-experiment"' });
  expect(JSON.parse(String(puts[0][1]?.body)).experiment.variants[1].overrides).toEqual({
    "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1,
    "gateway-to-middle.timeout": "90ms", "gateway-to-middle.backoff.base": "4ms",
  });
  fireEvent.click(button("Reset Timeout"));
  expect((screen.getByLabelText("Timeout") as HTMLInputElement).value).toBe("80ms");
  fireEvent.click(button("Reset Backoff"));
  expect((screen.getByLabelText("Base delay") as HTMLInputElement).value).toBe("2ms");
  fireEvent.click(button("Undo"));
  expect((screen.getByLabelText("Base delay") as HTMLInputElement).value).toBe("4ms");
});

it("edits canvas timeout with undo and saves variant edits only as overrides", async () => {
  const fetchMock = server();
  await open();
  const editTimeout = async (value: string) => {
    const parameter = await screen.findByTestId("canvas-param-gateway-to-middle-timeout");
    fireEvent.doubleClick(parameter);
    const input = parameter.querySelector("input")!;
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest("form")!);
  };

  await editTimeout("90ms");
  expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("90ms");
  fireEvent.click(button("Undo"));
  expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("80ms");

  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  await editTimeout("100ms");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));

  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(String(puts[0][0])).toContain(encodeURIComponent(experimentPath));
  expect(JSON.parse(String(puts[0][1]?.body)).experiment.variants[1].overrides).toEqual({
    "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1,
    "gateway-to-middle.timeout": "100ms",
  });
});

it("adds, copies, renames and confirms deletion of a variant while keeping its page active", async () => {
  server();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await open();
  fireEvent.click(button("Add variant"));
  expect(screen.getByRole("tab", { name: "Variant 1" }).getAttribute("aria-selected")).toBe("true");
  editField("Variant label", "My variant");
  editField("Variant ID", "my-variant");
  expect(screen.getByRole("tab", { name: "My variant" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("tab", { name: "My variant" }).getAttribute("aria-selected")).toBe("true");
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("variant-1");
  fireEvent.click(button("Redo"));
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("my-variant");
  editField("Variant ID", "baseline");
  expect(screen.getByText("This variant ID is already used")).toBeTruthy();
  expect(button("Save").disabled).toBe(true);
  expect(button("Add variant").disabled).toBe(true);
  editField("Variant ID", "my-variant");
  fireEvent.click(button("Copy variant"));
  expect(screen.getByRole("tab", { name: "My variant copy" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(button("Delete variant"));
  expect(confirm).toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "My variant copy" })).toBeTruthy();
  confirm.mockReturnValue(true);
  fireEvent.click(button("Delete variant"));
  expect(screen.queryByRole("tab", { name: "My variant copy" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("tab", { name: "My variant copy" })).toBeTruthy();
});

it("edits shared execution and fault settings from a variant and preserves invalid drafts", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  editField("Replications", "3");
  editField("Warm-up", "100ms");
  editField("Measurement", "2s");
  editField("Seed", "9007199254740991");
  editField("Real-time limit", "10s");
  fireEvent.change(screen.getByLabelText("Fault target"), { target: { value: "middle" } });
  editField("Fault start", "100ms");
  editField("Fault end", "500ms");
  editField("Processing multiplier", "4");
  editField("Fault failure rate", "25%");
  editField("Seed", "9007199254740992");
  expect(button("Save").disabled).toBe(true);
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(true);
  editField("Seed", "9007199254740991");
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect((screen.getByLabelText("Replications") as HTMLInputElement).value).toBe("3");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.execution).toEqual({ replications: 3, warmup: "100ms", measurement: "2s", seed: 9007199254740991, maxRealTime: "10s" });
  expect(saved.faults).toEqual([{ target: "middle", from: "100ms", to: "500ms", processingMultiplier: 4, failureRate: "25%" }]);
  expect(saved.variants).toEqual(experiment.variants);
  fireEvent.click(button("Add fault"));
  expect(screen.getAllByLabelText("Fault target")).toHaveLength(2);
  fireEvent.click(button("Remove fault 2"));
  expect(screen.getAllByLabelText("Fault target")).toHaveLength(1);
  fireEvent.click(button("Undo"));
  expect(screen.getAllByLabelText("Fault target")).toHaveLength(2);
});

it("reads duration and probability units for shared fields from the catalog", async () => {
  const customCatalog = structuredClone(catalog);
  const changeUnits = (params: typeof customCatalog.types[number]["params"]) => {
    for (const param of params) {
      if (param.dimension === "DURATION") param.units = [{ symbol: "tick", numerator: 2, denominator: 1 }];
      if (param.dimension === "PROBABILITY") param.units = [{ symbol: "permille", numerator: 1, denominator: 1000 }];
      changeUnits(param.fields);
    }
  };
  customCatalog.types.forEach((type) => changeUnits(type.params));
  const fetchMock = server((url) => url === "/api/v1/catalog" ? { body: customCatalog } : undefined);
  await open();
  editField("Measurement", "20tick");
  editField("Fault failure rate", "250permille");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.execution.measurement).toBe("20tick");
  expect(saved.faults[0].failureRate).toBe("250permille");
});

it("keeps navigation blocked while either the canvas or Inspector draft is invalid", async () => {
  server();
  await open();
  selectGateway();
  const parameter = await screen.findByTestId("canvas-param-gateway-handlers");
  fireEvent.doubleClick(parameter);
  const canvasInput = parameter.querySelector("input")!;
  fireEvent.change(canvasInput, { target: { value: "invalid" } });
  const inspectorInput = within(screen.getByRole("complementary", { name: "Inspector" })).getByLabelText("Handlers");
  fireEvent.change(inspectorInput, { target: { value: "invalid" } });
  expect(screen.getByText(/Fix invalid values before changing/)).toBeTruthy();

  fireEvent.keyDown(canvasInput, { key: "Escape" });
  expect(screen.getByText(/Fix invalid values before changing/)).toBeTruthy();
  expect((screen.getByRole("tab", { name: "Baseline" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(inspectorInput, { target: { value: "4" } });
  expect(screen.queryByText(/Fix invalid values before changing/)).toBeNull();
  expect((screen.getByRole("tab", { name: "Baseline" }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(["Handlers", "Seed"])("preserves an invalid %s draft when a variant ID rename is attempted", async (field) => {
  server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  if (field === "Handlers") selectGateway();
  editField(field, "invalid");
  editField("Variant ID", "renamed");
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe("invalid");
  expect(button("Save").disabled).toBe(true);
  expect(button("Run").disabled).toBe(true);
  expect(screen.getByRole("tab", { name: "No retries" }).getAttribute("aria-selected")).toBe("true");
  editField(field, field === "Handlers" ? "5" : "42");
  fireEvent.blur(screen.getByLabelText("Variant ID"));
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("renamed");
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe(field === "Handlers" ? "5" : "42");
});

it("keeps variant identity when undo restores a different deleted variant before it", async () => {
  const third = { id: "third", label: "Third", overrides: {} };
  const fetchMock = server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
    body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [...experiment.variants, third] } } },
  } : undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  fireEvent.click(button("Delete variant"));
  fireEvent.click(screen.getByRole("tab", { name: "Third" }));
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("tab", { name: "Third" }).getAttribute("aria-selected")).toBe("true");
  selectGateway();
  editHandlers("7");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.variants[1]).toEqual(experiment.variants[1]);
  expect(saved.variants[2].overrides).toEqual({ "gateway.handlers": 7 });
});

describe("App stage 1 integration", () => {
  it("loads the workspace, renders its four blocks and lets each variant edit its overrides", async () => {
    server();
    await open();
    expect(screen.getAllByTestId("block-node")).toHaveLength(4);
    expect(button("Save").disabled).toBe(true);
    expect(button("Run").disabled).toBe(false);
    fireEvent.click(screen.getByTestId("rf__edge-gateway-to-middle"));
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).readOnly).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).readOnly).toBe(false);
  });

  it("preserves an invalid draft and blocks element, pane, variant, experiment, Save and Run navigation", async () => {
    const fetchMock = server();
    const { container } = await open();
    selectGateway();
    editHandlers("oops");
    expect(screen.getByText(/Fix invalid values before changing/i)).toBeTruthy();
    expect(button("Save").disabled).toBe(true);
    expect(button("Run").disabled).toBe(true);
    expect(experimentSelect().disabled).toBe(true);
    expect((screen.getByRole("tab", { name: "Baseline" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("rf__node-middle"));
    fireEvent.click(container.querySelector(".react-flow__pane")!);
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    fireEvent.change(experimentSelect(), { target: { value: otherPath } });
    expect(experimentSelect().value).toBe(experimentPath);
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("oops");
    expect(screen.getByRole("heading", { name: "gateway" })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url, init]) => init?.method === "PUT" || url === "/api/v1/jobs")).toBe(false);
    editHandlers("5");
    expect(experimentSelect().disabled).toBe(false);
    expect(button("Save").disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(false);
  });

  it.each(["baseline", "model"])("isolates equal-valued Inspector drafts between Model and variant %s", async (id) => {
    server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
      body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id, label: "Variant page", overrides: {} }] } } },
    } : undefined);
    await open(); selectGateway();
    fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "04" } });
    fireEvent.click(screen.getByRole("tab", { name: "Variant page" }));
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
  });

  it("requires confirmation to discard edits and clears Inspector selection after a document switch", async () => {
    const fetchMock = server();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await open(); selectGateway(); editHandlers("5");
    fireEvent.change(experimentSelect(), { target: { value: otherPath } });
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to the documents?");
    expect(experimentSelect().value).toBe(experimentPath);
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("5");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(otherPath)))).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.change(experimentSelect(), { target: { value: otherPath } });
    await waitFor(() => expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("99"));
    expect(experimentSelect().value).toBe(otherPath);
    expect(screen.queryByLabelText("Handlers")).toBeNull();
    await screen.findByTestId("rf__node-gateway");
    selectGateway();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
  });

  it("locks document switching during save, sends If-Match and preserves a newer draft after PUT", async () => {
    const gate = deferred();
    const fetchMock = server(async (_url, init) => {
      if (init?.method !== "PUT") return undefined;
      await gate.promise;
      return { body: { path: modelPath, kind: "MODEL", version: "saved" } };
    });
    await open(); selectGateway(); editHandlers("5");
    expect(button("Run").disabled).toBe(true);
    fireEvent.click(button("Save"));
    expect(experimentSelect().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "6" } });
    await act(async () => { gate.release(); });
    await waitFor(() => expect(experimentSelect().disabled).toBe(false));
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("6");
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[1]?.headers).toMatchObject({ "If-Match": '"v-model"' });
    expect(JSON.parse(String(put[1]?.body)).model.blocks.gateway.params.handlers).toBe(5);
    fireEvent.blur(screen.getByLabelText("Handlers"));
    expect(button("Save").disabled).toBe(false);
  });

  it("keeps Save locked after a conflict until Reload explicitly discards drafts", async () => {
    let reloaded = false;
    server((url, init) => {
      if (init?.method === "PUT") { reloaded = true; return { status: 409, body: { code: "VERSION_CONFLICT", message: "changed", diagnostics: [] } }; }
      if (reloaded && url.includes(encodeURIComponent(modelPath))) {
        return { body: { ...documentViews[modelPath], version: "fresh", content: { model: { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 9 } } } } } } };
      }
    });
    await open(); selectGateway(); editHandlers("5"); fireEvent.click(button("Save"));
    await screen.findByText(/The document changed on disk/);
    expect(button("Save").disabled).toBe(true);
    editHandlers("oops");
    fireEvent.click(button("Reload"));
    await screen.findByRole("heading", { name: "Run settings" });
    selectGateway();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("9");
    expect(button("Save").disabled).toBe(true);
    await waitFor(() => expect(button("Run").disabled).toBe(false));
  });

  it("confirms before reloading external changes over drafts and clears history after acceptance", async () => {
    let reported = false;
    const fetchMock = server((url) => {
      if (url.startsWith("/api/v1/workspace/changes?") && !reported) {
        reported = true;
        return { body: { cursor: "test:1", reset: false, changes: [{ path: modelPath, kind: "MODEL", version: "external" }] } };
      }
      if (reported && url.startsWith("/api/v1/workspace/document?") && url.includes(encodeURIComponent(modelPath))) {
        return { body: { ...documentViews[modelPath], version: "fresh", content: { model: { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 9 } } } } } } };
      }
    });
    await open(); selectGateway(); editHandlers("5");
    await screen.findByText(/The document changed on disk/, undefined, { timeout: 3000 });
    expect(screen.getByText(modelPath)).toBeTruthy();
    expect(screen.getByText(/Reload will discard unsaved changes/)).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const reads = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/workspace/document?")).length;

    fireEvent.click(button("Reload"));
    expect(confirm).toHaveBeenCalledWith("Reload and discard unsaved changes to the documents?");
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("5");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/workspace/document?")).length).toBe(reads);

    confirm.mockReturnValue(true);
    fireEvent.click(button("Reload"));
    await screen.findByRole("heading", { name: "Run settings" });
    selectGateway();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("9");
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
  });

  it("shows an external deletion without a Reload button and keeps the editor draft", async () => {
    let reported = false;
    server((url) => {
      if (url.startsWith("/api/v1/workspace/changes?") && !reported) {
        reported = true;
        return { body: { cursor: "test:1", reset: false, changes: [{ path: modelPath, kind: "MODEL", version: null }] } };
      }
    });
    await open(); selectGateway(); editHandlers("5");

    await screen.findByText(/The document was deleted on disk/, undefined, { timeout: 3000 });
    expect(screen.getByText(modelPath)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("5");
  });

  it("reloads an external change without confirmation when there are no drafts", async () => {
    let reported = false;
    server((url) => {
      if (url.startsWith("/api/v1/workspace/changes?") && !reported) {
        reported = true;
        return { body: { cursor: "test:1", reset: false, changes: [{ path: modelPath, kind: "MODEL", version: "external" }] } };
      }
      if (reported && url.startsWith("/api/v1/workspace/document?") && url.includes(encodeURIComponent(modelPath))) {
        return { body: { ...documentViews[modelPath], version: "fresh", content: { model: { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 9 } } } } } } };
      }
    });
    const confirm = vi.spyOn(window, "confirm");
    await open();
    await screen.findByText(/The document changed on disk/, undefined, { timeout: 3000 });

    fireEvent.click(button("Reload"));
    await screen.findByRole("heading", { name: "Run settings" });
    expect(confirm).not.toHaveBeenCalled();
    selectGateway();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("9");
  });

  it("blocks experiment switching while running and clears completed results for another experiment", async () => {
    const gate = deferred();
    server(async (url) => {
      if (url !== "/api/v1/jobs") return undefined;
      await gate.promise;
      return { status: 202, body: completed };
    });
    await open(); fireEvent.click(button("Run"));
    expect(experimentSelect().disabled).toBe(true);
    expect(button("Run").disabled).toBe(true);
    await act(async () => { gate.release(); });
    await screen.findByRole("table");
    expect(within(screen.getByRole("region", { name: "Results" })).getByText(/97\.5%/)).toBeTruthy();
    fireEvent.change(experimentSelect(), { target: { value: otherPath } });
    await waitFor(() => expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("99"));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("job-status").textContent).toBe("");
    fireEvent.change(experimentSelect(), { target: { value: experimentPath } });
    await waitFor(() => expect(experimentSelect().value).toBe(experimentPath));
    expect(screen.queryByRole("table")).toBeNull();
  });
});

it("keeps navigation available until invalid stored variant data is edited", async () => {
  server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
    body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id: "invalid", label: "Invalid variant", overrides: { "gateway.handlers": 0 } }] } } },
  } : undefined);
  await open(); selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Invalid variant" }));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("0");
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(false);
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(false);
  expect(experimentSelect().disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "oops" } });
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
});


it("exposes undo and redo buttons without putting selection or variant navigation in history", async () => {
  server();
  await open();
  expect(button("Undo").disabled).toBe(true);
  expect(button("Redo").disabled).toBe(true);
  selectGateway(); editHandlers("5");
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(button("Undo"));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
  expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
  expect(button("Save").disabled).toBe(true);
  fireEvent.click(button("Redo"));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("5");
  expect(button("Save").disabled).toBe(false);
});

it("supports Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y outside form fields", async () => {
  server();
  await open(); selectGateway(); editHandlers("5");
  const handlers = () => (screen.getByLabelText("Handlers") as HTMLInputElement).value;
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(handlers()).toBe("4");
  fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
  expect(handlers()).toBe("5");
  fireEvent.keyDown(document.body, { key: "z", metaKey: true });
  expect(handlers()).toBe("4");
  fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
  expect(handlers()).toBe("5");
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
  expect(handlers()).toBe("5");
});

it("leaves field undo native and prevents history actions from discarding invalid drafts", async () => {
  server();
  await open(); selectGateway(); editHandlers("5");
  const input = screen.getByLabelText("Handlers") as HTMLInputElement;
  const nativeUndo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  fireEvent(input, nativeUndo);
  expect(nativeUndo.defaultPrevented).toBe(false);
  expect(input.value).toBe("5");
  fireEvent.change(input, { target: { value: "invalid" } });
  expect(button("Undo").disabled).toBe(true);
  expect(button("Redo").disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(input.value).toBe("invalid");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(input.value).toBe("4");
});


it("renames a block with cascading document writes and restores all documents with undo", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByTestId("rf__node-dependency"));
  const identifier = screen.getByLabelText("Identifier");
  fireEvent.change(identifier, { target: { value: "middle" } });
  expect(button("Save").disabled).toBe(true);
  expect(screen.getByText("This identifier is already used.")).toBeTruthy();
  fireEvent.keyDown(identifier, { key: "Escape" });
  expect((identifier as HTMLInputElement).value).toBe("dependency");
  fireEvent.change(identifier, { target: { value: "storage" } });
  fireEvent.keyDown(identifier, { key: "Enter" });
  await screen.findByTestId("rf__node-storage");
  expect(screen.queryByTestId("rf__node-dependency")).toBeNull();
  expect(screen.getByRole("heading", { name: "storage" })).toBeTruthy();
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const contents = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(contents.map((content) => Object.keys(content)[0])).toEqual(["layout", "model", "experiment"]);
  expect(contents[0].layout.positions.storage).toEqual({ x: 780, y: 100 });
  expect(contents[1].model.connections[2].to).toBe("storage");
  expect(contents[2].experiment.faults[0].target).toBe("storage");
  fireEvent.click(button("Undo"));
  await screen.findByTestId("rf__node-dependency");
  expect(screen.queryByTestId("rf__node-storage")).toBeNull();
  expect(button("Save").disabled).toBe(false);
});

it("deletes a selection with its edges and overrides in one undo step, leaving form deletion native", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByTestId("rf__node-middle"));
  const input = screen.getByLabelText("Handlers");
  const native = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
  fireEvent(input, native);
  expect(native.defaultPrevented).toBe(false);
  expect(screen.getAllByTestId("block-node")).toHaveLength(4);
  fireEvent.keyDown(document.body, { key: "Delete" });
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(3));
  expect(screen.queryByTestId("rf__edge-gateway-to-middle")).toBeNull();
  expect(screen.queryByTestId("rf__edge-middle-to-dependency")).toBeNull();
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const saved = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init?.body)));
  expect(saved.find((body) => body.experiment).experiment.variants[1].overrides).toEqual({});
  fireEvent.click(button("Undo"));
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  expect(screen.getByTestId("rf__edge-gateway-to-middle")).toBeTruthy();
});

it("copies multi-selected blocks and internal connections; variant pages reject structural shortcuts", async () => {
  server();
  await open();
  selectGateway();
  fireEvent.click(screen.getByTestId("rf__node-middle"), { ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "c", metaKey: true });
  fireEvent.keyDown(document.body, { key: "v", metaKey: true });
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(6));
  expect(screen.getByTestId("rf__edge-service-1-to-service-2")).toBeTruthy();
  fireEvent.click(button("Undo"));
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "Delete" });
  expect(screen.getAllByTestId("block-node")).toHaveLength(4);
  expect(button("Save").disabled).toBe(true);
  expect((within(screen.getByRole("complementary", { name: "Palette" })).getByRole("button", { name: "Service" }) as HTMLButtonElement).disabled).toBe(true);
});

it("creates an empty-parameter block by dropping a catalog type and undoes model and layout together", async () => {
  server();
  const { container } = await open();
  fireEvent.drop(container.querySelector(".react-flow")!, {
    clientX: 80, clientY: 40, dataTransfer: { getData: () => "service" },
  });
  await screen.findByTestId("rf__node-service-1");
  expect(screen.getAllByTestId("block-node")).toHaveLength(5);
  fireEvent.click(screen.getByTestId("rf__node-service-1"));
  expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
  // Missing document values are validation issues; only an invalid typed draft blocks navigation.
  expect(button("Undo").disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "oops" } });
  expect(button("Undo").disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "" } });
  fireEvent.click(button("Undo"));
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  expect(button("Save").disabled).toBe(true);
});


it("persists a keyboard move as a layout command and restores it with undo", async () => {
  server();
  await open(); selectGateway();
  const node = screen.getByTestId("rf__node-gateway");
  fireEvent.keyDown(node, { key: "ArrowRight", code: "ArrowRight" });
  expect(node.style.transform).toBe("translate(280px,100px)");
  expect(button("Save").disabled).toBe(false);
  fireEvent.click(button("Undo"));
  expect(node.style.transform).toBe("translate(260px,100px)");
  expect(button("Save").disabled).toBe(true);
});


it("targets the pasted fragment with subsequent arrow and delete actions", async () => {
  server();
  await open(); selectGateway();
  fireEvent.click(screen.getByTestId("rf__node-middle"), { ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  const copy = await screen.findByTestId("rf__node-service-1");
  expect(copy.classList.contains("selected")).toBe(true);
  expect(screen.getByTestId("rf__node-gateway").classList.contains("selected")).toBe(false);
  fireEvent.keyDown(copy, { key: "ArrowRight", code: "ArrowRight" });
  expect(copy.style.transform).toBe("translate(320px,140px)");
  expect(screen.getByTestId("rf__node-gateway").style.transform).toBe("translate(260px,100px)");
  fireEvent.keyDown(document.body, { key: "Delete" });
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  expect(screen.getByTestId("rf__node-gateway")).toBeTruthy();
  expect(screen.getByTestId("rf__node-middle")).toBeTruthy();
  expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
  expect(button("Save").disabled).toBe(true);
});

it.each(["model", "experiment"] as const)("marks results stale after %s edits and clears the mark after undo", async (kind) => {
  server();
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Summary" });
  if (kind === "model") {
    selectGateway();
    editHandlers("5");
  } else {
    editField("Seed", "43");
  }
  const stale = "Results belong to a previous document version.";
  await screen.findByText(stale);

  fireEvent.click(screen.getByRole("tab", { name: "Assumptions" }));
  expect(screen.getByText(stale)).toBeTruthy();
  expect(screen.getByText("Student 95% confidence intervals are not clipped.")).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.queryByText(stale)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
  expect(screen.queryByText(stale)).toBeNull();
});

it("changes results panel grid size without issuing document commands", async () => {
  const fetchMock = server();
  await open();
  const app = document.querySelector(".app")!;
  expect(app.className).toContain("app--results-normal");

  fireEvent.click(button("Expand results"));
  expect(app.className).toContain("app--results-expanded");
  fireEvent.click(button("Restore results"));
  expect(app.className).toContain("app--results-normal");
  fireEvent.click(button("Collapse results"));
  expect(app.className).toContain("app--results-collapsed");
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(button("Restore results"));
  expect(app.className).toContain("app--results-normal");

  expect(button("Undo").disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
});


describe("cost estimate and resume", () => {
  it("estimates unsaved model and experiment drafts without saving or starting a job", async () => {
    const fetchMock = server();
    await open(); selectGateway(); editHandlers("5");
    editField("Seed", "42");
    fireEvent.click(button("Estimate"));
    const estimate = await screen.findByRole("region", { name: "Cost estimate" });
    expect(within(estimate).getByLabelText("Tasks").textContent).toBe("4");
    expect(within(estimate).getByLabelText("Workers").textContent).toBe("2");
    expect(within(estimate).getByLabelText("Expected events").textContent).toBe("12,345");
    expect(within(estimate).getByLabelText("Expected rows").textContent).toBe("400");
    expect(within(estimate).getByLabelText("Estimated time").textContent).toBe("1.25 s");
    expect(within(estimate).getByLabelText("Uncompressed size").textContent).toBe("204,800 B");
    expect(within(estimate).getByLabelText("Artifact size").textContent).toBe("51,200 B");
    expect(within(estimate).getByLabelText("Parts").textContent).toBe("4");
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/v1/estimate")!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.experiment).toBe(experimentPath);
    expect(body.drafts).toHaveLength(2);
    expect(body.drafts.find((draft: { path: string }) => draft.path === modelPath).content.model.blocks.gateway.params.handlers).toBe(5);
    expect(body.drafts.find((draft: { path: string }) => draft.path === experimentPath).content.experiment.execution.seed).toBe(42);
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/jobs" || init?.method === "PUT")).toBe(false);
    editHandlers("6");
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
  });

  it.each([false, true])("requires an explicit budget decision before Run: accepted=%s", async (accepted) => {
    const warning = { code: "ESTIMATE_UI_CACHE", message: "Estimated uncompressed task data exceed the 64 MiB UI cache budget; load selected nodes only" };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(accepted);
    const fetchMock = server((url) => url === "/api/v1/estimate" ? { body: { ...costEstimate, warnings: [warning] } } : undefined);
    await open();
    fireEvent.click(button("Run"));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm.mock.calls[0][0]).toContain(warning.message);
    await waitFor(() => expect(button("Run").disabled).toBe(false));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs")).toHaveLength(accepted ? 1 : 0);
    expect(screen.getByRole("region", { name: "Cost estimate" }).textContent).toContain(warning.message);
    if (accepted) await screen.findByRole("table", { name: "Summary" });
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
    await screen.findByRole("table", { name: "Summary" });
    const requests = fetchMock.mock.calls.map(([url]) => url).filter((url) => url === "/api/v1/estimate" || url === "/api/v1/jobs");
    expect(requests).toEqual(["/api/v1/estimate", "/api/v1/estimate", "/api/v1/jobs"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not start a run when estimation fails", async () => {
    const fetchMock = server((url) => url === "/api/v1/estimate" ? {
      status: 503, body: { code: "ESTIMATE_UNAVAILABLE", message: "Estimation unavailable", diagnostics: [] },
    } : undefined);
    await open(); fireEvent.click(button("Run"));
    await screen.findByText("Estimation unavailable");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
    expect(button("Run").disabled).toBe(false);
  });

  it.each([false, true])("discards a late estimate after an edit: rejected=%s", async (rejected) => {
    const gate = deferred();
    const fetchMock = server(async (url) => {
      if (url !== "/api/v1/estimate") return undefined;
      await gate.promise;
      return rejected ? { status: 400, body: { code: "OLD_ESTIMATE", message: "Old estimate error", diagnostics: [] } } : { body: costEstimate };
    });
    await open(); selectGateway(); fireEvent.click(button("Run"));
    expect(button("Run").disabled).toBe(true);
    editHandlers("5");
    await act(async () => { gate.release(); });
    expect(screen.queryByRole("region", { name: "Cost estimate" })).toBeNull();
    expect(screen.queryByText("Old estimate error")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
  });

  it.each(["CANCELLED", "FAILED"] as const)("resumes an incomplete %s run and displays Summary", async (status) => {
    let resumed = false;
    server((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status, error: status === "FAILED" ? "Execution stopped" : null } };
      if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: resumed } };
      if (url === "/api/v1/runs/run-1/resume") {
        resumed = true;
        return { status: 202, body: { ...completed, id: "resume-1", status: "RUNNING" } };
      }
      if (url === "/api/v1/jobs/resume-1") return { body: { ...completed, id: "resume-1" } };
    });
    await open(); fireEvent.click(button("Run"));
    const resume = await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(resume);
    await screen.findByRole("table", { name: "Summary" });
    expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it.each([
    [409, "RUN_COMPLETE", []],
    [400, "EXPERIMENT_INVALID", [{ code: "RUN_DOCUMENT_CHANGED", severity: "ERROR", message: "Model changed", document: modelPath, pointer: null, path: null, variant: null }]],
  ] as const)("shows resume refusal %s with diagnostics and a new-run suggestion", async (status, code, diagnostics) => {
    server((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
      if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
      if (url === "/api/v1/runs/run-1/resume") return { status, body: { code, message: "Cannot resume this run", diagnostics } };
    });
    await open(); fireEvent.click(button("Run"));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cannot resume this run");
    expect(alert.textContent).toContain("Start a new run");
    if (status === 400) expect(alert.textContent).toContain("RUN_DOCUMENT_CHANGED");
    expect(button("Run").disabled).toBe(false);
    expect(screen.queryByRole("table", { name: "Summary" })).toBeNull();
  });

  it("does not offer Resume when cancellation created no artifact", async () => {
    server((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
      if (url === "/api/v1/runs/run-1/manifest") return { status: 404, body: { code: "RUN_NOT_FOUND", message: "No artifact", diagnostics: [] } };
    });
    await open(); fireEvent.click(button("Run"));
    await screen.findByText("Run cancelled; the run is incomplete and has no summary.");
    await waitFor(() => expect(button("Run").disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
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
  await open(); selectGateway();
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


it.each(["Estimate", "Run"])("makes the estimate visible when %s starts from expanded results", async (action) => {
  server(); await open();
  fireEvent.click(button("Expand results"));
  expect(button("Restore results")).toBeTruthy();
  fireEvent.click(button(action));
  await screen.findByRole("region", { name: "Cost estimate" });
  expect(button("Expand results")).toBeTruthy();
});


it.each(["Assumptions", "Problems", "Timeline", "collapsed"])("shows resume refusal from %s", async (view) => {
  server((url) => {
    if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
    if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
    if (url === "/api/v1/runs/run-1/resume") return {
      status: 409, body: { code: "RUN_COMPLETE", message: "Cannot resume this run", diagnostics: [] },
    };
  });
  await open(); fireEvent.click(button("Run"));
  const resume = await screen.findByRole("button", { name: "Resume" });
  if (view === "collapsed") fireEvent.click(button("Collapse results"));
  else fireEvent.click(screen.getByRole("tab", { name: view }));
  fireEvent.click(resume);
  expect((await screen.findByRole("alert")).textContent).toContain("Start a new run");
});
