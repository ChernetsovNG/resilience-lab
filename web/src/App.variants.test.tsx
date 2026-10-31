import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ExperimentFile } from "./api/apiTypes";
import { catalog, documentViews, experiment, experimentPath } from "./test/fixtures";
import { setupAppTests, server, open, selectGateway, editHandlers, button, experimentSelect, editField } from "./test/app";

setupAppTests();

it("explains variant tabs and counts recorded overrides, including zero and one", async () => {
  server(url => url.includes(encodeURIComponent(experimentPath)) ? { body: {
    ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [
      ...experiment.variants, { id: "one", label: "One change", overrides: { "gateway.handlers": 4 } },
    ] } },
  } } : undefined);
  await open();
  expect(screen.getByText("Variants")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Model" }).title).toBe("Edit the model structure here");
  expect(screen.getByRole("tab", { name: "Baseline" }).title).toBe("Baseline: model with 0 overridden parameters");
  expect(screen.getByRole("tab", { name: "One change" }).title).toBe("One change: model with 1 overridden parameter");
  expect(screen.getByRole("tab", { name: "No retries" }).title).toBe("No retries: model with 2 overridden parameters");
});

it("opens the same changes list on the canvas and in variant properties and focuses its selected field", async () => {
  server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  const banner = screen.getByTestId("variant-banner");
  expect(banner.textContent).toContain("No retries · Structure is read-only · 2 changes");
  fireEvent.click(banner.querySelector("summary")!);
  const row = within(banner).getByRole("button", { name: "gateway-to-middle · Attempts: 3 → 1" });
  expect(within(banner).getByRole("button", { name: "middle-to-dependency · Attempts: 3 → 1" })).toBeTruthy();
  fireEvent.click(button("Collapse inspector"));
  fireEvent.click(row);
  expect(screen.getByRole("heading", { name: "gateway-to-middle" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("Attempts"));
  expect(screen.getByTestId("canvas-edge-label-gateway-to-middle").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  expect(within(inspector).getByRole("button", { name: "gateway-to-middle · Attempts: 3 → 1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(screen.getByTestId("variant-banner").textContent).toContain("Same as model");
  expect(screen.queryByRole("button", { name: "gateway-to-middle · Attempts: 3 → 1" })).toBeNull();
});

it("describes service and nested overrides with catalog titles and values", async () => {
  server(url => url.includes(encodeURIComponent(experimentPath)) ? { body: {
    ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id: "custom", label: "Custom", overrides: {
      "gateway.handlers": 1234, "gateway.processing.mean": "9ms", "gateway-to-middle.network.mean": "7ms",
    } }] } },
  } } : undefined);
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
  const banner = screen.getByTestId("variant-banner");
  fireEvent.click(banner.querySelector("summary")!);
  expect(within(banner).getByRole("button", { name: "gateway · Handlers: 4 → 1,234" })).toBeTruthy();
  fireEvent.click(within(banner).getByRole("button", { name: "gateway · Processing time · Mean: 1ms → 9ms" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Mean"));
  expect(within(banner).getByRole("button", { name: "gateway-to-middle · Network delay · Mean: 0.5ms → 7ms" })).toBeTruthy();
});

it("focuses the first point field when a load-profile array override is selected", async () => {
  server(url => url.includes(encodeURIComponent(experimentPath)) ? { body: {
    ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id: "profile", overrides: {
      "client.load.points": [{ time: "0ms", rate: "20/s" }],
    } }] } },
  } } : undefined);
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "Variant 1" }));
  const banner = screen.getByTestId("variant-banner");
  fireEvent.click(banner.querySelector("summary")!);
  fireEvent.click(within(banner).getByRole("button"));
  const field = screen.getByRole("complementary", { name: "Inspector" }).querySelector('[data-inspector-field="load.points.0.time"] input');
  expect(field).not.toBeNull();
  expect(document.activeElement).toBe(field);
});

it("explains blocked node, handle and palette gestures and links to Model without modifying documents", async () => {
  server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  const node = screen.getByTestId("rf__node-gateway");
  const position = node.style.transform;
  fireEvent.mouseDown(node, { clientX: 50, clientY: 50 });
  fireEvent.mouseMove(node, { clientX: 90, clientY: 70 });
  fireEvent.mouseUp(node);
  expect(screen.getByRole("alert").textContent).toContain("Structure is edited on the Model page");
  expect(node.style.transform).toBe(position);
  expect(button("Save").disabled).toBe(true);
  fireEvent.click(screen.getByRole("link", { name: "Model" }));
  expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  fireEvent.mouseDown(node.querySelector(".react-flow__handle")!, { clientX: 50, clientY: 50 });
  fireEvent.mouseMove(node, { clientX: 90, clientY: 70 });
  fireEvent.mouseUp(node);
  expect(screen.getByRole("alert").textContent).toContain("Structure is edited on the Model page");
  fireEvent.click(button("Service"));
  expect(screen.getByTestId("variant-banner")).toBeTruthy();
  expect(button("Save").disabled).toBe(true);
  expect(screen.getAllByTestId("block-node")).toHaveLength(4);
});


it("saves precise variant overrides only to the experiment and resets fields and objects with undo", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  fireEvent.click(await screen.findByTestId("rf__edge-gateway-to-middle"));
  editField("Attempts", "2");
  editField("Timeout", "90ms");
  editField("Base delay", "4ms");
  expect((await screen.findByTestId("canvas-edge-label-gateway-to-middle")).textContent).toContain("◆");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(String(puts[0][0])).toContain(encodeURIComponent(experimentPath));
  expect(puts[0][1]?.headers).toMatchObject({ "If-Match": '"v-experiment"' });
  expect(JSON.parse(String(puts[0][1]?.body)).experiment.variants[1].overrides).toEqual({
    "gateway-to-middle.attempts": 2, "middle-to-dependency.attempts": 1,
    "gateway-to-middle.timeout": "90ms", "gateway-to-middle.backoff.base": "4ms",
  });
  fireEvent.click(button("Reset Timeout"));
  expect((screen.getByLabelText("Timeout") as HTMLInputElement).value).toBe("80ms");
  fireEvent.click(button("Reset Backoff"));
  expect((screen.getByLabelText("Base delay") as HTMLInputElement).value).toBe("2ms");
  fireEvent.click(button("Undo"));
  expect((screen.getByLabelText("Base delay") as HTMLInputElement).value).toBe("4ms");
});

it("edits canvas timeout with undo and saves variant edits only as overrides", async () => {
  const fetchMock = server();
  await open();
  const editTimeout = async (value: string) => {
    const parameter = await screen.findByTestId("canvas-param-gateway-to-middle-timeout");
    fireEvent.doubleClick(parameter);
    const input = parameter.querySelector("input")!;
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest("form")!);
  };

  await editTimeout("90ms");
  expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("90ms");
  fireEvent.click(button("Undo"));
  expect(screen.getByTestId("canvas-param-gateway-to-middle-timeout").textContent).toBe("80ms");

  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  await editTimeout("100ms");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));

  const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(String(puts[0][0])).toContain(encodeURIComponent(experimentPath));
  expect(JSON.parse(String(puts[0][1]?.body)).experiment.variants[1].overrides).toEqual({
    "gateway-to-middle.attempts": 1, "middle-to-dependency.attempts": 1,
    "gateway-to-middle.timeout": "100ms",
  });
});

it("adds, copies, renames and confirms deletion of a variant while keeping its page active", async () => {
  server();
  const nativeConfirm = vi.spyOn(window, "confirm");
  await open();
  fireEvent.click(button("Add variant"));
  expect(screen.getByRole("tab", { name: "Variant 1" }).getAttribute("aria-selected")).toBe("true");
  editField("Variant label", "My variant");
  editField("Variant ID", "my-variant");
  expect(screen.getByRole("tab", { name: "My variant" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("tab", { name: "My variant" }).getAttribute("aria-selected")).toBe("true");
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("variant-1");
  fireEvent.click(button("Redo"));
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("my-variant");
  editField("Variant ID", "baseline");
  expect(screen.getByText("This variant ID is already used")).toBeTruthy();
  expect(button("Save").disabled).toBe(true);
  expect(button("Add variant").disabled).toBe(true);
  editField("Variant ID", "my-variant");
  fireEvent.contextMenu(screen.getByRole("tab", { name: "My variant" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
  expect(screen.getByRole("tab", { name: "My variant copy" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.contextMenu(screen.getByRole("tab", { name: "My variant copy" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog", { name: /My variant copy/ });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("tab", { name: "My variant copy" })).toBeTruthy();
  fireEvent.contextMenu(screen.getByRole("tab", { name: "My variant copy" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "My variant copy" })).toBeNull());
  expect(nativeConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("tab", { name: "My variant copy" })).toBeTruthy();
});

it("ignores the second activation of a double click on Add variant", async () => {
  server();
  await open();
  fireEvent.click(button("Add variant"), { detail: 1 });
  fireEvent.click(button("Add variant"), { detail: 2 });
  expect(screen.getByRole("tab", { name: "Variant 1" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tab", { name: "Variant 2" })).toBeNull();
});

it("edits shared execution and fault settings from a variant and preserves invalid drafts", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  editField("Replications", "3");
  editField("Warm-up", "100ms");
  editField("Measurement", "2s");
  editField("Seed", "9007199254740991");
  editField("Real-time limit", "10s");
  fireEvent.change(screen.getByLabelText("Fault target"), { target: { value: "middle" } });
  editField("Fault start", "100ms");
  editField("Fault end", "500ms");
  editField("Processing time multiplier", "4");
  editField("Additional processing time", "50ms");
  editField("Seed", "9007199254740992");
  expect(button("Save").disabled).toBe(true);
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(true);
  editField("Seed", "9007199254740991");
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect((screen.getByLabelText("Replications") as HTMLInputElement).value).toBe("3");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.execution).toEqual({ replications: 3, warmup: "100ms", measurement: "2s", seed: 9007199254740991, maxRealTime: "10s" });
  expect(saved.faults).toEqual([{ target: "middle", from: "100ms", to: "500ms", kind: "slowdown", multiplier: 4, delay: "50ms" }]);
  expect(saved.variants).toEqual(experiment.variants);
  fireEvent.click(button("Add fault"));
  expect(screen.getAllByLabelText("Fault target")).toHaveLength(2);
  fireEvent.click(button("Remove fault 2"));
  expect(screen.getAllByLabelText("Fault target")).toHaveLength(1);
  fireEvent.click(button("Undo"));
  expect(screen.getAllByLabelText("Fault target")).toHaveLength(2);
});

it("reads duration and probability units for shared fields from the catalog", async () => {
  const customCatalog = structuredClone(catalog);
  const changeUnits = (params: typeof customCatalog.types[number]["params"]) => {
    for (const param of params) {
      if (param.dimension === "DURATION") param.units = [{ symbol: "tick", numerator: 2, denominator: 1 }];
      if (param.dimension === "PROBABILITY") param.units = [{ symbol: "permille", numerator: 1, denominator: 1000 }];
      changeUnits(param.fields);
    }
  };
  customCatalog.types.forEach((type) => changeUnits(type.params));
  const fetchMock = server((url) => url === "/api/v1/catalog" ? { body: customCatalog }
    : url.includes(encodeURIComponent(experimentPath)) ? { body: { ...documentViews[experimentPath], content: { experiment: {
      ...experiment, faults: [{ target: "dependency", from: "200ms", to: "700ms", kind: "errors", failureRate: "5%" }],
    } } } } : undefined);
  await open();
  editField("Measurement", "20tick");
  editField("Fault failure rate", "250permille");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.execution.measurement).toBe("20tick");
  expect(saved.faults[0].failureRate).toBe("250permille");
});

it("shows every fault kind and saves its untouched parameters after an execution edit", async () => {
  const faults: ExperimentFile["faults"] = [
    { target: "middle", from: "100ms", to: "500ms", kind: "slowdown", multiplier: 3, delay: "200ms", failureRate: null, capacity: null },
    { target: "gateway-to-middle", from: "200ms", to: "600ms", kind: "errors", failureRate: "25%", multiplier: null, delay: null, capacity: null },
    { target: "dependency", from: "300ms", to: "700ms", kind: "unavailable", multiplier: null, delay: null, failureRate: null, capacity: null },
    { target: "middle-to-dependency", from: "400ms", to: "800ms", kind: "blackhole", multiplier: null, delay: null, failureRate: null, capacity: null },
    { target: "gateway", from: "500ms", to: "900ms", kind: "capacityLoss", capacity: 0, multiplier: null, delay: null, failureRate: null },
  ];
  const fetchMock = server(url => url.includes(encodeURIComponent(experimentPath)) ? {
    body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, schemaVersion: 2, faults } } },
  } : undefined);
  await open();
  expect(screen.getAllByLabelText("Fault kind").map(field => (field as HTMLSelectElement).selectedOptions[0].textContent))
    .toEqual(["Slowdown", "Errors", "Fast unavailability", "Black hole", "Capacity loss"]);
  expect((screen.getByLabelText("Processing time multiplier") as HTMLInputElement).value).toBe("3");
  expect((screen.getByLabelText("Additional processing time") as HTMLInputElement).value).toBe("200ms");
  expect((screen.getByLabelText("Fault failure rate") as HTMLInputElement).value).toBe("25%");
  expect((screen.getByLabelText("Available handlers") as HTMLInputElement).value).toBe("0");
  editField("Seed", "42");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.schemaVersion).toBe(2);
  expect(saved.faults).toEqual(faults);
});

it("keeps navigation blocked while either the canvas or Inspector draft is invalid", async () => {
  server();
  await open();
  await selectGateway();
  const parameter = await screen.findByTestId("canvas-param-gateway-handlers");
  fireEvent.doubleClick(parameter);
  const canvasInput = parameter.querySelector("input")!;
  fireEvent.change(canvasInput, { target: { value: "invalid" } });
  const inspectorInput = within(screen.getByRole("complementary", { name: "Inspector" })).getByLabelText("Handlers");
  fireEvent.change(inspectorInput, { target: { value: "invalid" } });
  expect(screen.getByText(/Fix invalid values before changing/)).toBeTruthy();

  fireEvent.keyDown(canvasInput, { key: "Escape" });
  expect(screen.getByText(/Fix invalid values before changing/)).toBeTruthy();
  expect((screen.getByRole("tab", { name: "Baseline" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(inspectorInput, { target: { value: "4" } });
  expect(screen.queryByText(/Fix invalid values before changing/)).toBeNull();
  expect((screen.getByRole("tab", { name: "Baseline" }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(["Handlers", "Seed"])("blocks target switches and variant menus while %s is unparseable", async (field) => {
  server();
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  if (field === "Handlers") await selectGateway();
  editField(field, "invalid");
  expect(button("Run settings").disabled).toBe(true);
  expect(button("Add variant").disabled).toBe(true);
  const tab = screen.getByRole("tab", { name: "No retries" });
  fireEvent.contextMenu(tab);
  fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(document.querySelector(".react-flow__pane")!);
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe("invalid");
  expect(button("Save").disabled).toBe(true);
  editField(field, field === "Handlers" ? "5" : "42");
  fireEvent.contextMenu(tab);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Variant label"));
});

it("keeps variant identity when undo restores a different deleted variant before it", async () => {
  const third = { id: "third", label: "Third", overrides: {} };
  const fetchMock = server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
    body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [...experiment.variants, third] } } },
  } : undefined);
  await open();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  fireEvent.contextMenu(screen.getByRole("tab", { name: "No retries" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: "No retries" })).toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Third" }));
  fireEvent.click(button("Undo"));
  expect(screen.getByRole("tab", { name: "Third" }).getAttribute("aria-selected")).toBe("true");
  await selectGateway();
  editHandlers("7");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  const saved = JSON.parse(String(put[1]?.body)).experiment;
  expect(saved.variants[1]).toEqual(experiment.variants[1]);
  expect(saved.variants[2].overrides).toEqual({ "gateway.handlers": 7 });
});

it("keeps navigation available until invalid stored variant data is edited", async () => {
  server((url) => url.includes(encodeURIComponent(experimentPath)) ? {
    body: { ...documentViews[experimentPath], content: { experiment: { ...experiment, variants: [{ id: "invalid", label: "Invalid variant", overrides: { "gateway.handlers": 0 } }] } } },
  } : undefined);
  await open(); await selectGateway();
  fireEvent.click(screen.getByRole("tab", { name: "Invalid variant" }));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("0");
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).readOnly).toBe(false);
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(false);
  expect(experimentSelect().disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "oops" } });
  expect((screen.getByRole("tab", { name: "Model" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("tab", { name: "Model" }));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
});

it.each(["ContextMenu", "F10"])("opens a tab menu with %s, supports focus navigation and restores the tab on Escape", async (key) => {
  server(); await open();
  const tab = screen.getByRole("tab", { name: "No retries" });
  tab.focus(); fireEvent.keyDown(tab, { key, shiftKey: key === "F10" });
  const duplicate = screen.getByRole("menuitem", { name: "Duplicate" });
  expect(document.activeElement).toBe(duplicate);
  fireEvent.keyDown(duplicate, { key: "ArrowDown" });
  const rename = screen.getByRole("menuitem", { name: "Rename" });
  expect(document.activeElement).toBe(rename);
  fireEvent.click(rename);
  expect(document.activeElement).toBe(screen.getByLabelText("Variant label"));
  expect((screen.getByLabelText("Variant ID") as HTMLInputElement).value).toBe("no-retries");
  tab.focus(); fireEvent.keyDown(tab, { key, shiftKey: key === "F10" });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(tab);
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Model" }));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("explains why the last variant cannot be deleted", async () => {
  server(url => url.includes(encodeURIComponent(experimentPath)) ? { body: { ...documentViews[experimentPath],
    content: { experiment: { ...experiment, variants: [experiment.variants[0]] } } } } : undefined);
  await open(); fireEvent.contextMenu(screen.getByRole("tab", { name: "Baseline" }));
  const deletion = screen.getByRole<HTMLButtonElement>("menuitem", { name: "Delete" });
  expect(deletion.disabled).toBe(true);
  expect(document.getElementById(deletion.getAttribute("aria-describedby")!)?.textContent).toContain("last variant");
});

it("keeps menu keystrokes from deleting the selected diagram element", async () => {
  server(); await open(); await selectGateway();
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Delete" });
  expect(screen.getByTestId("rf__node-gateway")).toBeTruthy();
  expect(button("Undo").disabled).toBe(true);
});
