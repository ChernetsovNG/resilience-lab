import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { manifest, modelPath, summary } from "./test/fixtures";
import { button, completed, deferred, editHandlers, open, selectGateway, server, setupAppTests } from "./test/app";

setupAppTests();

it("commits a focused field before the Run button saves and submits", async () => {
  const fetchMock = server();
  await open(); await selectGateway();
  const field = screen.getByLabelText("Handlers");
  field.focus();
  fireEvent.change(field, { target: { value: "9" } });
  fireEvent.click(button("Run"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/jobs" && init?.method === "POST")).toBe(true));
  const calls = fetchMock.mock.calls;
  const save = calls.findIndex(([url, init]) => init?.method === "PUT" && String(url).includes(encodeURIComponent(modelPath)));
  const submit = calls.findIndex(([url, init]) => url === "/api/v1/jobs" && init?.method === "POST");
  expect(save).toBeGreaterThanOrEqual(0);
  expect(save).toBeLessThan(submit);
  expect(JSON.parse(String(calls[save][1]?.body)).model.blocks.gateway.params.handlers).toBe(9);
});

it("saves dirty documents before submitting a run", async () => {
  const saving = deferred();
  const fetchMock = server(async (_url, init) => {
    if (init?.method === "PUT") await saving.promise;
    return undefined;
  });
  await open(); await selectGateway(); editHandlers("5");
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(button("Run"));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
  await act(async () => saving.release());
  await screen.findByRole("table", { name: "Findings" });
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(JSON.parse(String(writes[0][1]?.body)).model.blocks.gateway.params.handlers).toBe(5);
  expect(button("Save").disabled).toBe(true);
});

it.each([409, 400, 500])("does not submit after a save fails with HTTP %s and explains it next to Run", async status => {
  const fetchMock = server((_url, init) => init?.method === "PUT" ? {
    status, body: { code: status === 409 ? "VERSION_CONFLICT" : "SAVE_FAILED", message: "Cannot save this document", diagnostics: [] },
  } : undefined);
  await open(); await selectGateway(); editHandlers("5");
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(button("Run"));
  const header = within(screen.getByRole("banner"));
  await header.findByText(status === 409 ? "Reload conflicting documents before running" : "Cannot save this document");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
});

for (const modifier of ["ctrlKey", "metaKey"] as const) {
  it.each(["s", "Enter"])(`${modifier}+%s commits a focused field and saves its current value`, async key => {
    const fetchMock = server();
    await open(); await selectGateway();
    const field = screen.getByLabelText("Handlers");
    field.focus();
    fireEvent.change(field, { target: { value: "7" } });
    fireEvent.keyDown(field, { key, [modifier]: true });
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    const write = fetchMock.mock.calls.find(([url, init]) => init?.method === "PUT" && String(url).includes(encodeURIComponent(modelPath)))!;
    expect(JSON.parse(String(write[1]?.body)).model.blocks.gateway.params.handlers).toBe(7);
    if (key === "Enter") {
      await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/v1/jobs" && init?.method === "POST")).toBe(true));
      const submit = fetchMock.mock.calls.findIndex(([url, init]) => url === "/api/v1/jobs" && init?.method === "POST");
      expect(fetchMock.mock.calls.indexOf(write)).toBeLessThan(submit);
    } else expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/jobs")).toBe(false);
  });
}

it.each(["textarea", "contenteditable"])("ignores command shortcuts inside %s", async kind => {
  const fetchMock = server();
  const view = await open(); await selectGateway(); editHandlers("5");
  const field = document.createElement(kind === "textarea" ? "textarea" : "div");
  if (kind === "contenteditable") field.setAttribute("contenteditable", "true");
  view.container.append(field);
  for (const key of ["s", "Enter"]) {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(field, event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(fetchMock.mock.calls.some(([url, init]) => init?.method === "PUT" || url === "/api/v1/jobs")).toBe(false);
});

it("blocks an invalid draft shortcut with a visible explanation beside Run", async () => {
  const fetchMock = server();
  await open(); await selectGateway();
  const field = screen.getByLabelText("Handlers");
  fireEvent.change(field, { target: { value: "invalid" } });
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  expect(within(screen.getByRole("banner")).getByText("Fix invalid values first")).toBeTruthy();
  expect(fetchMock.mock.calls.some(([url, init]) => init?.method === "PUT" || url === "/api/v1/jobs")).toBe(false);
});

it("preserves the first Findings during submission and loading of replacement artifacts", async () => {
  const submission = deferred(), artifacts = deferred();
  let submissions = 0;
  const replacement = structuredClone(summary);
  replacement.variants[0].label = "Updated baseline";
  const fetchMock = server(async url => {
    if (url === "/api/v1/jobs" && ++submissions === 2) {
      await submission.promise;
      return { status: 202, body: { ...completed, id: "job-2", runId: "run-2" } };
    }
    if (url === "/api/v1/runs/run-2/summary" || url === "/api/v1/runs/run-2/manifest") {
      await artifacts.promise;
      return { body: url.endsWith("/summary") ? replacement : manifest };
    }
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(button("Run"));
  await waitFor(() => expect(submissions).toBe(2));
  expect(screen.getByRole("table", { name: "Findings" }).textContent).toContain("Baseline");
  expect(screen.getByRole("tabpanel").textContent).toContain("Results are outdated; a new run is in progress.");
  await act(async () => submission.release());
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/runs/run-2/summary")).toBe(true));
  expect(screen.getByRole("table", { name: "Findings" }).textContent).toContain("Baseline");
  await act(async () => artifacts.release());
  await waitFor(() => expect(screen.getByRole("table", { name: "Findings" }).textContent).toContain("Updated baseline"));
  expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED");
  expect(screen.getByRole("tabpanel").textContent).not.toContain("a new run is in progress");
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/jobs")).toHaveLength(2);
});

it.each(["FAILED", "CANCELLED"] as const)("retains the last Findings when its replacement is %s", async status => {
  let submissions = 0;
  server(url => {
    if (url === "/api/v1/jobs" && ++submissions === 2) return { status: 202, body: {
      ...completed, id: "job-2", runId: "run-2", status, error: status === "FAILED" ? "Replacement failed" : null,
    } };
    if (url === "/api/v1/runs/run-2/manifest") return { body: { ...manifest, complete: false } };
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(button("Run"));
  await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe(status));
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  fireEvent.click(screen.getByRole("tab", { name: "Findings" }));
  expect(screen.getByRole("table", { name: "Findings" }).textContent).toContain("Baseline");
});
