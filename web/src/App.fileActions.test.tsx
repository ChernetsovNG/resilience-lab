import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { button, editHandlers, selectGateway, server, setupAppTests } from "./test/app";
import { documentViews, experimentPath, layoutPath, modelPath } from "./test/fixtures";

setupAppTests();
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

function storage(modelOnly = false) {
  const views = structuredClone(documentViews);
  if (modelOnly) { delete views[experimentPath]; delete views[layoutPath]; }
  server((url, init) => {
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
