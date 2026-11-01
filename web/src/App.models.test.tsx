import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";
import { setupAppTests, server, button } from "./test/app";
import { documentViews, experimentPath, modelPath } from "./test/fixtures";
import type { Annotations } from "./workspace/annotations";

setupAppTests();

it("guides a model without a client instead of showing structural errors", async () => {
  const fetchMock = server(url => {
    if (url.includes(encodeURIComponent(modelPath))) return { body: {
      ...documentViews[modelPath], content: { model: { schemaVersion: 7, blocks: {}, connections: [] } },
    } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: false, diagnostics: [
      { code: "TOPOLOGY_CLIENT", severity: "ERROR", message: "No client", document: modelPath, pointer: null, path: null },
    ] } };
  });
  render(<App />);
  await screen.findAllByText("Add a client from the palette");
  expect(button("Run").disabled).toBe(true);
  expect(button("Run").title).toBe("Add a client from the palette");
  expect(screen.queryByText("No client")).toBeNull();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/validate")).toBe(true));
  expect(screen.queryByText("No client")).toBeNull();
});

it("keeps parameter errors visible while a client-less model receives the structural hint", async () => {
  server(url => {
    if (url.includes(encodeURIComponent(modelPath))) return { body: {
      ...documentViews[modelPath], content: { model: { schemaVersion: 7, blocks: { service: { type: "service", params: { handlers: 0 } } }, connections: [] } },
    } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: false, diagnostics: [
      { code: "TOPOLOGY_CLIENT", severity: "ERROR", message: "No client", document: modelPath, pointer: "/blocks", path: null },
      { code: "PARAM_RANGE", severity: "ERROR", message: "At least one handler", document: modelPath, pointer: "/blocks/service/params/handlers", path: "service" },
    ] } };
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0" }));
  await screen.findByRole("button", { name: /At least one handler/ });
  expect(screen.queryByText("No client")).toBeNull();
  expect(button("Run").title).toBe("Add a client from the palette");
});

it("persists a model-only default before submitting a run", async () => {
  const fetchMock = server(url => url === "/api/v1/workspace/documents" ? { body: [
    { path: modelPath, kind: "MODEL", version: "v-model", modelRef: null },
  ] } : undefined);
  render(<App />);
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveProperty("value", modelPath);
  fireEvent.click(button("Run"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(true));
  const calls = fetchMock.mock.calls;
  const save = calls.findIndex(([, init]) => init?.method === "PUT");
  const run = calls.findIndex(([url]) => url === "/api/v1/jobs");
  expect(save).toBeGreaterThanOrEqual(0);
  expect(save).toBeLessThan(run);
  expect(JSON.parse(String(calls[save][1]?.body)).experiment.execution.replications).toBe(10);
});

function annotatedServer(model: Annotations, experiment: Annotations = {}) {
  server(url => {
    if (url.includes(encodeURIComponent(modelPath))) return { body: {
      ...documentViews[modelPath], content: { model: { ...documentViews[modelPath].content.model!, ...model } },
    } };
    if (url.includes(encodeURIComponent(experimentPath))) return { body: {
      ...documentViews[experimentPath], content: { experiment: { ...documentViews[experimentPath].content.experiment!, ...experiment } },
    } };
  });
}

it("opens both descriptions over the model and links to full notes without editing documents", async () => {
  const description = "Why retries overload a slow dependency";
  const notes = "The model uses synthetic measurements.";
  annotatedServer({ description, notes }, { description: "Compare two retry policies." });
  render(<App />);
  const about = await screen.findByRole("button", { name: "About model" });
  expect(screen.queryByRole("dialog", { name: "About model" })).toBeNull();
  expect(about.title).toBe("Model information has not been opened yet");
  fireEvent.click(about);
  const panel = await screen.findByRole("dialog", { name: "About model" });
  expect(about.title).toBe("About model");
  expect(within(panel).getByText(description)).toBeTruthy();
  expect(within(panel).getByText("Compare two retry policies.")).toBeTruthy();
  fireEvent.click(button("Full notes"));
  expect(screen.queryByRole("dialog", { name: "About model" })).toBeNull();
  const fields = await screen.findByRole("group", { name: "Model" });
  expect(fields.closest<HTMLDetailsElement>("details")?.open).toBe(true);
  expect(within(fields).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" }).value).toBe(notes);
  expect(within(fields).getByRole<HTMLTextAreaElement>("textbox", { name: "Notes" })).toBe(document.activeElement);
  expect(button("Save").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
});

it.each(["close", "escape", "outside"])("closes model information with %s and remembers that it has been read", async method => {
  annotatedServer({ description: "A model worth explaining." });
  const view = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "About model" }));
  await screen.findByRole("dialog", { name: "About model" });
  if (method === "close") fireEvent.click(button("Close model information"));
  if (method === "escape") fireEvent.keyDown(document, { key: "Escape" });
  if (method === "outside") fireEvent.pointerDown(await screen.findByTestId("rf__node-gateway"));
  expect(screen.queryByRole("dialog", { name: "About model" })).toBeNull();
  expect(button("About model").getAttribute("aria-expanded")).toBe("false");
  if (method !== "outside") expect(document.activeElement).toBe(button("About model"));
  view.unmount();
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  expect(screen.queryByRole("dialog", { name: "About model" })).toBeNull();
  expect(button("About model").title).toBe("About model");
  fireEvent.click(button("About model"));
  expect(screen.getByRole("dialog", { name: "About model" })).toBeTruthy();
  expect(button("Save").disabled).toBe(true);
  expect(button("Undo").disabled).toBe(true);
});

it.each([
  { model: { notes: "Model notes without a description." }, experiment: {} },
  { model: {}, experiment: { description: "An experiment without a model description." } },
  { model: {}, experiment: { notes: "Experiment notes without a description." } },
])("offers information without auto-opening when only $model or $experiment has text", async ({ model, experiment }) => {
  annotatedServer(model, experiment);
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  expect(screen.queryByRole("dialog", { name: "About model" })).toBeNull();
  fireEvent.click(button("About model"));
  const panel = screen.getByRole("dialog", { name: "About model" });
  expect(within(panel).getByText(model.notes ?? experiment.description ?? experiment.notes!)).toBeTruthy();
});

it("does not consume Escape from a dialog opened over model information", async () => {
  annotatedServer({ description: "Model information behind another dialog." });
  render(<><App /><dialog open><button>Another dialog</button></dialog></>);
  fireEvent.click(await screen.findByRole("button", { name: "About model" }));
  await screen.findByRole("dialog", { name: "About model" });
  fireEvent.keyDown(button("Another dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "About model" })).toBeTruthy();
});

it("omits model information when neither document has descriptions or notes", async () => {
  annotatedServer({ description: "  ", notes: "\n" }, { description: "", notes: null });
  render(<App />);
  await screen.findByTestId("rf__node-gateway");
  expect(screen.queryByRole("button", { name: "About model" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Full notes" })).toBeNull();
});
