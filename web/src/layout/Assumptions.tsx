import { t } from "../i18n";
import { formatDuration, formatNumber } from "../i18n/format";
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
    [t("results.replications"), formatNumber(manifest.replications)],
    [t("results.assumptions.seed"), formatNumber(manifest.seed)],
    [t("results.assumptions.warmup"), formatDuration(series?.warmupMs)],
    [t("results.assumptions.measurement"), formatDuration(series?.measurementMs)],
    [t("results.assumptions.seriesWindow"), formatDuration(series?.windowMs)],
    [t("results.assumptions.sketchProfile"), series?.sketchProfile ?? formatNumber(null)],
    [t("results.assumptions.applicationVersion"), manifest.applicationVersion],
    [t("results.assumptions.kslVersion"), manifest.kslVersion],
  ];
  return (
    <div className="assumptions">
      <section>
        <h2>{t("results.assumptions.shared")}</h2>
        <ul>{catalog.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
      </section>
      <section>
        <h2>{t("results.assumptions.modelTypes")}</h2>
        {types.map((type) => <section key={type.id}>
          <h3>{type.title}</h3>
          <ul>{type.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
        </section>)}
      </section>
      <section>
        <h2>{t("results.assumptions.runConditions")}</h2>
        {manifest === null ? <p>{t("results.assumptions.noConditions")}</p> : <dl className="run-settings">
          {conditions.map(([name, value]) => <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>)}
        </dl>}
      </section>
    </div>
  );
}
