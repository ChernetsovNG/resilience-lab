import { describe, expect, it } from "vitest";
import { blockGeometry, minimumBlockHeight } from "./blockGeometry";

const sizes = [[150, 220], [192, 240], [300, 400], [300, 160]] as const;

function circle(path: string) {
  const values = path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  return { left: values[0], cy: values[1], rx: values[2], ry: values[3] };
}

describe("Person geometry", () => {
  it.each(sizes)("keeps its head circular and overlapped by the shoulders at %s × %s", (width, requestedHeight) => {
    const height = Math.max(requestedHeight, minimumBlockHeight("client", width, 72));
    const shape = blockGeometry("client", width, height);
    const head = circle(shape.paths[0]);
    expect(head.rx).toBeCloseTo(width * 0.19);
    expect(head.ry).toBe(head.rx);
    expect(head.left + head.rx).toBeCloseTo(width / 2);
    const bodyTop = Number(shape.paths[1].split(" ")[2]);
    expect(head.cy + head.ry - bodyTop).toBeCloseTo(width * 0.38 / 3);
    expect(shape.content.y).toBeGreaterThan(head.cy + head.ry);
    expect(shape.content.y).toBeCloseTo(bodyTop + width / 4 + 8);
    expect(shape.content.y + shape.content.height).toBeLessThanOrEqual(height - 10);
    expect(shape.ports.IN).toEqual({ x: 2, y: (bodyTop + width / 4 + height - 10) / 2 });
    expect(shape.ports.OUT.x).toBe(width - 2);
    expect(shape.ports.OUT.y).toBe(shape.ports.IN.y);
  });

  it.each([
    [180, 72, 183], [300, 72, 243], [180, 140, 251],
  ])("grows to measured content at width %s, content %s", (width, contentHeight, height) => {
    expect(minimumBlockHeight("client", width, contentHeight)).toBe(height);
    expect(blockGeometry("client", width, height).content.height).toBeGreaterThanOrEqual(contentHeight);
  });
});

it.each(sizes)("keeps cylinder content below its fixed 16 px lid at %s × %s", (width, height) => {
  const shape = blockGeometry("database", width, height);
  expect(shape.paths[0]).toContain(`A ${(width - 2) / 2} 8`);
  expect(shape.details[0]).toContain(`A ${(width - 2) / 2} 8`);
  expect(shape.content.y).toBeGreaterThan(17);
  expect(shape.content.y + shape.content.height).toBeLessThan(height - 9);
  expect(shape.ports.IN).toEqual({ x: 1, y: height / 2 });
  expect(shape.ports.OUT).toEqual({ x: width - 1, y: height / 2 });
});

it.each(sizes)("keeps the pooler's inner frame 6 px from its outline at %s × %s", (width, height) => {
  const shape = blockGeometry("pooler", width, height);
  expect(shape.paths[0]).toBe(`M 1 1 H ${width - 1} V ${height - 1} H 1 Z`);
  expect(shape.details[0]).toBe(`M 7 7 H ${width - 7} V ${height - 7} H 7 Z`);
  expect(shape.content.x).toBeGreaterThan(7);
  expect(shape.content.y).toBeGreaterThan(7);
});

it.each([[144, 144], [144, 240], [240, 144]])("inscribes the router and places ports on its circle at %s × %s", (width, height) => {
  const shape = blockGeometry("router", width, height);
  const head = circle(shape.paths[0]);
  const radius = (Math.min(width, height) - 2) / 2;
  expect(head.rx).toBe(radius);
  expect(head.ry).toBe(radius);
  expect(shape.ports.IN).toEqual({ x: width / 2 - radius, y: height / 2 });
  expect(shape.ports.OUT).toEqual({ x: width / 2 + radius, y: height / 2 });
  for (const x of [shape.content.x, shape.content.x + shape.content.width]) {
    for (const y of [shape.content.y, shape.content.y + shape.content.height]) {
      expect(Math.hypot(x - width / 2, y - height / 2)).toBeLessThan(radius);
    }
  }
});

it("keeps the default router smaller than a service", () => {
  expect(minimumBlockHeight("router", 144, 38)).toBeLessThan(minimumBlockHeight("service", 192, 130));
  expect(blockGeometry("router", 144, 144).content.width).toBeLessThan(blockGeometry("service", 192, 152).content.width);
});

it("draws two replica back edges and uses the front card for content and ports", () => {
  const single = blockGeometry("service", 256, 212);
  const stack = blockGeometry("service", 264, 220, 3);
  expect(stack.back).toHaveLength(2);
  expect(stack.paths[0]).toContain("M 9 9");
  expect(stack.content).toEqual({ ...single.content, y: single.content.y + 8 });
  expect(stack.ports.IN).toEqual({ ...single.ports.IN, y: single.ports.IN.y + 8 });
  expect(stack.ports.OUT).toEqual({ ...single.ports.OUT, y: single.ports.OUT.y + 8 });
  expect(minimumBlockHeight("service", 264, 130, 3)).toBe(minimumBlockHeight("service", 256, 130) + 8);
  expect(blockGeometry("service", 256, 212, 1).back).toEqual([]);
  expect(blockGeometry("database", 192, 220, 3).back).toEqual([]);
});

it("keeps an unknown block type in the same rounded card as a service", () => {
  expect(blockGeometry("worker", 192, 160)).toEqual(blockGeometry("service", 192, 160));
});
