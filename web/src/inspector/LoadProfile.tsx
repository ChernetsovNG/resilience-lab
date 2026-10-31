import type { Catalog, Diagnostic, ExperimentFile, ModelFile, ParamDescriptor } from "../api/apiTypes";
import { courseData } from "../experiment/course";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { formatDuration, formatNumber, formatRate } from "../i18n/format";
import { DiagnosticMessages, VariantDiagnosticLinks } from "../validation/DiagnosticDisplay";
import { initialParams } from "../workspace/initialParams";
import { isObject } from "../workspace/params";
import { canonicalOf } from "../workspace/quantities";
import { InspectorSection } from "./InspectorSection";
import { ParamField } from "./ParamField";
import "./load-profile.css";

/** Edits one complete client profile; the caller directs the write to the model or active variant. */
export function LoadProfile({ catalog, model, experiment, clientId, descriptor, editable, invalid, overridden,
  onCommit, onReset, onValidity, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic }: {
  catalog: Catalog;
  model: ModelFile;
  experiment: ExperimentFile;
  clientId: string;
  descriptor: ParamDescriptor;
  editable: boolean;
  invalid: boolean;
  overridden: boolean;
  onCommit: (value: unknown) => void;
  onReset?: () => void;
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  variantFieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
  onVariantDiagnostic?: (variant: string, field: string) => void;
}) {
  const value = model.blocks[clientId].params.load;
  const profile = isObject(value) ? value : {};
  const points: unknown[] = Array.isArray(profile.points) ? profile.points : [];
  const fields = descriptor.fields.find(field => field.name === "points")?.fields ?? [];
  const disabled = !editable || invalid;
  const write = (next: unknown[]) => { if (editable) onCommit({ ...profile, points: next }); };
  const add = () => {
    if (disabled) return;
    const next = initialParams(fields);
    const last = points.at(-1);
    if (isObject(last)) {
      const time = fields.find(field => field.name === "time");
      const previous = typeof last.time === "string" ? canonicalOf(last.time, time?.units ?? []) : null;
      if (previous !== null) next.time = `${previous / 1000 + 1}s`;
      next.rate = last.rate ?? next.rate;
    }
    write([...points, next]);
  };
  const data = courseData(model, experiment, catalog);
  const curve = data.loads.find(load => load.id === clientId)?.points ?? [];
  const maximum = Math.max(0, ...curve.map(point => point.rate));
  const x = (timeMs: number) => timeMs / (data.endMs || 1) * 300;
  const y = (rate: number) => 80 - rate / (maximum || 1) * 60;

  return <InspectorSection name="load" title={<>{t("editor.load.title")} <span onClick={event => event.stopPropagation()}>
    <HelpHint label={t("editor.load.title")}>{descriptor.description}</HelpHint></span></>}>
    <div className={overridden ? "load-profile param-field--overridden" : "load-profile"} data-inspector-field="load.points">
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("load")} />
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("load.points")} />
      <VariantDiagnosticLinks diagnostics={variantFieldDiagnostics?.get("load") ?? variantFieldDiagnostics?.get("load.points")}
        disabled={invalid} onSelect={variant => onVariantDiagnostic?.(variant, "load")} />
      <table className="load-profile-points" aria-label={t("editor.load.points")}>
        <thead><tr>{fields.map(field => <th key={field.name} scope="col">
          {field.title} <HelpHint label={field.title}>{field.description}</HelpHint>
          <span className="load-profile-units">{field.units.map(unit => unit.symbol).join(", ")}</span>
        </th>)}<th scope="col" className="load-profile-actions"><span className="sr-only">{t("editor.load.actions")}</span></th></tr></thead>
        <tbody>{points.map((raw, index) => {
          const point = isObject(raw) ? raw : {};
          const path = `load.points.${index}`;
          return <tr key={index} data-inspector-field={path}>
            {fields.map((field, column) => <td key={field.name}>
              <ParamField descriptor={{ ...field, description: "" }} value={point[field.name]} path={`${path}.${field.name}`}
                editable={editable} isOverridden={() => false} onCommit={value => {
                  write(points.map((original, at) => at === index ? { ...point, [field.name]: value } : original));
                }} onValidity={(field, valid) => onValidity(`${clientId}.${field}`, valid)} fieldDiagnostics={fieldDiagnostics}
                variantFieldDiagnostics={variantFieldDiagnostics} onVariantDiagnostic={onVariantDiagnostic} navigationDisabled={invalid} />
              {column === 0 ? <DiagnosticMessages diagnostics={fieldDiagnostics?.get(path)} /> : null}
            </td>)}
            <td><button type="button" disabled={disabled} aria-label={t("editor.load.deletePoint", { number: formatNumber(index + 1) })}
              onClick={() => { if (!disabled) write(points.filter((_, at) => at !== index)); }}>{t("editor.load.delete")}</button></td>
          </tr>;
        })}</tbody>
      </table>
      <button type="button" disabled={disabled} onClick={add}>{t("editor.load.add")}</button>
      {overridden ? <span className="param-badge">{t("editor.param.overridden")}</span> : null}
      {overridden && onReset !== undefined ? <button type="button" className="param-reset" disabled={disabled}
        aria-label={t("editor.param.reset", { title: descriptor.title })} onClick={onReset}>{t("editor.param.useModelValue")}</button> : null}
      {curve.length === 0 ? <p>{t("course.invalidLoad")}</p> : <figure className="load-profile-chart">
        <div className="course-phases">
          {data.warmupMs > 0 ? <span data-phase="warmup" style={{ width: `${data.warmupMs / data.endMs * 100}%` }}>{t("editor.run.warmup")}</span> : null}
          <span data-phase="measurement" style={{ flex: 1 }}>{t("editor.run.measurement")}</span>
        </div>
        <svg viewBox="0 0 300 100" role="img" aria-label={t("course.intensity", { client: clientId })}>
          <rect x="0" y="0" width={x(data.warmupMs)} height="100" fill="#e2e8f0" data-phase="warmup" />
          <rect x={x(data.warmupMs)} y="0" width={300 - x(data.warmupMs)} height="100" fill="#e5f1e9" data-phase="measurement" />
          <polyline points={curve.map(point => `${x(point.timeMs)},${y(point.rate)}`).join(" ")}
            fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          {curve.map(point => <circle key={point.timeMs} cx={x(point.timeMs)} cy={y(point.rate)} r="2" fill="currentColor">
            <title>{t("course.point", { time: formatDuration(point.timeMs / 1000, "s"), rate: formatRate(point.rate) })}</title>
          </circle>)}
          <text x="4" y="12">{formatRate(maximum)}</text>
        </svg>
        <figcaption><span>{formatDuration(0, "s")}</span><span>{formatDuration(data.endMs / 1000, "s")}</span></figcaption>
      </figure>}
    </div>
  </InspectorSection>;
}
