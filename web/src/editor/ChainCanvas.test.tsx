import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("status").textContent).toContain(
      "service must be connected to the entry chain",
    );
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
