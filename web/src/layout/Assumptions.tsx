import type { Catalog, ModelFile, RunManifest } from "../api/apiTypes";

interface AssumptionsProps {
  catalog: Catalog;
  model: ModelFile;
  manifest: RunManifest | null;
}

/** Catalog assumptions for the submitted model and reproducibility conditions from its manifest. */
export function Assumptions({ catalog, model, manifest }: AssumptionsProps) {
  const usedTypes = new Set([
    ...Object.values(model.blocks).map((block) => block.type),
    ...model.connections.map((connection) => connection.type),
  ]);
  const types = catalog.types.filter((type) => usedTypes.has(type.id));
  const series = manifest?.series;
  const conditions: [string, string | number][] = manifest === null ? [] : [
    ["Replications", manifest.replications],
    ["Seed", manifest.seed],
    ["Warmup", series == null ? "n/a" : `${series.warmupMs} ms`],
    ["Measurement", series == null ? "n/a" : `${series.measurementMs} ms`],
    ["Series window", series == null ? "n/a" : `${series.windowMs} ms`],
    ["Sketch profile", series?.sketchProfile ?? "n/a"],
    ["Application version", manifest.applicationVersion],
    ["KSL version", manifest.kslVersion],
  ];
  return (
    <div className="assumptions">
      <section>
        <h2>Shared assumptions</h2>
        <ul>{catalog.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
      </section>
      <section>
        <h2>Model types</h2>
        {types.map((type) => <section key={type.id}>
          <h3>{type.title}</h3>
          <ul>{type.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </section>)}
      </section>
      <section>
        <h2>Run conditions</h2>
        {manifest === null ? <p>No completed run conditions are available.</p> : <dl className="run-settings">
          {conditions.map(([name, value]) => <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>)}
        </dl>}
      </section>
    </div>
  );
}
