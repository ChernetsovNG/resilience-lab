import { describe, expect, it } from "vitest";
import type { components } from "../../api/schema";
import { selectSeriesParts } from "./selection";

type SeriesIndex = components["schemas"]["SeriesIndex"];

const index: SeriesIndex = {
  schemaVersion: 5,
  endMs: 1000,
  windowMs: 10,
  parts: [
    { file: "part-0.json.gz", nodes: ["client", "gateway"], fromWindow: 0, untilWindow: 50, connections: [], uncompressedBytes: 100, sha256: "a" },
    { file: "part-1.json.gz", nodes: ["middle", "dependency"], fromWindow: 0, untilWindow: 50, connections: [], uncompressedBytes: 100, sha256: "b" },
    { file: "part-2.json.gz", nodes: ["client", "gateway"], fromWindow: 50, untilWindow: 100, connections: [], uncompressedBytes: 100, sha256: "c" },
    { file: "part-3.json.gz", nodes: ["middle", "dependency"], fromWindow: 50, untilWindow: 100, connections: [], uncompressedBytes: 100, sha256: "d" },
  ],
};

describe("series part selection", () => {
  it("intersects requested nodes and the half-open window range", () => {
    expect(selectSeriesParts(index, ["gateway"], 25, 75).map((part) => part.file)).toEqual([
      "part-0.json.gz",
      "part-2.json.gz",
    ]);
    expect(selectSeriesParts(index, ["dependency"], 0, 50).map((part) => part.file)).toEqual(["part-1.json.gz"]);
  });

  it("excludes adjacent ranges and unknown nodes", () => {
    expect(selectSeriesParts(index, ["gateway"], 50, 50)).toEqual([]);
    expect(selectSeriesParts(index, ["gateway"], 100, 120)).toEqual([]);
    expect(selectSeriesParts(index, ["missing"], 0, 100)).toEqual([]);
  });
});
