import { describe, expect, it } from "vitest";
import { edgeBends, editEdgePoints } from "./manualEdge";
import { manualEdgePoints } from "./edgeGeometry";

const path = [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 90 }, { x: 160, y: 90 }];
const anchors = path.slice(1, -1);

describe("manual edge gestures", () => {
  it.each([0, 1, 2])("moves segment %s perpendicular while keeping both ports fixed", index => {
    const horizontal = path[index].y === path[index + 1].y;
    const point = { x: 100, y: 40 };
    const edited = editEdgePoints(path, anchors, { kind: "segment", index }, point)!;
    const routed = manualEdgePoints(path[0], path.at(-1)!, edited);
    expect(routed[0]).toEqual(path[0]);
    expect(routed.at(-1)).toEqual(path.at(-1));
    expect(routed.slice(1).every((end, i) => end.x === routed[i].x || end.y === routed[i].y)).toBe(true);
    expect(routed.slice(1).some((end, i) => horizontal
      ? end.y === point.y && routed[i].y === point.y && end.x !== routed[i].x
      : end.x === point.x && routed[i].x === point.x && end.y !== routed[i].y)).toBe(true);
  });

  it("moves and deletes rendered bends without moving other authored anchors", () => {
    expect(editEdgePoints(path, anchors, { kind: "bend", index: 1 }, { x: 70, y: 20 })).toEqual([{ x: 70, y: 20 }, anchors[1]]);
    expect(editEdgePoints(path, anchors, { kind: "bend", index: 1 }, null)).toEqual([{ x: 10, y: 90 }, anchors[1]]);
  });

  it("refuses an edit that would exceed 50 persisted anchors without dropping any", () => {
    const points = Array.from({ length: 52 }, (_, i) => ({ x: Math.ceil(i / 2) * 20, y: Math.floor(i / 2) * 20 }));
    expect(editEdgePoints(points, points.slice(1, -1), { kind: "segment", index: 0 }, { x: 15, y: 15 })).toBeNull();
    expect(editEdgePoints(path, anchors, { kind: "bend", index: 1 }, { x: Infinity, y: 0 })).toBeNull();
  });
});

it.each([1, 3])("edits the rendered diagonal-anchor corner at path index %s while preserving the authored anchor", index => {
  const source = { x: 0, y: 0 };
  const target = { x: 20, y: 20 };
  const authored = [{ x: 10, y: 10 }];
  const rendered = manualEdgePoints(source, target, authored);
  const moved = { x: 14, y: index === 1 ? -4 : 24 };
  const edited = editEdgePoints(rendered, authored, { kind: "bend", index }, moved)!;
  expect(edited).toContainEqual(moved);
  expect(edited).toContainEqual(authored[0]);
  const deleted = editEdgePoints(rendered, authored, { kind: "bend", index }, null)!;
  expect(deleted).toContainEqual(authored[0]);
  expect(manualEdgePoints(source, target, deleted)).not.toContainEqual(rendered[index]);
});


it("restores automatic routing when the final authored corner is deleted", () => {
  const anchors = [{ x: 20, y: 0 }];
  const path = manualEdgePoints({ x: 0, y: 0 }, { x: 20, y: 20 }, anchors);
  expect(editEdgePoints(path, anchors, { kind: "bend", index: 1 }, null)).toEqual([]);
});

it("deletes a corner on an automatic path by saving the opposite elbow", () => {
  const path = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }];
  expect(editEdgePoints(path, [], { kind: "bend", index: 1 }, null)).toEqual([{ x: 0, y: 20 }]);
});


describe("authored anchor limits", () => {
  const source = { x: 0, y: 0 };
  const target = { x: 1200, y: 1200 };
  const diagonal = Array.from({ length: 26 }, (_, i) => ({ x: i * 20 + 10, y: i * 20 + 10 }));

  function expectRoute(points: { x: number; y: number }[]) {
    const routed = manualEdgePoints(source, target, points);
    expect(routed[0]).toEqual(source);
    expect(routed.at(-1)).toEqual(target);
    expect(routed.slice(1).every((end, i) => end.x === routed[i].x || end.y === routed[i].y)).toBe(true);
    return routed;
  }

  it("moves one of 26 authored anchors without saving unrelated generated elbows", () => {
    const rendered = manualEdgePoints(source, target, diagonal);
    expect(rendered).toHaveLength(55);
    const edited = editEdgePoints(rendered, diagonal, { kind: "bend", index: 2 }, { x: 15, y: 15 });
    expect(edited).toEqual([{ x: 15, y: 15 }, ...diagonal.slice(1)]);
    expectRoute(edited!);
  });

  it.each([1, 2, 3, 52, 53])("deletes local corner %s on a 26-anchor route without regenerating it", index => {
    const rendered = manualEdgePoints(source, target, diagonal);
    const edited = editEdgePoints(rendered, diagonal, { kind: "bend", index }, null);
    expect(edited).not.toBeNull();
    expect(edited!.length).toBeLessThanOrEqual(27);
    const unchanged = diagonal.filter(anchor => anchor.x !== rendered[index].x || anchor.y !== rendered[index].y);
    expect(edited!.filter(anchor => unchanged.some(original => original.x === anchor.x && original.y === anchor.y))).toEqual(unchanged);
    expect(expectRoute(edited!)).not.toContainEqual(rendered[index]);
  });

  it.each([0, 1, 2, 25, 52, 53])("shifts only segment %s and its local endpoints on a 26-anchor route", index => {
    const rendered = manualEdgePoints(source, target, diagonal);
    const first = rendered[index];
    const last = rendered[index + 1];
    const axis = first.y === last.y ? "y" : "x";
    const shifted = [first, last].map(point => ({ ...point, [axis]: point[axis] + 5 }));
    const edited = editEdgePoints(rendered, diagonal, { kind: "segment", index }, shifted[0]);
    expect(edited).not.toBeNull();
    expect(edited!.length).toBeLessThanOrEqual(28);
    const unchanged = diagonal.filter(anchor => ![first, last].some(endpoint => endpoint.x === anchor.x && endpoint.y === anchor.y));
    expect(edited!.filter(anchor => unchanged.some(original => original.x === anchor.x && original.y === anchor.y))).toEqual(unchanged);
    const routed = expectRoute(edited!);
    const start = routed.findIndex(point => point.x === shifted[0].x && point.y === shifted[0].y);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(routed[start + 1]).toEqual(shifted[1]);
  });

  it("permits existing-anchor edits at 50 anchors without changing their order or count", () => {
    const authored = Array.from({ length: 50 }, (_, i) => ({ x: i * 20 + 10, y: i * 20 + 10 }));
    const rendered = manualEdgePoints(source, target, authored);
    expect(editEdgePoints(rendered, authored, { kind: "bend", index: 2 }, { x: 15, y: 15 }))
      .toEqual([{ x: 15, y: 15 }, ...authored.slice(1)]);
    expect(editEdgePoints(rendered, authored, { kind: "bend", index: 2 }, null))
      .toEqual([{ x: 30, y: 0 }, ...authored.slice(1)]);
    expect(editEdgePoints(rendered, authored, { kind: "segment", index: 1 }, { x: 15, y: 5 }))
      .toEqual([{ x: 15, y: 10 }, ...authored.slice(1)]);
    expect(editEdgePoints(rendered, authored, { kind: "segment", index: 2 }, { x: 20, y: 15 }))
      .toEqual([{ x: 10, y: 15 }, ...authored.slice(1)]);
    const stairs = Array.from({ length: 50 }, (_, i) => ({ x: Math.ceil((i + 1) / 2) * 20, y: Math.floor((i + 1) / 2) * 20 }));
    const stairPath = manualEdgePoints(source, target, stairs);
    expect(editEdgePoints(stairPath, stairs, { kind: "segment", index: 1 }, { x: 25, y: 10 }))
      .toEqual([{ x: 25, y: 0 }, { x: 25, y: 20 }, ...stairs.slice(2)]);
  });

  it("rejects local operations needing a 51st anchor atomically", () => {
    const authored = Array.from({ length: 50 }, (_, i) => ({ x: i * 20 + 10, y: i * 20 + 10 }));
    const rendered = manualEdgePoints(source, target, authored);
    const snapshot = structuredClone({ authored, rendered });
    expect(editEdgePoints(rendered, authored, { kind: "bend", index: 1 }, { x: 15, y: -5 })).toBeNull();
    expect(editEdgePoints(rendered, authored, { kind: "bend", index: 1 }, null)).toBeNull();
    expect(editEdgePoints(rendered, authored, { kind: "segment", index: 0 }, { x: 5, y: -5 })).toBeNull();
    expect({ authored, rendered }).toEqual(snapshot);
  });

  it("preserves repeated authored anchors in order when another corner is edited", () => {
    const authored = [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 10 }];
    const rendered = manualEdgePoints(source, target, authored);
    expect(editEdgePoints(rendered, authored, { kind: "bend", index: 1 }, { x: 15, y: -5 }))
      .toEqual([{ x: 15, y: -5 }, ...authored]);
  });
});


it.each([
  [1, { x: 10, y: 5 }], [1, { x: 5, y: 0 }],
  [1, { x: 10, y: -5 }], [1, { x: 15, y: 0 }],
  [3, { x: 10, y: 15 }], [3, { x: 15, y: 20 }],
  [3, { x: 10, y: 25 }], [3, { x: 5, y: 20 }],
] as const)("moves generated bend %s visibly to %j with a one-axis drag", (index, moved) => {
  const source = { x: 0, y: 0 };
  const target = { x: 20, y: 20 };
  const anchors = [{ x: 10, y: 10 }];
  const path = manualEdgePoints(source, target, anchors);
  const edited = editEdgePoints(path, anchors, { kind: "bend", index }, moved)!;
  expect(edited).toContainEqual(anchors[0]);
  expect(edited).toContainEqual(moved);
  const routed = manualEdgePoints(source, target, edited);
  expect(edgeBends(routed).map(bend => bend.point)).toContainEqual(moved);
  const movedPorts = manualEdgePoints({ x: -5, y: -5 }, { x: 25, y: 25 }, edited);
  expect(movedPorts).toContainEqual(moved);
  expect(routed[0]).toEqual(source);
  expect(routed.at(-1)).toEqual(target);
  expect(routed.slice(1).every((end, i) => end.x === routed[i].x || end.y === routed[i].y)).toBe(true);
});

it("moves an authored bend visibly when its new position is on the former outgoing segment", () => {
  const source = { x: 0, y: 0 };
  const target = { x: 40, y: 40 };
  const anchors = [{ x: 20, y: 0 }, { x: 20, y: 20 }];
  const path = manualEdgePoints(source, target, anchors);
  const moved = { x: 20, y: 5 };
  const edited = editEdgePoints(path, anchors, { kind: "bend", index: 1 }, moved)!;
  expect(edited).toContainEqual(anchors[1]);
  const routed = manualEdgePoints(source, target, edited);
  expect(edgeBends(routed).map(bend => bend.point)).toContainEqual(moved);
  expect(routed[0]).toEqual(source);
  expect(routed.at(-1)).toEqual(target);
});
