import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { ChainCanvas } from "./ChainCanvas";
import { TopologyIssues } from "./TopologyIssues";

beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      width: 180,
      height: 80,
      top: 0,
      left: 0,
      right: 180,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { get: () => 180 },
    offsetHeight: { get: () => 80 },
  });
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    value: class DOMMatrixReadOnly {
      m22: number;

      constructor(transform: string) {
        this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
      }
    },
  });
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      queueMicrotask(() => {
        this.callback(
          [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
          this,
        );
      });
    }
    unobserve() {}
    disconnect() {}
  };
});

describe("ChainCanvas", () => {
  it("creates three service blocks and adds a service", () => {
    render(<ChainCanvas />);

    expect(screen.getByRole("application", { name: "Service chain canvas" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New three-service chain" }));
    expect(screen.getAllByTestId("service-block")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(screen.getAllByTestId("service-block")).toHaveLength(4);
  });

  it("edits the selected service through its parameter inspector", () => {
    render(<ChainCanvas />);
    const inspector = screen.getByRole("form", { name: "Service parameters" });

    fireEvent.change(within(inspector).getByLabelText("Handlers"), { target: { value: "8" } });

    expect(screen.getAllByTestId("service-block")[0].textContent).toContain("8 handlers");
  });

  it("deletes the selected service and its linked edge", async () => {
    const { container } = render(<ChainCanvas />);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(2));
    const services = screen.getAllByTestId("service-block");

    fireEvent.click(services[2]);
    fireEvent.click(screen.getByRole("button", { name: "Delete selected service" }));

    expect(screen.getAllByTestId("service-block")).toHaveLength(2);
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(1));
  });

  it("disables comparison while an added service is disconnected", () => {
    render(<ChainCanvas />);
    const run = screen.getByRole("button", { name: "Run comparison" }) as HTMLButtonElement;

    expect(run.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));

    expect(run.disabled).toBe(true);
    expect(screen.getByText(/service must be connected to the entry chain/)).toBeTruthy();
  });

  it("edits baseline and candidate independently and clears selection when switching", () => {
    render(<ChainCanvas />);
    fireEvent.click(screen.getAllByTestId("service-block")[2]);
    expect(screen.getByRole("button", { name: "Delete selected service" })).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("radio", { name: "Candidate" }));
    expect(screen.getByRole("button", { name: "Delete selected service" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "8" } });
    expect(screen.getAllByTestId("service-block")[0].textContent).toContain("8 handlers");

    fireEvent.click(screen.getByRole("radio", { name: "Baseline" }));
    expect(screen.getByLabelText("Handlers")).toHaveProperty("value", "4");
    expect(screen.getAllByTestId("service-block")[0].textContent).toContain("4 handlers");
    fireEvent.click(screen.getByRole("radio", { name: "Candidate" }));
    expect(screen.getByLabelText("Handlers")).toHaveProperty("value", "8");
  });

  it("disables submission while a numeric draft is invalid", () => {
    render(<ChainCanvas />);
    const run = screen.getByRole("button", { name: "Run comparison" }) as HTMLButtonElement;

    fireEvent.change(screen.getByLabelText("Replications"), { target: { value: "" } });

    expect(screen.getByLabelText("Replications")).toHaveProperty("value", "");
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Replications"), { target: { value: "2" } });
    expect(run.disabled).toBe(false);
  });

  it("runs sweep only while the visible draft matches the last valid apply", () => {
    render(<ChainCanvas />);
    const run = screen.getByRole("button", { name: "Run sweep" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Sweep parameter"), { target: { value: "LINK_TIMEOUT" } });
    fireEvent.change(screen.getByLabelText("Link ID"), { target: { value: "link-1" } });
    fireEvent.change(screen.getByLabelText("Sweep values"), { target: { value: "25, 50" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(run.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Sweep values"), { target: { value: "25, 75" } });
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Sweep values"), { target: { value: "25, Infinity" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply sweep" }));
    expect(screen.getByRole("alert").textContent).toContain("finite numbers");
    expect(run.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Sweep values"), { target: { value: "25, 50" } });
    expect(run.disabled).toBe(false);
  });
});

describe("TopologyIssues", () => {
  it("shows readable branch and disconnected-service issues", () => {
    render(
      <TopologyIssues
        issues={[
          {
            path: "baseline.links[2].from",
            message: "service must have at most one outgoing link",
          },
          {
            path: "baseline.services[3].id",
            message: "service must be connected to the entry chain",
          },
        ]}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "service must have at most one outgoing link",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "service must be connected to the entry chain",
    );
  });
});
