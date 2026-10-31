import type { XYPosition } from "@xyflow/react";

/** Longest common straight segment of simplified polylines, independent of direction. */
export function sharedEdgeLength(a: XYPosition[], b: XYPosition[]): number {
  let longest = 0;
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      for (const axis of ["x", "y"] as const) {
        const other = axis === "x" ? "y" : "x";
        if (Math.abs(a[i - 1][other] - a[i][other]) > 1e-6 ||
          Math.abs(b[j - 1][other] - b[j][other]) > 1e-6 || Math.abs(a[i][other] - b[j][other]) > 1e-6) continue;
        longest = Math.max(longest, Math.min(Math.max(a[i - 1][axis], a[i][axis]), Math.max(b[j - 1][axis], b[j][axis])) -
          Math.max(Math.min(a[i - 1][axis], a[i][axis]), Math.min(b[j - 1][axis], b[j][axis])));
      }
    }
  }
  return longest;
}
