import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, vi } from "vitest";
import { App } from "../App";
import type { DocumentView, JobView } from "../api/apiTypes";
import { catalog, costEstimate, documentViews, experiment, experimentPath, manifest, summary } from "./fixtures";
import { mockReactFlowDom } from "./reactFlow";
import { stubFetch, type StubResponse } from "./stubFetch";

export function setupAppTests() {
  beforeAll(mockReactFlowDom);
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
}

export const otherPath = "retry-storm/second.experiment.json";

export const health = { status: "UP", applicationVersion: "test", kslVersion: "test" };

export const completed: JobView = {
  id: "job-1", experiment: experimentPath, runId: "run-1", status: "COMPLETED",
  completedTasks: 4, totalTasks: 4, cancelRequested: false, error: null, diagnostics: [],
};

export function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export function server(override?: (url: string, init?: RequestInit) => StubResponse | Promise<StubResponse | undefined> | undefined) {
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
    if (url === "/api/v1/workspace/documents") return { body: Object.values(documents).map(view => ({ ...view, modelRef: view.content.experiment?.modelRef ?? null })) };
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
    if (url === "/api/v1/jobs") return init?.method === "POST" ? { status: 202, body: completed } : { body: [] };
    if (url === "/api/v1/runs" || url === "/api/v1/runs/obsolete") return { body: [] };
    if (url.startsWith("/api/v1/runs/latest?")) return { body: [] };
    if (url === "/api/v1/runs/run-1/summary") return { body: summary };
    if (url === "/api/v1/runs/run-1/manifest") return { body: manifest };
    throw new Error(`Unexpected request: ${url}`);
  });
}

export async function open() {
  const view = render(<App />);
  await screen.findByRole("heading", { name: "Run settings" });
  await screen.findByTestId("rf__node-gateway");
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  return view;
}

export async function selectGateway() { fireEvent.click(await screen.findByTestId("rf__node-gateway")); }

export function editHandlers(value: string) {
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value } });
  fireEvent.blur(screen.getByLabelText("Handlers"));
}

export const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

export const experimentSelect = () => screen.getByRole("combobox", { name: "Experiment" }) as HTMLSelectElement;

export function editField(label: string, value: string) {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

export function measuredWorkspace() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("workspace-panels") ? new DOMRect(0, 0, 1440, 800) : new DOMRect(0, 0, 180, 80);
  });
}
