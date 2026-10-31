import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { layoutEdges } from "../src/canvas/edgeGeometry.ts";

// Fixed workload: 180×120 nodes on a 300×220 grid, two calls per node, 90×24 labels.
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, warmup: 5, samples: 20 }));
for (const [columns, rows] of [[6, 4], [8, 6], [10, 10]]) {
  const nodes = new Map(Array.from({ length: columns * rows }, (_, index) => [String(index), {
    x: (index % columns) * 300, y: Math.floor(index / columns) * 220, width: 180, height: 120,
  }]));
  const edges = [...nodes].flatMap(([from, source], index) => [1, 2].map(offset => {
    // Wrap within each row so the final columns also have two calls.
    const to = String(Math.floor(index / columns) * columns + (index + offset) % columns);
    const target = nodes.get(to);
    return { id: `${from}-${to}`, from, to, sourceX: source.x + source.width,
      sourceY: source.y + source.height / 2, targetX: target.x, targetY: target.y + target.height / 2,
      width: 90, height: 24 };
  }));
  for (let index = 0; index < 5; index++) layoutEdges(edges, nodes);
  const samples = Array.from({ length: 20 }, () => {
    const start = performance.now();
    const result = layoutEdges(edges, nodes);
    const elapsed = performance.now() - start;
    if (result.size !== edges.length) throw new Error("Missing edge geometry");
    return elapsed;
  }).sort((a, b) => a - b);
  const round = value => Number(value.toFixed(2));
  console.log(JSON.stringify({ nodes: nodes.size, edges: edges.length,
    minMs: round(samples[0]), medianMs: round((samples[9] + samples[10]) / 2), maxMs: round(samples.at(-1)) }));
}
