import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";
import { setupAppTests, server, button } from "./test/app";
import { documentViews, experimentPath, modelPath } from "./test/fixtures";

setupAppTests();

it("guides a model without a client instead of showing structural errors", async () => {
  const fetchMock = server(url => {
    if (url.includes(encodeURIComponent(modelPath))) return { body: {
      ...documentViews[modelPath], content: { model: { schemaVersion: 5, blocks: {}, connections: [] } },
    } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: false, diagnostics: [
      { code: "TOPOLOGY_CLIENT", severity: "ERROR", message: "No client", document: modelPath, pointer: null, path: null },
    ] } };
  });
  render(<App />);
  await screen.findByText("Add a client from the palette");
  expect(button("Run").disabled).toBe(true);
  expect(button("Run").title).toBe("Add a client from the palette");
  expect(screen.queryByText("No client")).toBeNull();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/validate")).toBe(true));
  expect(screen.queryByText("No client")).toBeNull();
});

it("keeps parameter errors visible while a client-less model receives the structural hint", async () => {
  server(url => {
    if (url.includes(encodeURIComponent(modelPath))) return { body: {
      ...documentViews[modelPath], content: { model: { schemaVersion: 5, blocks: { service: { type: "service", params: { handlers: 0 } } }, connections: [] } },
    } };
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: false, diagnostics: [
      { code: "TOPOLOGY_CLIENT", severity: "ERROR", message: "No client", document: modelPath, pointer: "/blocks", path: null },
      { code: "PARAM_RANGE", severity: "ERROR", message: "At least one handler", document: modelPath, pointer: "/blocks/service/params/handlers", path: "service" },
    ] } };
  });
  render(<App />);
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
