import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { button, editHandlers, selectGateway, server, setupAppTests } from "./test/app";
import { documentViews, experimentPath, layoutPath, modelPath } from "./test/fixtures";
import type { RunEntry, RunStorageEntry } from "./api/apiTypes";

setupAppTests();
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

function storage(modelOnly = false, runs: RunEntry[] = [], obsolete: RunStorageEntry[] = []) {
  const views = structuredClone(documentViews);
  if (modelOnly) { delete views[experimentPath]; delete views[layoutPath]; }
  server((url, init) => {
    if (url === "/api/v1/runs") return { body: runs };
    if (url === "/api/v1/runs/obsolete") return { body: obsolete };
    if (url === "/api/v1/workspace/documents") return { body: Object.values(views).map(view => ({ ...view, modelRef: view.content.experiment?.modelRef ?? null })) };
    if (!url.startsWith("/api/v1/workspace/document?")) return;
    const path = new URL(url, "http://test").searchParams.get("path")!;
    if (init?.method === "DELETE") {
      if (new Headers(init.headers).get("If-Match") !== `"${views[path]?.version}"`) return { status: 409, body: { code: "VERSION_CONFLICT", message: "Changed", diagnostics: [] } };
      delete views[path];
      return { status: 204 };
    }
    return { body: views[path] };
  });
  return views;
}

async function choose(name: string) {
  await waitFor(() => expect(button("File").disabled).toBe(false));
  fireEvent.click(button("File"));
  await waitFor(() => expect(screen.getByRole("button", { name, hidden: true })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name, hidden: true }));
}

it("places File first after the application name", async () => {
  storage(); render(<App />);
  await screen.findByTestId("rf__node-gateway");
  const controls = screen.getByRole("banner").querySelectorAll("button, select");
  expect(controls[0]).toBe(button("File"));
});

it.each([
  ["Model", "+ New model…", "New model", modelPath],
  ["Experiment", "+ New experiment…", "New experiment", experimentPath],
])("opens the shared creation dialog from %s and keeps the selection on cancel", async (label, option, title, path) => {
  storage(); render(<App />);
  await screen.findByTestId("rf__node-gateway");
  const select = screen.getByRole<HTMLSelectElement>("combobox", { name: label });
  await waitFor(() => expect(select.disabled).toBe(false));
  const create = within(select).getByRole<HTMLOptionElement>("option", { name: option });
  expect(select.options[select.options.length - 1]).toBe(create);
  fireEvent.change(select, { target: { value: create.value } });
  const dialog = await screen.findByRole("dialog", { name: title });
  expect(select.value).toBe(path);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(select.value).toBe(path);
  await choose(title);
  expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
});

it.each([
  ["Model", "+ New model…"], ["Experiment", "+ New experiment…"],
])("preserves unsaved changes when creation from %s is declined", async (label, option) => {
  storage(); render(<App />); await selectGateway(); editHandlers("7");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const select = screen.getByRole<HTMLSelectElement>("combobox", { name: label });
  const previous = select.value;
  const create = within(select).getByRole<HTMLOptionElement>("option", { name: option });
  fireEvent.change(select, { target: { value: create.value } });
  expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to the documents?");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(select.value).toBe(previous);
  expect(screen.getByLabelText("Handlers")).toHaveProperty("value", "7");
});

it("lists every deletion target, permits cancellation and guides the empty workspace after confirmation", async () => {
  const views = storage();
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  await choose("Delete model…");
  const dialog = await screen.findByRole("dialog", { name: "Delete model…" });
  for (const path of [experimentPath, layoutPath, modelPath]) await within(dialog).findByText(path);
  expect(within(dialog).getByText(/Undo cannot restore/)).toBeTruthy();
  expect(Object.keys(views)).toHaveLength(3);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(Object.keys(views)).toHaveLength(3);
  await choose("Delete model…");
  await waitFor(() => expect((within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await screen.findByText("No models. Create a model through File → New model.");
  expect(views).toEqual({});
  expect(button("Undo").disabled).toBe(true);
  expect(button("File").disabled).toBe(false);
});

it("shows the run count and total size before confirming experiment deletion", async () => {
  storage(false, [
    { id: "one", experiment: experimentPath, directory: ".results/retry-storm/one", complete: true, sizeBytes: 1024 },
    { id: "two", experiment: experimentPath, directory: ".results/retry-storm/two", complete: true, sizeBytes: 2048 },
  ]);
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  await choose("Delete experiment…");
  const dialog = await screen.findByRole("dialog", { name: "Delete experiment…" });
  await within(dialog).findByText("Runs: 2, total: 3 KiB.");
});

it("disables cleanup with a hint when there are no obsolete runs", async () => {
  storage();
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  const cleanup = screen.getByRole("button", { name: "Clean up obsolete runs…", hidden: true });
  expect(cleanup).toHaveProperty("disabled", true);
  expect(cleanup.getAttribute("title")).toBe("No obsolete runs to delete.");
});

it("lists an obsolete manifestless directory and its size for confirmation", async () => {
  storage(false, [], [{ id: "broken", experiment: null, directory: ".results/old/broken", sizeBytes: 2048 }]);
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  await choose("Clean up obsolete runs…");
  const dialog = await screen.findByRole("dialog", { name: "Clean up obsolete runs…" });
  await within(dialog).findByText(".results/old/broken (2 KiB)");
  await within(dialog).findByText("Runs: 1, total: 2 KiB.");
});

it("reconciles obsolete cleanup after a lost deletion response", async () => {
  const directory = ".results/old/broken";
  let obsolete: RunStorageEntry[] = [{ id: "broken", experiment: null, directory, sizeBytes: 2048 }];
  server((url, init) => {
    if (url === "/api/v1/runs/obsolete") return { body: obsolete };
    if (url.startsWith("/api/v1/runs?directory=") && init?.method === "DELETE") {
      obsolete = [];
      throw new Error("Connection lost");
    }
  });
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  await choose("Clean up obsolete runs…");
  const dialog = await screen.findByRole("dialog", { name: "Clean up obsolete runs…" });
  await within(dialog).findByText("Runs: 1, total: 2 KiB.");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await screen.findAllByText(`The operation stopped. Deleted: ${directory}. Not deleted: none. Connection lost`);
});

it("asks to discard unsaved changes before preparing deletion and preserves them when canceled", async () => {
  const views = storage();
  render(<App />);
  await selectGateway();
  editHandlers("7");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await choose("Delete model…");
  expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to the documents?");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(Object.keys(views)).toHaveLength(3);
  expect(screen.getByLabelText("Handlers")).toHaveProperty("value", "7");
});

it("disables experiment deletion for a default that has never been saved", async () => {
  storage(true);
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  await waitFor(() => expect(button("File").disabled).toBe(false));
  expect(screen.getByRole("button", { name: "Delete experiment…", hidden: true })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Delete model…", hidden: true })).toHaveProperty("disabled", false);
});

it("keeps the unsaved default experiment selected instead of the creation shortcut", async () => {
  storage(true); render(<App />);
  await screen.findByTestId("rf__node-gateway");
  await waitFor(() => expect(button("File").disabled).toBe(false));
  expect(screen.getByRole("combobox", { name: "Experiment" })).toHaveProperty("value", experimentPath);
});

it("blocks experiment creation after the selected model fails to load", async () => {
  server(url => url === `/api/v1/workspace/document?path=${encodeURIComponent(modelPath)}`
    ? { status: 500, body: { code: "LOAD_FAILED", message: "Cannot load model", diagnostics: [] } } : undefined);
  render(<App />);
  await screen.findAllByText("Cannot load model");
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", modelPath);
  const selector = screen.getByRole("combobox", { name: "Experiment" });
  const create = within(selector).getByRole<HTMLOptionElement>("option", { name: "+ New experiment…" });
  expect(create.disabled).toBe(true);
  fireEvent.change(selector, { target: { value: create.value } });
  expect(screen.queryByRole("dialog")).toBeNull();
});
