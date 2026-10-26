import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DegradationSpec, Execution, LinkSpec, ServiceSpec, WorkloadSpec } from "../api/types";
import { DegradationInspector } from "./DegradationInspector";
import { ExecutionInspector } from "./ExecutionInspector";
import { LinkInspector } from "./LinkInspector";
import { ServiceInspector } from "./ServiceInspector";
import { WorkloadInspector } from "./WorkloadInspector";

const service: ServiceSpec = {
  id: "service-1",
  handlers: 4,
  queueCapacity: 32,
  processing: { kind: "FIXED", meanMs: 10, stdDevMs: null },
  failureRate: 0,
};

const link: LinkSpec = {
  id: "link-1",
  from: "service-1",
  to: "service-2",
  network: { kind: "FIXED", meanMs: 1, stdDevMs: null },
  timeoutMs: 100,
  maxAttempts: 1,
  retry: { kind: "NONE", baseBackoffMs: 0, maxBackoffMs: 0, base: 2 },
};

const workload: WorkloadSpec = { arrivalRate: 10, requestDeadlineMs: 1_000 };
const degradation: DegradationSpec = {
  serviceId: "service-1",
  startMs: 100,
  endMs: 500,
  processingMultiplier: 2,
  failureRate: null,
};
const execution: Execution = {
  replications: 3,
  warmupMs: 100,
  measurementMs: 1_000,
  seed: 42,
  maxRealTimeSeconds: 30,
};

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("parameter inspectors", () => {
  it("edits every service parameter and rejects invalid numbers without committing", () => {
    const onChange = vi.fn();
    render(<ServiceInspector service={service} onChange={onChange} />);

    change("Handlers", "8");
    expect(onChange).toHaveBeenLastCalledWith({ handlers: 8 });
    change("Queue capacity", "0");
    expect(onChange).toHaveBeenLastCalledWith({ queueCapacity: 0 });
    fireEvent.change(screen.getByLabelText("Processing kind"), { target: { value: "LOGNORMAL" } });
    expect(onChange).toHaveBeenLastCalledWith({
      processing: { kind: "LOGNORMAL", meanMs: 10, stdDevMs: 1 },
    });
    change("Processing mean (ms)", "12.5");
    expect(onChange).toHaveBeenLastCalledWith({
      processing: { kind: "FIXED", meanMs: 12.5, stdDevMs: null },
    });
    change("Processing standard deviation (ms)", "1.5");
    expect(onChange).toHaveBeenLastCalledWith({
      processing: { kind: "FIXED", meanMs: 10, stdDevMs: 1.5 },
    });
    change("Service failure rate", "0.25");
    expect(onChange).toHaveBeenLastCalledWith({ failureRate: 0.25 });

    onChange.mockClear();
    for (const value of ["", "abc", "NaN", "Infinity", "-1", "0", "1.5"]) {
      change("Handlers", value);
    }
    change("Queue capacity", "-1");
    change("Service failure rate", "-0.1");
    change("Service failure rate", "1.1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("edits link network, timeout, attempts, and retry parameters", () => {
    const onChange = vi.fn();
    render(<LinkInspector link={link} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Network kind"), { target: { value: "EXPONENTIAL" } });
    expect(onChange).toHaveBeenLastCalledWith({
      network: { kind: "EXPONENTIAL", meanMs: 1, stdDevMs: null },
    });
    change("Network mean (ms)", "2.5");
    expect(onChange).toHaveBeenLastCalledWith({
      network: { kind: "FIXED", meanMs: 2.5, stdDevMs: null },
    });
    change("Network standard deviation (ms)", "0.5");
    expect(onChange).toHaveBeenLastCalledWith({
      network: { kind: "FIXED", meanMs: 1, stdDevMs: 0.5 },
    });
    change("Timeout (ms)", "250");
    expect(onChange).toHaveBeenLastCalledWith({ timeoutMs: 250 });
    change("Maximum attempts", "3");
    expect(onChange).toHaveBeenLastCalledWith({ maxAttempts: 3 });
    fireEvent.change(screen.getByLabelText("Retry kind"), { target: { value: "FIXED" } });
    expect(onChange).toHaveBeenLastCalledWith({
      retry: { kind: "FIXED", baseBackoffMs: 0, maxBackoffMs: 0, base: 2 },
    });
    change("Base backoff (ms)", "20");
    expect(onChange).toHaveBeenLastCalledWith({
      retry: { kind: "NONE", baseBackoffMs: 20, maxBackoffMs: 0, base: 2 },
    });
    change("Maximum backoff (ms)", "100");
    expect(onChange).toHaveBeenLastCalledWith({
      retry: { kind: "NONE", baseBackoffMs: 0, maxBackoffMs: 100, base: 2 },
    });
    change("Retry base", "1.5");
    expect(onChange).toHaveBeenLastCalledWith({
      retry: { kind: "NONE", baseBackoffMs: 0, maxBackoffMs: 0, base: 1.5 },
    });

    onChange.mockClear();
    for (const [label, value] of [
      ["Timeout (ms)", "0"],
      ["Maximum attempts", "0"],
      ["Maximum attempts", "2.5"],
      ["Base backoff (ms)", "-1"],
      ["Retry base", "0"],
    ]) {
      change(label, value);
    }
    expect((screen.getByLabelText("Timeout (ms)") as HTMLInputElement).checkValidity()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("labels distribution controls independently for multiple links", () => {
    render(
      <>
        <LinkInspector link={link} onChange={vi.fn()} />
        <LinkInspector link={{ ...link, id: "link-2" }} onChange={vi.fn()} />
      </>,
    );
    const forms = screen.getAllByRole("form", { name: "Link parameters" });

    expect(within(forms[0]).getByLabelText("Network kind")).toBeTruthy();
    expect(within(forms[1]).getByLabelText("Network kind")).toBeTruthy();
  });

  it("edits workload and execution values including the seed", () => {
    const onWorkload = vi.fn();
    const onExecution = vi.fn();
    render(
      <>
        <WorkloadInspector workload={workload} onChange={onWorkload} />
        <ExecutionInspector execution={execution} onChange={onExecution} />
      </>,
    );

    change("Arrival rate", "20.5");
    expect(onWorkload).toHaveBeenLastCalledWith({ arrivalRate: 20.5 });
    change("Request deadline (ms)", "750");
    expect(onWorkload).toHaveBeenLastCalledWith({ requestDeadlineMs: 750 });
    change("Replications", "5");
    expect(onExecution).toHaveBeenLastCalledWith({ replications: 5 });
    change("Warm-up (ms)", "0");
    expect(onExecution).toHaveBeenLastCalledWith({ warmupMs: 0 });
    change("Measurement (ms)", "2000");
    expect(onExecution).toHaveBeenLastCalledWith({ measurementMs: 2000 });
    change("Seed", "-123456789");
    expect(onExecution).toHaveBeenLastCalledWith({ seed: -123456789 });
    change("Maximum real time (seconds)", "60");
    expect(onExecution).toHaveBeenLastCalledWith({ maxRealTimeSeconds: 60 });

    onWorkload.mockClear();
    onExecution.mockClear();
    change("Arrival rate", "0");
    change("Arrival rate", "1e-323");
    change("Request deadline (ms)", "-1");
    change("Replications", "0");
    change("Warm-up (ms)", "-1");
    change("Measurement (ms)", "0");
    change("Seed", "1.5");
    change("Maximum real time (seconds)", "0");
    expect(onWorkload).not.toHaveBeenCalled();
    expect(onExecution).not.toHaveBeenCalled();
  });

  it("rejects execution durations whose sum is not finite", () => {
    const onChange = vi.fn();
    render(<ExecutionInspector execution={{ ...execution, warmupMs: 1e308 }} onChange={onChange} />);

    change("Measurement (ms)", "1e308");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("enables, disables, and edits degradation while enforcing start before end", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DegradationInspector degradation={null} serviceIds={["service-1", "service-2"]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByLabelText("Enable degradation"));
    expect(onChange).toHaveBeenCalledWith({
      serviceId: "service-1",
      startMs: 0,
      endMs: 1_000,
      processingMultiplier: 1,
      failureRate: null,
    });

    rerender(
      <DegradationInspector degradation={degradation} serviceIds={["service-1", "service-2"]} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("Degraded service"), { target: { value: "service-2" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...degradation, serviceId: "service-2" });
    change("Degradation start (ms)", "50");
    expect(onChange).toHaveBeenLastCalledWith({ ...degradation, startMs: 50 });
    change("Degradation end (ms)", "600");
    expect(onChange).toHaveBeenLastCalledWith({ ...degradation, endMs: 600 });
    change("Processing multiplier", "4");
    expect(onChange).toHaveBeenLastCalledWith({ ...degradation, processingMultiplier: 4 });
    change("Degradation failure rate", "0.5");
    expect(onChange).toHaveBeenLastCalledWith({ ...degradation, failureRate: 0.5 });
    change("Degradation failure rate", "");
    expect(onChange).toHaveBeenLastCalledWith({ ...degradation, failureRate: null });

    onChange.mockClear();
    change("Degradation start (ms)", "500");
    change("Degradation end (ms)", "100");
    change("Processing multiplier", "0");
    change("Degradation failure rate", "1.1");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Enable degradation"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("does not show validation errors initially or while editing", () => {
    const onChange = vi.fn();
    render(<ServiceInspector service={service} onChange={onChange} />);
    const input = screen.getByLabelText("Handlers");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    fireEvent.change(input, { target: { value: "0" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).not.toBe("true");

    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toContain("greater than 0");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onChange).not.toHaveBeenCalled();
  });
});
