import { describe, expect, it } from "vitest";
import { editEdgePoints } from "./manualEdge";
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
    const points = Array.from({ length: 52 }, (_, i) => ({ x: Math.floor(i / 2) * 20, y: Math.ceil(i / 2) * 20 }));
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
