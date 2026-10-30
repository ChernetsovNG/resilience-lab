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
