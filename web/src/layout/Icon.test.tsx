import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Icon, type IconName } from "./Icon";

const names: IconName[] = ["client", "service", "router", "database", "pooler", "info", "lock", "settings", "view-settings", "dice", "fit-view"];

it.each(names)("loads the %s asset as a decorative currentColor icon", name => {
  const { container } = render(<Icon name={name} />);
  const svg = container.querySelector("svg")!;
  expect(svg).not.toBeNull();
  expect(svg.getAttribute("viewBox")).toBe(name === "lock" ? "0 0 16 16" : "0 0 24 24");
  expect(svg.getAttribute("stroke")).toBe("currentColor");
  for (const shape of svg.querySelectorAll("[fill], [stroke]")) {
    for (const paint of ["fill", "stroke"]) {
      const value = shape.getAttribute(paint);
      if (value !== null) expect(["none", "currentColor"]).toContain(value);
    }
  }
  expect(svg.hasAttribute("width")).toBe(false);
  expect(svg.hasAttribute("height")).toBe(false);
  expect(svg.querySelector("path, rect, circle, ellipse")).not.toBeNull();
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("img")).toBeNull();
});

it("names standalone icons and sizes their wrapper", () => {
  render(<Icon name="settings" label="Run settings" size={24} className="toolbar-icon" />);
  const icon = screen.getByRole("img", { name: "Run settings" });
  expect(icon.getAttribute("aria-hidden")).toBeNull();
  expect(icon.classList.contains("toolbar-icon")).toBe(true);
  expect(icon.style.width).toBe("24px");
  expect(icon.style.height).toBe("24px");
});

it("keeps accessible names out of the imported SVG markup", () => {
  const label = '<img src=x onerror="alert(1)">';
  const { container } = render(<Icon name="info" label={label} />);
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
  expect(container.querySelector("img, script")).toBeNull();
  expect(container.querySelector("svg")?.textContent?.trim()).toBe("");
});
