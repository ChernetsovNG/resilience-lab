import { Icon } from "../layout/Icon";
import { useId } from "react";
import { t } from "../i18n";
import { elementLabel } from "../presentation/labels";
import { HelpHint } from "../help/HelpHint";
import { formatNumber } from "../i18n/format";
import type { Catalog, Diagnostic, ExperimentFile, ModelFile, ParamDescriptor } from "../api/apiTypes";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { addFault, removeFault, replaceFault, setExecutionParam, setFaultParam } from "../workspace/experimentCommands";
import { createFault, faultKinds, faultTargets, initialFaultFields } from "../workspace/faults";
import { canonicalOf } from "../workspace/quantities";
import { ParamField } from "./ParamField";
import { GridSettings } from "./GridSettings";
import { InspectorSection } from "./InspectorSection";
import { ReplicaTargetField } from "./ReplicaTargetField";

interface Props {
  catalog: Catalog;
  model: ModelFile;
  experiment: ExperimentFile;
  editable: boolean;
  invalid: boolean;
  onCommand: (command: EditorCommand) => void;
  onValidity: (path: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

function allParams(catalog: Catalog): ParamDescriptor[] {
  const flatten = (params: ParamDescriptor[]): ParamDescriptor[] => params.flatMap((param) => [param, ...flatten(param.fields)]);
  return flatten(catalog.types.flatMap((type) => type.params));
}

/** Execution and fault field units come from catalog dimensions, including their conversion scales. */
function descriptor(catalog: Catalog, name: string, title: string, kind: ParamDescriptor["kind"], extra: Partial<ParamDescriptor> = {}): ParamDescriptor {
  const units = allParams(catalog).find((param) => param.dimension === extra.dimension)?.units ?? [];
  return { name, title, kind, description: "", required: true, options: [], fields: [], sweepable: false, units, ...extra };
}

/** Shared experiment settings are editable on every model or variant page. */
export function RunSettings({ catalog, model, experiment, editable, invalid, onCommand, onValidity, fieldDiagnostics }: Props) {
  const id = useId();
  const targets = faultTargets(model, catalog, experiment.faults.map(fault => fault.target));
  const duration = (name: string, title: string, positive = false) => descriptor(catalog, name, title, "QUANTITY", {
    dimension: "DURATION", ...(positive ? { exclusiveMinimum: 0 } : { minimum: 0 }),
  });
  const seriesWindow = { ...duration("window", t("editor.run.seriesWindow"), true), required: false };
  const measurement = canonicalOf(experiment.execution.measurement, seriesWindow.units);
  const unit = seriesWindow.units[0];
  if (measurement !== null && unit !== undefined) {
    seriesWindow.default = `${((measurement / 100) * unit.denominator) / unit.numerator}${unit.symbol}`;
  }
  const executionFields = [
    descriptor(catalog, "replications", t("editor.run.replications"), "INTEGER", { minimum: 1, maximum: 2_147_483_647 }),
    duration("warmup", t("editor.run.warmup")), duration("measurement", t("editor.run.measurement"), true),
    seriesWindow,
    descriptor(catalog, "seed", t("editor.run.seed"), "INTEGER", { minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    duration("maxRealTime", t("editor.run.realTimeLimit"), true),
  ].map(field => ({ ...field, description: t(`editor.run.${field.name}.description`) }));
  const faultFields = (fault: ExperimentFile["faults"][number]) => {
    const target = targets.find(target => target.id === fault.target);
    const timing = target?.connection ? "network" : "processing";
    return [
    duration("from", t("editor.fault.start")), duration("to", t("editor.fault.end"), true),
    ...(fault.kind === "slowdown" ? [
      descriptor(catalog, "multiplier", t(`editor.fault.multiplier.${timing}`), "NUMBER", { required: false, exclusiveMinimum: 0 }),
      { ...duration("delay", t(`editor.fault.delay.${timing}`)), required: false },
    ] : []),
    ...(fault.kind === "errors" ? [descriptor(catalog, "failureRate", t("editor.fault.failureRate"), "QUANTITY", {
      dimension: "PROBABILITY", minimum: 0, maximum: 1,
    })] : []),
    ...(fault.kind === "capacityLoss" ? [descriptor(catalog, "capacity", t(`editor.fault.capacity.${target?.connection ? "call" : target?.type ?? "call"}`), "INTEGER", {
      minimum: 0, maximum: target?.capacity ?? undefined,
    })] : []),
  ].map(field => ({ ...field, description: t(`editor.fault.${field.name}.description`) }));
  };
  return (
    <>
      <InspectorSection name="execution" title={<h3>{t("editor.run.execution")}</h3>}>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("execution")} />
      <p className="inspector-type">{t("editor.run.shared")}</p>
      {executionFields.map((field) => (
        <ParamField key={field.name} descriptor={field} value={experiment.execution[field.name as keyof ExperimentFile["execution"]]}
          path={`execution.${field.name}`} editable={editable} isOverridden={() => false} onValidity={onValidity}
          fieldDiagnostics={fieldDiagnostics}
          inputAction={field.name === "seed" ? <button type="button" className="seed-random"
            aria-label={t("editor.run.randomSeed")} title={t("editor.run.randomSeed")} disabled={!editable}
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              const words = crypto.getRandomValues(new Uint32Array(2));
              // Keep 21 + 32 independent random bits: every safe nonnegative integer has equal probability.
              onCommand(setExecutionParam("seed", (words[0] & 0x1f_ffff) * 2 ** 32 + words[1]));
            }}>
            <Icon name="dice" />
          </button> : undefined}
          onCommit={(value) => onCommand(setExecutionParam(field.name as keyof ExperimentFile["execution"], value as string | number | undefined))} />
      ))}
      </InspectorSection>
      <InspectorSection name="faults" title={<h3>{t("editor.fault.title")}</h3>}>
      <div data-inspector-field="faults">
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("faults")} />
      {experiment.faults.length === 0 ? <p>{t("editor.fault.none")}</p> : null}
      {experiment.faults.map((fault, index) => {
        const target = targets.find(target => target.id === fault.target);
        const kindKnown = faultKinds.some(kind => kind === fault.kind);
        const targetId = `${id}-${index}-target`;
        const kindId = `${id}-${index}-kind`;
        return (
        <fieldset className="param-group" key={index} data-inspector-field={`faults.${index}`}>
          <legend>{t("editor.fault.number", { number: formatNumber(index + 1) })}</legend>
          <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`faults.${index}`)} />
          <div className="param-field" data-inspector-field={`faults.${index}.target`}>
            <div className="param-field-label"><label htmlFor={targetId}>{t("editor.fault.target")}</label>
              <HelpHint id={`${targetId}-help`} label={t("editor.fault.target")}>{t("editor.fault.target.description")}</HelpHint></div>
            <select id={targetId} value={fault.target} title={elementLabel(fault.target, model)} disabled={!editable || invalid} aria-describedby={`${targetId}-help`} onChange={(event) => {
              const next = targets.find(target => target.id === event.target.value);
              if (next !== undefined && (fault.kind !== "capacityLoss" || next.capacity !== null)) onCommand(setFaultParam(index, "target", next.id));
            }}>
              {target === undefined ? <option value={fault.target} disabled>{elementLabel(fault.target, model)}</option> : null}
              {targets.map(target => <option key={target.id} value={target.id}
                disabled={fault.kind === "capacityLoss" && target.capacity === null}>{elementLabel(target.id, model)}</option>)}
            </select>
            <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`faults.${index}.target`)} />
          </div>
          <ReplicaTargetField target={target ?? targets.find(target => target.id === fault.target.slice(0, fault.target.lastIndexOf("#")))}
            value={fault.target} path={`faults.${index}.replica`} editable={editable} onValidity={onValidity}
            onTarget={target => onCommand(setFaultParam(index, "target", target))} />
          <div className="param-field" data-inspector-field={`faults.${index}.kind`}>
            <div className="param-field-label"><label htmlFor={kindId}>{t("editor.fault.kind")}</label>
              {kindKnown ? <HelpHint id={`${kindId}-help`} label={t("editor.fault.kind")}>{t(`editor.fault.kind.${fault.kind}.description`)}</HelpHint> : null}</div>
            <select id={kindId} value={fault.kind} disabled={!editable || invalid} aria-describedby={kindKnown ? `${kindId}-help` : undefined} onChange={event => {
              const kind = event.target.value;
              if (!faultKinds.some(candidate => candidate === kind) || (kind === "capacityLoss" && target?.capacity == null)) return;
              const { target: targetId, from, to } = fault;
              onCommand(replaceFault(index, { target: targetId, from, to, kind, ...initialFaultFields(kind, target) }));
            }}>
              {kindKnown ? null : <option value={fault.kind} disabled>{fault.kind}</option>}
              {faultKinds.map(kind => <option key={kind} value={kind} disabled={kind === "capacityLoss" && target?.capacity == null}>{t(`faults.kinds.${kind}`)}</option>)}
            </select>
            <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`faults.${index}.kind`)} />
          </div>
          {faultFields(fault).map((field) => (
            <ParamField key={field.name} descriptor={field} value={fault[field.name as keyof typeof fault]}
              path={`faults.${index}.${field.name}`} editable={editable} isOverridden={() => false} onValidity={onValidity}
              fieldDiagnostics={fieldDiagnostics}
              onCommit={(value) => onCommand(setFaultParam(index, field.name as keyof typeof fault, value as string | number | undefined))} />
          ))}
          <button type="button" aria-label={t("editor.fault.removeLabel", { number: formatNumber(index + 1) })} disabled={!editable || invalid}
            onClick={() => onCommand(removeFault(index))}>{t("editor.fault.remove")}</button>
        </fieldset>
      ); })}
      <button type="button" disabled={!editable || invalid || targets.length === 0 || createFault(catalog, experiment, targets[0]) === null} onClick={() => {
        const fault = createFault(catalog, experiment, targets[0]);
        if (fault !== null) onCommand(addFault(fault));
      }}>{t("editor.fault.add")}</button>
      </div>
      </InspectorSection>
      <GridSettings catalog={catalog} model={model} experiment={experiment} editable={editable} invalid={invalid}
        onCommand={onCommand} onValidity={onValidity} fieldDiagnostics={fieldDiagnostics} />
    </>
  );
}
