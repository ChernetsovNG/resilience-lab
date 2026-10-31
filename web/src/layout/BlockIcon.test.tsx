import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import catalog from "../test/catalog.json";
import { BlockIcon } from "./BlockIcon";

it.each(catalog.types.filter(type => type.category === "BLOCK"))("renders a decorative currentColor icon for $id", type => {
  const { container } = render(<BlockIcon type={type} />);
  const svg = container.querySelector("svg")!;
  expect(svg).not.toBeNull();
  expect(svg.getAttribute("stroke")).toBe("currentColor");
  expect(svg.querySelector("path, rect, ellipse")).not.toBeNull();
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});

it.each(["unknown", "__proto__", "constructor", "toString"])("keeps the text fallback for %s", id => {
  const { container } = render(<BlockIcon type={{ id, title: "Mystery" }} />);
  expect(container.textContent).toBe("M");
  expect(container.querySelector("svg")).toBeNull();
  expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
});

it("keeps model titles out of SVG markup", () => {
  const { container } = render(<BlockIcon type={{ id: "<svg onload=alert(1)>", title: "<img src=x>" }} />);
  expect(container.textContent).toBe("<");
  expect(container.querySelector("svg, img")).toBeNull();
});
