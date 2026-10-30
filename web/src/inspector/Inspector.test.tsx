import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog, experiment, layout, model } from "../test/fixtures";
import { applyOverrides, withParam } from "../workspace/params";
import type { EditorDocuments } from "../workspace/editor";
import { Inspector } from "./Inspector";
import type { InspectorProps } from "./Inspector";

function renderInspector(props: Partial<InspectorProps> = {}) {
  const onParam = vi.fn();
  render(
    <Inspector
      catalog={catalog}
      model={model}
      experiment={experiment}
      selected="gateway"
      editable
      overrides={{}}
      onParam={onParam}
      onValidity={vi.fn()}
      {...props}
    />,
  );
  return onParam;
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

function commit(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
  fireEvent.blur(input(label));
}

describe("Inspector", () => {
  it.each(["Run settings", "Parameter grid", "Faults"])("remembers %s independently across remounts", async title => {
    const props: InspectorProps = { catalog, model, experiment, selected: null, editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn() };
    const view = render(<Inspector {...props} />);
    const section = screen.getByText(title).closest("details");
    expect(section).not.toBeNull();
    fireEvent.click(screen.getByText(title));
    await waitFor(() => expect(section!.open).toBe(false));
    // Opening another group must not overwrite this group's preference.
    const other = screen.getByText(title === "Faults" ? "Run settings" : "Faults").closest("summary")!;
    fireEvent.click(other);
    await waitFor(() => expect(other.closest("details")!.open).toBe(false));
    view.unmount();
    render(<Inspector {...props} />);
    expect(screen.getByText(title).closest("details")!.open).toBe(false);
    expect(screen.getByText(title === "Faults" ? "Parameter grid" : "Run settings").closest("details")!.open)
      .toBe(title === "Run settings" ? false : true);
  });

  it("restores collapsed model parameters and reveals a requested field", async () => {
    localStorage.setItem("resilience-lab.inspector-parameters-open", "false");
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway", editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn() };
    const view = render(<Inspector {...props} />);
    expect(screen.getByText("Parameters").closest("details")!.open).toBe(false);
    view.rerender(<Inspector {...props} focusField={{ path: "handlers", request: 1 }} />);
    await waitFor(() => expect(document.activeElement).toBe(input("Handlers")));
    expect(screen.getByText("Parameters").closest("details")!.open).toBe(true);
  });

  it.each([
    ["execution", "Run settings", "execution.seed", "Seed"],
    ["faults", "Faults", "faults.0.processingMultiplier", "Processing multiplier"],
    ["grid", "Parameter grid", "grid.0.path", "Axis 1 parameter"],
  ])("opens collapsed %s when Problems requests its field", async (section, title, path, label) => {
    localStorage.setItem(`resilience-lab.inspector-${section}-open`, "false");
    const props: InspectorProps = { catalog, model, experiment: { ...experiment, grid: [{ path: "gateway.handlers", values: [4] }] },
      selected: null, editable: true, overrides: {}, onParam: vi.fn(), onValidity: vi.fn(), onCommand: vi.fn() };
    const view = render(<Inspector {...props} />);
    expect(screen.getByText(title).closest("details")?.open).toBe(false);
    view.rerender(<Inspector {...props} focusField={{ path, request: 1 }} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(label)));
    expect(screen.getByText(title).closest("details")!.open).toBe(true);
  });

  it("reveals run settings for diagnostics on the execution group", async () => {
    localStorage.setItem("resilience-lab.inspector-execution-open", "false");
    renderInspector({ selected: null, focusField: { path: "execution", request: 1 } });
    await waitFor(() => expect(screen.getByText("Run settings").closest("details")!.open).toBe(true));
    expect(document.activeElement).toBe(input("Replications"));
  });

  it("puts available variant results before collapsed parameters", () => {
    renderInspector({ variantId: "baseline", resultsFirst: true, results: <section aria-label="Element results">Metrics</section> });
    const parameters = screen.getByText("Parameters").closest("details")!;
    const results = screen.getByRole("region", { name: "Element results" });
    expect(parameters.open).toBe(false);
    expect(results.compareDocumentPosition(parameters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    { variantId: null, resultsFirst: true, results: <section aria-label="Element results">Metrics</section> },
    { variantId: "baseline", resultsFirst: false, results: null },
    { variantId: "baseline", resultsFirst: false, results: <section aria-label="Element results">Unavailable</section> },
  ])("keeps parameters open when results are not available on this page: %j", props => {
    renderInspector(props);
    expect(screen.getByRole("textbox", { name: "Handlers" })).toBeTruthy();
    const results = screen.queryByRole("region", { name: "Element results" });
    if (props.variantId === null) expect(results).toBeNull();
    else if (results !== null) expect(input("Handlers").compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("remembers parameter disclosure across selection and remounts", async () => {
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway", variantId: "baseline", editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn(), resultsFirst: true, results: <p>Metrics</p> };
    const view = render(<Inspector {...props} />);
    const parameters = screen.getByText("Parameters").closest("details")!;
    fireEvent.click(screen.getByText("Parameters"));
    await waitFor(() => expect(parameters.open).toBe(true));
    view.rerender(<Inspector {...props} selected="middle" />);
    expect(screen.getByRole("textbox", { name: "Handlers" })).toBeTruthy();
    view.unmount();
    const next = render(<Inspector {...props} />);
    expect(screen.getByText("Parameters").closest("details")!.open).toBe(true);
    fireEvent.click(screen.getByText("Parameters"));
    await waitFor(() => expect(screen.getByText("Parameters").closest("details")!.open).toBe(false));
    next.unmount();
    render(<Inspector {...props} />);
    expect(screen.getByText("Parameters").closest("details")!.open).toBe(false);
  });

  it("reveals and focuses a requested nested parameter", async () => {
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway-to-middle", variantId: "baseline", editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn(), resultsFirst: true, results: <p>Metrics</p> };
    const view = render(<Inspector {...props} />);
    expect(screen.getByText("Parameters").closest("details")!.open).toBe(false);
    view.rerender(<Inspector {...props} focusField={{ path: "backoff.base", request: 1 }} />);
    await waitFor(() => expect(screen.getByText("Parameters").closest("details")!.open).toBe(true));
    expect(document.activeElement).toBe(input("Base delay"));
  });

  it("renders results once in Analysis while keeping parameter drafts mounted", () => {
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway", variantId: "baseline", editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn(), resultsFirst: true, results: <section aria-label="Element results">Metrics</section> };
    const view = render(<Inspector {...props} />);
    fireEvent.change(input("Handlers"), { target: { value: "invalid" } });
    view.rerender(<Inspector {...props} resultsOnly />);
    expect(screen.getAllByRole("region", { name: "Element results", hidden: true })).toHaveLength(1);
    view.rerender(<Inspector {...props} />);
    expect(input("Handlers").value).toBe("invalid");
  });

  it("focuses a field after resetting an overridden object to the model value", async () => {
    function Editor() {
      const [documents, setDocuments] = useState<EditorDocuments>({ model, layout, experiment: {
        ...experiment, variants: [{ ...experiment.variants[0], overrides: {
          "gateway-to-middle.backoff": { kind: "fixed", delay: "4ms" },
        } }],
      } });
      const variant = documents.experiment.variants[0];
      return <Inspector catalog={catalog} model={applyOverrides(documents.model, variant.overrides, catalog)}
        experiment={documents.experiment} selected="gateway-to-middle" editable variantId={variant.id}
        overrides={variant.overrides} onParam={vi.fn()} onValidity={vi.fn()} onCommand={command => setDocuments(command)} />;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Reset Backoff" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Kind")));
    expect(input("Base delay").value).toBe("2ms");
  });

  it("keeps disclosure across remounts when browser storage cannot be written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage denied"); });
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway", variantId: "baseline", editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn(), resultsFirst: true, results: <p>Metrics</p> };
    const view = render(<Inspector {...props} />);
    fireEvent.click(screen.getByText("Parameters"));
    fireEvent(screen.getByText("Parameters").closest("details")!, new Event("toggle"));
    view.unmount();
    render(<Inspector {...props} variantId="no-retries" />);
    expect(screen.getByText("Parameters").closest("details")!.open).toBe(true);
    fireEvent.click(screen.getByText("Parameters"));
    fireEvent(screen.getByText("Parameters").closest("details")!, new Event("toggle"));
  });

  it("renders catalog fields with values and defaults and commits edits", () => {
    const onParam = renderInspector();

    expect(input("Handlers").value).toBe("4");
    expect(input("Failure rate").placeholder).toBe("0%");
    commit("Handlers", "6");

    expect(onParam).toHaveBeenCalledWith("gateway", "handlers", 6);
  });

  it("rejects invalid values and removes cleared optional ones", () => {
    const onParam = renderInspector();

    commit("Failure rate", "5 percent");
    expect(screen.getByRole("alert").textContent).toContain("%");
    commit("Handlers", "4.5");
    expect(onParam).not.toHaveBeenCalled();

    commit("Queue capacity", "");
    expect(onParam).toHaveBeenCalledWith("gateway", "queue", undefined);
  });

  it("shows catalog range errors but commits parseable values for core validation", () => {
    const onParam = renderInspector();

    commit("Handlers", "0");
    expect(screen.getByRole("alert").textContent).toContain(">= 1");
    commit("Failure rate", "150%");
    expect(onParam).toHaveBeenCalledWith("gateway", "handlers", 0);
    expect(onParam).toHaveBeenCalledWith("gateway", "failureRate", "150%");

    commit("Handlers", "1");
    commit("Failure rate", "100%");
    expect(onParam).toHaveBeenCalledWith("gateway", "handlers", 1);
    expect(onParam).toHaveBeenCalledWith("gateway", "failureRate", "100%");
  });

  it("reports invalid drafts so that saving and running can wait for them", () => {
    const onValidity = vi.fn();
    renderInspector({ onValidity });

    fireEvent.change(input("Handlers"), { target: { value: "4.5" } });
    expect(onValidity).toHaveBeenLastCalledWith("gateway.handlers", false);

    fireEvent.change(input("Handlers"), { target: { value: "5" } });
    expect(onValidity).toHaveBeenLastCalledWith("gateway.handlers", true);
  });

  it("edits a field of an object parameter as a whole object", () => {
    const onParam = renderInspector({ selected: "gateway-to-middle" });

    expect(input("Base delay").value).toBe("2ms");
    commit("Base delay", "4ms");

    expect(onParam).toHaveBeenCalledWith("gateway-to-middle", "backoff", {
      kind: "exponential-full-jitter",
      base: "4ms",
      max: "20ms",
      multiplier: 2,
    });
  });

  it("shows a variant page read-only with overridden values marked", () => {
    const overrides = { "gateway-to-middle.attempts": 1 };
    renderInspector({
      selected: "gateway-to-middle",
      editable: false,
      overrides,
      model: applyOverrides(model, overrides, catalog),
    });

    expect(input("Attempts").value).toBe("1");
    expect(input("Attempts").readOnly).toBe(true);
    expect(input("Attempts").closest(".param-field")?.textContent).toContain("overridden");
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).disabled).toBe(true);
  });

  it("shows run settings and faults without a selection", () => {
    renderInspector({ selected: null });

    expect(input("Replications").value).toBe("2");
    expect((screen.getByLabelText("Fault target") as HTMLSelectElement).value).toBe("dependency");
    expect(input("Fault start").value).toBe("200ms");
    expect(input("Fault end").value).toBe("700ms");
    expect(input("Processing multiplier").value).toBe("6");
  });

  it("keeps the series window unset and updates its default hint from measurement", () => {
    const onCommand = vi.fn();
    const props: InspectorProps = { catalog, model, experiment, selected: null, editable: true,
      overrides: {}, onParam: vi.fn(), onValidity: vi.fn(), onCommand };
    const view = render(<Inspector {...props} />);
    expect(input("Series window").value).toBe("");
    expect(input("Series window").placeholder).toBe("10ms");
    view.rerender(<Inspector {...props} experiment={{ ...experiment, execution: { ...experiment.execution, measurement: "2min" } }} />);
    expect(input("Series window").value).toBe("");
    expect(input("Series window").placeholder).toBe("1200ms");
    view.rerender(<Inspector {...props} experiment={{ ...experiment, execution: { ...experiment.execution, measurement: "invalid" } }} />);
    expect(input("Series window").placeholder).toBe("");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("uses catalog duration units for the series window and its default hint", () => {
    const customCatalog = structuredClone(catalog);
    customCatalog.types[0].params.find((param) => param.name === "deadline")!.units = [
      { symbol: "tick", numerator: 2, denominator: 1 }, { symbol: "s", numerator: 1000, denominator: 1 },
    ];
    let documents: EditorDocuments = { model, experiment, layout };
    renderInspector({ selected: null, catalog: customCatalog,
      onCommand: (command) => { documents = command(documents); } });
    expect(input("Series window").placeholder).toBe("5tick");
    commit("Series window", "25tick");
    expect(documents.experiment.execution.window).toBe("25tick");
    commit("Series window", "25ms");
    expect(input("Series window").closest(".param-field")?.querySelector('[role="alert"]')?.textContent).toContain("tick, s");
    expect(documents.experiment.execution.window).toBe("25tick");
  });

  it("keeps an invalid editable draft across parent rerenders until correction", () => {
    const onParam = vi.fn();
    const onValidity = vi.fn();
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway", editable: true, overrides: {}, onParam, onValidity };
    const view = render(<Inspector {...props} />);
    commit("Handlers", "4.5");
    view.rerender(<Inspector {...props} onValidity={vi.fn()} />);
    expect(input("Handlers").value).toBe("4.5");
    expect(onParam).not.toHaveBeenCalled();
    commit("Handlers", "5");
    expect(onParam).toHaveBeenCalledWith("gateway", "handlers", 5);
  });

  it("does not report an invalid editable draft for invalid read-only stored data", () => {
    const onValidity = vi.fn();
    const onParam = renderInspector({ editable: false, onValidity, model: withParam(model, "gateway", "handlers", 0) });
    expect(input("Handlers").readOnly).toBe(true);
    expect(onValidity).toHaveBeenCalledWith("gateway.handlers", true);
    expect(onValidity.mock.calls.every(([, valid]) => valid)).toBe(true);
    fireEvent.blur(input("Handlers"));
    expect(onParam).not.toHaveBeenCalled();
  });

  it("clears an invalid draft's validity registration when the field unmounts", () => {
    const onValidity = vi.fn();
    const props: InspectorProps = { catalog, model, experiment, selected: "gateway", editable: true, overrides: {}, onParam: vi.fn(), onValidity };
    const view = render(<Inspector {...props} />);
    fireEvent.change(input("Handlers"), { target: { value: "invalid" } });
    expect(onValidity).toHaveBeenCalledWith("gateway.handlers", false);
    view.rerender(<Inspector {...props} selected={null} />);
    expect(onValidity).toHaveBeenCalledWith("gateway.handlers", true);
  });

  it("uses catalog object defaults and commits choice edits as a whole object", () => {
    const onParam = renderInspector({ selected: "gateway-to-middle", model: withParam(model, "gateway-to-middle", "backoff", undefined) });
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).value).toBe("none");
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "fixed" } });
    expect(onParam).toHaveBeenCalledWith("gateway-to-middle", "backoff", { kind: "fixed" });
  });

  it("validates exclusive catalog limits using converted duration units", () => {
    const rangedCatalog = structuredClone(catalog);
    rangedCatalog.types.find((type) => type.id === "call")!.params.find((param) => param.name === "timeout")!.exclusiveMinimum = 100;
    const onParam = renderInspector({ catalog: rangedCatalog, selected: "gateway-to-middle" });
    commit("Timeout", "0.1s");
    expect(screen.getByRole("alert").textContent).toContain("> 100ms");
    expect(onParam).toHaveBeenCalledWith("gateway-to-middle", "timeout", "0.1s");
    commit("Timeout", "0.101s");
    expect(onParam).toHaveBeenCalledWith("gateway-to-middle", "timeout", "0.101s");
  });

  it("shows diagnostics beside nested parameter fields and common experiment fields", () => {
    const warning = { code: "LINT_TIMEOUT_BUDGET", severity: "WARNING" as const, message: "Increase the timeout budget" };
    const { unmount } = render(<Inspector
      catalog={catalog} model={model} experiment={experiment} selected="gateway-to-middle" editable overrides={{}}
      onParam={vi.fn()} onValidity={vi.fn()} fieldDiagnostics={new Map([["backoff.base", [warning]]])}
    />);
    expect(screen.getByText(/Increase the timeout budget/).closest(".param-field")?.textContent).toContain("Base delay");
    unmount();
    renderInspector({ selected: null, fieldDiagnostics: new Map([
      ["execution.replications", [{ ...warning, severity: "ERROR", message: "Invalid replications" }]],
      ["execution.window", [{ ...warning, severity: "ERROR", message: "Invalid series window" }]],
      ["faults.0.failureRate", [{ ...warning, message: "Invalid fault probability" }]],
      ["faults", [{ ...warning, message: "Overlapping faults" }]],
      ["faults.0", [{ ...warning, message: "Empty fault" }]],
    ]) });
    expect(screen.getByText(/Invalid replications/)).toBeTruthy();
    expect(screen.getByText(/Invalid series window/).closest(".param-field")).toBe(input("Series window").closest(".param-field"));
    expect(screen.getByText(/Invalid fault probability/)).toBeTruthy();
    expect(screen.getByText(/Overlapping faults/)).toBeTruthy();
    expect(screen.getByText(/Empty fault/)).toBeTruthy();
  });
});


it("shows a missing required choice as unset until the user selects it", () => {
  const empty = { ...model, blocks: { ...model.blocks, gateway: { type: "service", params: {} } } };
  renderInspector({ model: empty });
  const distribution = screen.getByLabelText("Distribution") as HTMLSelectElement;
  expect(distribution.value).toBe("");
  expect(distribution.selectedOptions[0].disabled).toBe(true);
  fireEvent.change(distribution, { target: { value: "fixed" } });
  expect(distribution.value).toBe("fixed");
});


it("keeps variant actions and experiment sections out of an element Inspector", () => {
  renderInspector({ variantId: "baseline", onCommand: vi.fn() });
  expect(screen.queryByRole("button", { name: "Add variant" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy variant" })).toBeNull();
  expect(screen.queryByLabelText("Variant ID")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Run settings" })).toBeNull();
  expect(screen.queryByText("Experiment settings (shared)")).toBeNull();
  expect(screen.getByText(/variant overrides/)).toBeTruthy();
});

it("renders catalog descriptions below scalar and object fields with accessible associations", () => {
  const described = structuredClone(catalog);
  const params = described.types.find(type => type.id === "service")!.params;
  params.find(param => param.name === "handlers")!.description = "Concurrent handler slots.";
  params.find(param => param.name === "processing")!.description = "Local processing distribution.";
  renderInspector({ catalog: described });
  const field = screen.getByLabelText("Handlers");
  const description = screen.getByText("Concurrent handler slots.");
  expect(field.closest(".param-field")?.querySelector("input + .param-description")).toBe(description);
  expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(description.id);
  expect(screen.getByText("Local processing distribution.").closest("fieldset")).toBeTruthy();
});


it("focuses a fault target field requested by a diagnostic", () => {
  renderInspector({ selected: null, onCommand: vi.fn(), focusField: { path: "faults.0.target", request: 1 } });
  expect(document.activeElement).toBe(screen.getByLabelText("Fault target"));
});


it("describes shared run settings once at the section heading", () => {
  renderInspector({ selected: null, onCommand: vi.fn() });
  expect(screen.getAllByText("Shared by all variants")).toHaveLength(1);
});


it("shows results below parameters on a variant and only results in Analysis", () => {
  const props = { catalog, model, experiment, selected: "gateway", editable: true, overrides: {},
    onParam: vi.fn(), onValidity: vi.fn(), variantId: "baseline", results: <section aria-label="Element results">Recorded values</section> };
  const view = render(<Inspector {...props} />);
  expect(screen.getByLabelText("Handlers")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Element results" })).toBeTruthy();
  view.rerender(<Inspector {...props} resultsOnly />);
  expect(screen.queryByRole("textbox", { name: "Handlers" })).toBeNull();
  expect(screen.getByRole("region", { name: "Element results" })).toBeTruthy();
  view.rerender(<Inspector {...props} variantId={null} />);
  expect(screen.queryByRole("region", { name: "Element results" })).toBeNull();
});
