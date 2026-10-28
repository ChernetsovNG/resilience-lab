import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalog, experiment, model } from "../test/fixtures";
import { applyOverrides, withParam } from "../workspace/params";
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

function commit(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
  fireEvent.blur(input(label));
}

describe("Inspector", () => {
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

    expect(screen.getByText("Replications").nextElementSibling?.textContent).toBe("2");
    expect(screen.getByText(/dependency: 200ms–700ms/).textContent).toContain("processing ×6");
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
      ["faults.0.failureRate", [{ ...warning, message: "Invalid fault probability" }]],
      ["faults", [{ ...warning, message: "Overlapping faults" }]],
      ["faults.0", [{ ...warning, message: "Empty fault" }]],
    ]) });
    expect(screen.getByText(/Invalid replications/)).toBeTruthy();
    expect(screen.getByText(/Invalid fault probability/)).toBeTruthy();
    expect(screen.getByText(/Overlapping faults/)).toBeTruthy();
    expect(screen.getByText(/Empty fault/)).toBeTruthy();
  });
});
