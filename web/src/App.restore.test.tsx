import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentDraft } from "./api/apiTypes";
import { experimentPath, manifest, model, modelPath, summary } from "./test/fixtures";
import { button, completed, editHandlers, open, selectGateway, server, setupAppTests } from "./test/app";

setupAppTests();

const storedManifest = manifest;
const entry = { id: "stored", experiment: experimentPath, directory: ".results/retry-storm/stored", complete: true, sizeBytes: 100, completedAt: 2000 };

async function showResults() {
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  await screen.findByRole("table", { name: "Findings" });
}

describe("restoring stored results", () => {
  it("keeps the results panel collapsed while loading stored metrics", async () => {
    server(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
    });
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    await screen.findByTestId("canvas-results-gateway");
    expect((screen.getByRole("tabpanel", { hidden: true }) as HTMLElement).hidden).toBe(true);
  });

  it("keeps restored parameters open and validates edits to a variant", async () => {
    let validated = false;
    server((url, init) => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === "/api/v1/validate") {
        const drafts = JSON.parse(String(init?.body)).drafts as DocumentDraft[];
        validated = drafts.some(draft => draft.content.experiment?.variants.some(variant =>
          variant.id === "baseline" && variant.overrides["gateway.handlers"] === 5));
      }
    });
    const view = await open();
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    fireEvent.click(screen.getByTestId("rf__node-gateway"));
    expect(view.container.querySelector<HTMLDetailsElement>(".inspector-parameters")?.open).toBe(true);
    const handlers = screen.getByLabelText("Handlers");
    fireEvent.change(handlers, { target: { value: "5" } });
    fireEvent.keyDown(handlers, { key: "Enter" });
    await waitFor(() => expect(validated).toBe(true));
    expect(button("Save").disabled).toBe(false);
  });

  it("does not mark unchanged documents stale when canonical snapshots reorder connections", async () => {
    server(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [entry] };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === "/api/v1/runs/stored/manifest") return { body: {
        ...storedManifest, snapshots: { ...storedManifest.snapshots,
          [modelPath]: JSON.stringify({ ...model, connections: [...model.connections].reverse() }) },
      } };
    });
    await open();
    await showResults();
    expect(screen.queryAllByText("Results belong to a previous document version.")).toHaveLength(0);
  });

  it("shows a stored-results read failure and allows starting a new run", async () => {
    server(url => url.startsWith("/api/v1/runs/latest?") ? { status: 503, body: {
      code: "RUNS_UNAVAILABLE", message: "Stored runs are unavailable", diagnostics: [],
    } } : undefined);
    await open();
    expect((screen.getByRole("tabpanel", { hidden: true }) as HTMLElement).hidden).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Problems" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Stored runs are unavailable");
    fireEvent.click(button("Run"));
    await showResults();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows Findings and diagram metrics after reopening without a new job", async () => {
    let submissions = 0;
    server((url, init) => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === "/api/v1/jobs" && init?.method === "POST") submissions += 1;
    });
    const view = await open();
    await showResults();
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect((await screen.findByTestId("canvas-results-gateway")).textContent).toContain("50%");
    view.unmount();
    await open();
    await showResults();
    expect(submissions).toBe(0);
  });

  it("restores results when the current model is explicitly reopened", async () => {
    server(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
    });
    await open();
    await showResults();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: modelPath } });
    await showResults();
  });

  it("compares saved and unsaved edits with the original snapshots", async () => {
    const changed = { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 9 } } } };
    server(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === `/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`) {
        return { body: { path: modelPath, kind: "MODEL", version: "changed", content: { model: changed } } };
      }
    });
    await open();
    await showResults();
    expect((await screen.findAllByText("Results belong to a previous document version.")).length).toBeGreaterThan(0);
    await selectGateway();
    editHandlers("4");
    expect(screen.queryAllByText("Results belong to a previous document version.")).toHaveLength(0);
  });

  it("keeps completed results and offers Resume for a newer incomplete run", async () => {
    let resumed = false;
    server(url => {
      if (url.startsWith("/api/v1/runs/latest?")) return { body: [{ ...entry, id: "incomplete", complete: false, completedAt: null }, entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === "/api/v1/runs/incomplete/manifest") return { body: { ...storedManifest, complete: resumed } };
      if (url === "/api/v1/runs/incomplete/resume") {
        resumed = true;
        return { status: 202, body: { ...completed, id: "resume", runId: "incomplete" } };
      }
      if (url === "/api/v1/runs/incomplete/summary") return { body: summary };
    });
    await open();
    await showResults();
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED"));
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(button("Run").disabled).toBe(false);
  });
});
