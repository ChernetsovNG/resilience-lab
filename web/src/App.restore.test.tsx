import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { experimentPath, manifest, model, modelPath, summary } from "./test/fixtures";
import { button, completed, editHandlers, open, selectGateway, server, setupAppTests } from "./test/app";

setupAppTests();

const storedManifest = manifest;
const entry = { id: "stored", experiment: experimentPath, directory: ".results/retry-storm/stored", complete: true, sizeBytes: 100, completedAt: 2000 };

describe("restoring stored results", () => {
  it("does not mark unchanged documents stale when canonical snapshots reorder connections", async () => {
    server(url => {
      if (url === "/api/v1/runs") return { body: [entry] };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === "/api/v1/runs/stored/manifest") return { body: {
        ...storedManifest, snapshots: { ...storedManifest.snapshots,
          [modelPath]: JSON.stringify({ ...model, connections: [...model.connections].reverse() }) },
      } };
    });
    await open();
    await screen.findByRole("table", { name: "Findings" });
    expect(screen.queryAllByText("Results belong to a previous document version.")).toHaveLength(0);
  });

  it("shows a stored-results read failure and allows starting a new run", async () => {
    server(url => url === "/api/v1/runs" ? { status: 503, body: {
      code: "RUNS_UNAVAILABLE", message: "Stored runs are unavailable", diagnostics: [],
    } } : undefined);
    await open();
    expect((await screen.findByRole("alert")).textContent).toContain("Stored runs are unavailable");
    fireEvent.click(button("Run"));
    await screen.findByRole("table", { name: "Findings" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows Findings and diagram metrics after reopening without a new job", async () => {
    let submissions = 0;
    server((url, init) => {
      if (url === "/api/v1/runs") return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === "/api/v1/jobs" && init?.method === "POST") submissions += 1;
    });
    const view = await open();
    await screen.findByRole("table", { name: "Findings" });
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect((await screen.findByTestId("canvas-results-gateway")).textContent).toContain("50%");
    view.unmount();
    await open();
    await screen.findByRole("table", { name: "Findings" });
    expect(submissions).toBe(0);
  });

  it("restores results when the current model is explicitly reopened", async () => {
    server(url => {
      if (url === "/api/v1/runs") return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
    });
    await open();
    await screen.findByRole("table", { name: "Findings" });
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: modelPath } });
    await screen.findByRole("table", { name: "Findings" });
  });

  it("compares saved and unsaved edits with the original snapshots", async () => {
    const changed = { ...model, blocks: { ...model.blocks, gateway: { ...model.blocks.gateway, params: { ...model.blocks.gateway.params, handlers: 9 } } } };
    server(url => {
      if (url === "/api/v1/runs") return { body: [entry] };
      if (url === "/api/v1/runs/stored/manifest") return { body: storedManifest };
      if (url === "/api/v1/runs/stored/summary") return { body: summary };
      if (url === `/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`) {
        return { body: { path: modelPath, kind: "MODEL", version: "changed", content: { model: changed } } };
      }
    });
    await open();
    await screen.findByRole("table", { name: "Findings" });
    expect((await screen.findAllByText("Results belong to a previous document version.")).length).toBeGreaterThan(0);
    await selectGateway();
    editHandlers("4");
    expect(screen.queryAllByText("Results belong to a previous document version.")).toHaveLength(0);
  });

  it("keeps completed results and offers Resume for a newer incomplete run", async () => {
    let resumed = false;
    server(url => {
      if (url === "/api/v1/runs") return { body: [{ ...entry, id: "incomplete", complete: false, completedAt: null }, entry] };
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
    await screen.findByRole("table", { name: "Findings" });
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED"));
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(button("Run").disabled).toBe(false);
  });
});
