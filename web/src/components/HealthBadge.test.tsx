import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthBadge } from "./HealthBadge";

describe("HealthBadge", () => {
  it("renders healthy backend information", () => {
    render(
      <HealthBadge
        health={{ status: "ok", applicationVersion: "0.1.0", kslVersion: "R1.8.1" }}
        error={null}
      />,
    );

    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("Backend healthy");
    expect(badge.textContent).toContain("0.1.0");
  });

  it("renders a health check error", () => {
    render(<HealthBadge health={null} error="Connection refused" />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Backend unavailable: Connection refused",
    );
  });
});
