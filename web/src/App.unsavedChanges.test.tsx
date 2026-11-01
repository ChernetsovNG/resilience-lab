import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import type { DocumentView } from "./api/apiTypes";
import { documentViews, experiment, experimentPath, modelPath } from "./test/fixtures";
import { setupAppTests, server, open, selectGateway, editHandlers, button, otherPath, deferred } from "./test/app";

setupAppTests();

const otherModel = "second/second.model.json";
const otherExperiment = "second/second.experiment.json";

function navigationServer(put?: (init: RequestInit) => Promise<{ body: unknown; status?: number }>) {
  const extra: Record<string, DocumentView> = {
    [otherPath]: { ...documentViews[experimentPath], path: otherPath, version: "second" },
    [otherModel]: { ...documentViews[modelPath], path: otherModel },
    [otherExperiment]: { ...documentViews[experimentPath], path: otherExperiment,
      content: { experiment: { ...experiment, modelRef: "second.model.json", layoutRef: null } } },
  };
  return server(async (url, init) => {
    if (init?.method === "PUT" && put !== undefined) return put(init);
    if (url === "/api/v1/workspace/documents") return { body: [...Object.values(documentViews), ...Object.values(extra)]
      .map(view => ({ ...view, modelRef: view.content.experiment?.modelRef ?? null })) };
    if (url.startsWith("/api/v1/workspace/document?")) {
      const path = new URL(url, "http://test").searchParams.get("path")!;
      if (extra[path] !== undefined) return { body: extra[path] };
    }
  });
}

function unloadPrevented() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

it("protects unsaved edits through save, undo, redo and unmount", async () => {
  server();
  const view = await open();
  expect(unloadPrevented()).toBe(false);
  await selectGateway(); editHandlers("5");
  expect(unloadPrevented()).toBe(true);
  fireEvent.click(button("Save"));
  await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
  expect(unloadPrevented()).toBe(false);
  fireEvent.click(button("Undo"));
  expect(unloadPrevented()).toBe(true);
  fireEvent.click(button("Redo"));
  expect(unloadPrevented()).toBe(false);
  editHandlers("6");
  view.unmount();
  expect(unloadPrevented()).toBe(false);
});

it("protects invalid field drafts without document commands", async () => {
  server();
  await open(); await selectGateway(); editHandlers("oops");
  expect(unloadPrevented()).toBe(true);
  editHandlers("4");
  expect(unloadPrevented()).toBe(false);
});

it.each(["Model", "Experiment"])("saves before switching %s", async (kind) => {
  const fetchMock = navigationServer();
  await open(); await selectGateway(); editHandlers("5");
  const target = kind === "Model" ? otherModel : otherPath;
  fireEvent.change(screen.getByRole("combobox", { name: kind }), { target: { value: target } });
  const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
  expect(within(dialog).getByRole("button", { name: "Don't save" })).toBeTruthy();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save and switch" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: kind })).toHaveProperty("value", target));
  await screen.findByRole("heading", { name: "Run settings" });
  const calls = fetchMock.mock.calls;
  const save = calls.findIndex(([, init]) => init?.method === "PUT");
  const load = save + 1 + calls.slice(save + 1).findIndex(([url]) => String(url).includes(encodeURIComponent(target)));
  expect(save).toBeGreaterThanOrEqual(0);
  expect(load).toBeGreaterThan(save);
  expect(calls[save][1]?.headers).toMatchObject({ "If-Match": '"v-model"' });
  expect(JSON.parse(String(calls[save][1]?.body)).model.blocks.gateway.params.handlers).toBe(5);
  expect(unloadPrevented()).toBe(false);
});

it.each([409, 500])("preserves edits and selection after Save and switch fails with %s", async (status) => {
  const fetchMock = navigationServer(async () => ({ status, body: {
    code: status === 409 ? "VERSION_CONFLICT" : "SAVE_FAILED", message: "Save failed", diagnostics: [],
  } }));
  await open(); await selectGateway(); editHandlers("5");
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: otherModel } });
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save and switch" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", modelPath);
  expect(screen.getByLabelText("Handlers")).toHaveProperty("value", "5");
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes(encodeURIComponent(otherModel)))).toBe(false);
  expect(unloadPrevented()).toBe(true);
});

it("holds the modal and current document while saving for navigation", async () => {
  const gate = deferred();
  navigationServer(async () => {
    await gate.promise;
    return { body: { path: modelPath, kind: "MODEL", version: "saved" } };
  });
  await open(); await selectGateway(); editHandlers("5");
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: otherModel } });
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save and switch" }));
  for (const control of within(dialog).getAllByRole("button")) expect(control).toHaveProperty("disabled", true);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", modelPath);
  await act(async () => { gate.release(); });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", otherModel));
});

it("protects a valid focused field draft before its blur commits a document command", async () => {
  server();
  await open(); await selectGateway();
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "5" } });
  expect(button("Save").disabled).toBe(true);
  expect(unloadPrevented()).toBe(true);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "4" } });
  expect(unloadPrevented()).toBe(false);
});

it.each(["Identifier", "Description", "Notes"])("protects focused %s text before blur", async (label) => {
  server();
  await open(); await selectGateway();
  const field = screen.getByLabelText(label);
  const original = (field as HTMLInputElement).value;
  fireEvent.change(field, { target: { value: label === "Identifier" ? "renamed-gateway" : "Uncommitted text" } });
  expect(unloadPrevented()).toBe(true);
  fireEvent.change(field, { target: { value: original } });
  expect(unloadPrevented()).toBe(false);
});

it.each(["Variant ID", "Variant label"])("protects focused %s before blur", async (label) => {
  server();
  await open();
  // Selecting the variant settings uses the tab context menu's Rename action.
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const field = screen.getByLabelText(label);
  const original = (field as HTMLInputElement).value;
  fireEvent.change(field, { target: { value: "new-variant" } });
  expect(unloadPrevented()).toBe(true);
  fireEvent.change(field, { target: { value: original } });
  expect(unloadPrevented()).toBe(false);
});
