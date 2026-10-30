import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { documentViews, experiment, experimentPath, model, modelPath } from "./test/fixtures";
import { setupAppTests, otherPath, completed, deferred, server, open, selectGateway, editHandlers, button, experimentSelect } from "./test/app";

setupAppTests();

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
    await selectGateway();
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
    await open(); await selectGateway();
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
    await open(); await selectGateway(); editHandlers("5");
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
    await selectGateway();
    expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
  });

  it("locks document switching during save, sends If-Match and preserves a newer draft after PUT", async () => {
    const gate = deferred();
    const fetchMock = server(async (_url, init) => {
      if (init?.method !== "PUT") return undefined;
      await gate.promise;
      return { body: { path: modelPath, kind: "MODEL", version: "saved" } };
    });
    await open(); await selectGateway(); editHandlers("5");
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
    await open(); await selectGateway(); editHandlers("5"); fireEvent.click(button("Save"));
    await screen.findByText(/The document changed on disk/);
    expect(button("Save").disabled).toBe(true);
    editHandlers("oops");
    fireEvent.click(button("Reload"));
    await screen.findByRole("heading", { name: "Run settings" });
    await selectGateway();
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
    await open(); await selectGateway(); editHandlers("5");
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
    await selectGateway();
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
    await open(); await selectGateway(); editHandlers("5");

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
    await selectGateway();
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
    await screen.findByRole("table", { name: "Answer" });
    expect(within(screen.getByRole("region", { name: "Results" })).getByText(/97\.5%/)).toBeTruthy();
    fireEvent.change(experimentSelect(), { target: { value: otherPath } });
    await waitFor(() => expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("99"));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("job-status").textContent).toBe("Ready");
    fireEvent.change(experimentSelect(), { target: { value: experimentPath } });
    await waitFor(() => expect(experimentSelect().value).toBe(experimentPath));
    expect(screen.queryByRole("table")).toBeNull();
  });

});
