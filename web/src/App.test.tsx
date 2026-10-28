import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { DocumentView, JobView } from "./api/apiTypes";
import { catalog, documentViews, experiment, experimentPath, model, modelPath, summary } from "./test/fixtures";
import { mockReactFlowDom } from "./test/reactFlow";
import { stubFetch, type StubResponse } from "./test/stubFetch";

beforeAll(mockReactFlowDom);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const otherPath = "retry-storm/second.experiment.json";
const health = { status: "UP", applicationVersion: "test", kslVersion: "test" };
const completed: JobView = {
  id: "job-1", experiment: experimentPath, runId: "run-1", status: "COMPLETED",
  completedTasks: 4, totalTasks: 4, error: null, diagnostics: [],
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
    if (url.startsWith("/api/v1/workspace/document?")) {
      const path = new URL(url, "http://localhost").searchParams.get("path")!;
      if (init?.method === "PUT") return { body: { path, kind: "MODEL", version: "saved" } };
      return { body: documents[path] };
    }
    if (url === "/api/v1/jobs") return { status: 202, body: completed };
    if (url === "/api/v1/runs/run-1/summary") return { body: summary };
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

describe("App stage 1 integration", () => {
  it("loads the workspace, renders its four blocks and keeps variant pages read-only", async () => {
    server();
    await open();
    expect(screen.getAllByTestId("block-node")).toHaveLength(4);
    expect(button("Save").disabled).toBe(true);
    expect(button("Run").disabled).toBe(false);
    fireEvent.click(screen.getByTestId("rf__edge-gateway-to-middle"));
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Attempts") as HTMLInputElement).readOnly).toBe(true);
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
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(true);
  });

  it.each(["baseline", "model"])("isolates equal-valued Inspector drafts between Model and variant %s", async (id) => {
    server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
      body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id, label: "Variant page", overrides: {} }] } } },
    } : undefined);
    await open(); selectGateway();
    fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "04" } });
    fireEvent.click(screen.getByRole("tab", { name: "Variant page" }));
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(true);
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
    await screen.findByText("99");
    expect(experimentSelect().value).toBe(otherPath);
    expect(screen.queryByLabelText("Handlers")).toBeNull();
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
    await screen.findByText("99");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("job-status").textContent).toBe("");
    fireEvent.change(experimentSelect(), { target: { value: experimentPath } });
    await waitFor(() => expect(experimentSelect().value).toBe(experimentPath));
    expect(screen.queryByRole("table")).toBeNull();
  });
});

it("keeps navigation available when a read-only variant contains invalid stored data", async () => {
  server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
    body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id: "invalid", label: "Invalid variant", overrides: { "gateway.handlers": 0 } }] } } },
  } : undefined);
  await open(); selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Invalid variant" }));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("0");
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(false);
  expect(experimentSelect().disabled).toBe(false);
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
