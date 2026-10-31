import { useRef } from "react";
import type { BlockInstance, Catalog, Diagnostic, ModelFile } from "../api/apiTypes";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { initialParams } from "../workspace/initialParams";
import { InspectorSection } from "./InspectorSection";
import { ParamField } from "./ParamField";

type Step = NonNullable<BlockInstance["scenario"]>[number];

/** Service structure: omitted process fields inherit service parameters; each change is one editor command. */
export function ServiceScenario({ catalog, model, serviceId, editable, invalid, readOnlyHint, onCommand, onValidity, fieldDiagnostics }: {
  catalog: Catalog;
  model: ModelFile;
  serviceId: string;
  editable: boolean;
  invalid: boolean;
  readOnlyHint?: string;
  onCommand: (command: EditorCommand) => void;
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}) {
  const list = useRef<HTMLOListElement>(null);
  const service = model.blocks[serviceId];
  // Match core String ordering, independently of the interface locale and document connection order.
  const outgoing = model.connections.filter(edge => edge.from === serviceId && edge.type === "call")
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const implicit = service.scenario == null;
  const steps: Step[] = service.scenario ?? [{ type: "process" }, ...outgoing.map(edge => ({ type: "call", connection: edge.id }))];
  const canEdit = editable && !implicit;
  const disabled = !canEdit || invalid;
  const parameters = catalog.types.find(type => type.id === "service")?.params
    .filter(param => param.name === "processing" || param.name === "failureRate") ?? [];
  const write = (next: Step[]) => {
    if (!editable) return;
    onCommand(documents => {
      const block = { ...documents.model.blocks[serviceId] };
      if (next.length === 0) delete block.scenario;
      else block.scenario = next;
      return { ...documents, model: { ...documents.model, blocks: { ...documents.model.blocks, [serviceId]: block } } };
    });
  };
  const replace = (index: number, next: Step) => write(steps.map((step, at) => at === index ? next : step));
  const setParam = (index: number, name: string, value: unknown) => {
    const next = { ...steps[index] };
    if (value == null) delete next[name as "processing" | "failureRate"];
    else Object.assign(next, { [name]: value });
    replace(index, next);
  };
  const newStep = (type: string): Step => type === "call" ? { type, connection: outgoing[0].id } : { type };
  const move = (index: number, to: number) => {
    if (disabled || to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    write(next);
    requestAnimationFrame(() => list.current?.children[to]?.querySelector<HTMLSelectElement>("select")?.focus());
  };

  return <InspectorSection name="scenario" title={<>{t("editor.scenario.title")} <span onClick={event => event.stopPropagation()}>
    <HelpHint label={t("editor.scenario.title")}>{t("editor.scenario.description")}</HelpHint></span></>}>
    <div title={readOnlyHint}>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("scenario")} />
      {implicit ? <button type="button" disabled={!editable || invalid} onClick={() => write(steps)}>
        {t("editor.scenario.customize")}</button> : null}
      <ol className="scenario-steps" ref={list}>
        {steps.map((step, index) => {
          const path = `scenario.${index}`;
          const diagnostics = [...(fieldDiagnostics ?? [])].filter(([field]) => field === path || field.startsWith(`${path}.`))
            .flatMap(([, findings]) => findings);
          return <li key={index}>
            <fieldset className="param-group scenario-step" data-inspector-field={path} onKeyDown={event => {
              if (!disabled && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                event.preventDefault();
                event.stopPropagation();
                const direction = event.key === "ArrowUp" ? "up" : "down";
                if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
                  const button = event.currentTarget.querySelector<HTMLButtonElement>(`[data-scenario-move="${direction}"]`);
                  // Blur commits the draft; the next frame's button handler sees the updated document.
                  event.target.blur();
                  requestAnimationFrame(() => button?.click());
                } else move(index, index + (direction === "up" ? -1 : 1));
              }
            }}>
              <legend>{t("editor.scenario.step", { number: formatNumber(index + 1) })}</legend>
              <label className="param-field" data-inspector-field={`${path}.type`}>{t("editor.scenario.type")}
                <select value={step.type} disabled={disabled} onChange={event => {
                  if (!disabled) replace(index, newStep(event.target.value));
                }}>
                  {step.type === "process" || step.type === "call" ? null : <option value={step.type} disabled>{step.type}</option>}
                  <option value="process">{t("editor.scenario.process")}</option>
                  <option value="call" disabled={outgoing.length === 0}>{t("editor.scenario.call")}</option>
                </select>
              </label>
              {step.type === "call" ? <label className="param-field" data-inspector-field={`${path}.connection`}>
                {t("editor.scenario.connection")}
                <select value={step.connection ?? ""} disabled={disabled}
                  aria-invalid={diagnostics.some(finding => finding.severity === "ERROR") || undefined}
                  onChange={event => { if (!disabled) replace(index, { ...step, connection: event.target.value }); }}>
                  {outgoing.some(edge => edge.id === step.connection) ? null
                    : <option value={step.connection ?? ""} disabled>{step.connection || t("editor.param.select")}</option>}
                  {outgoing.map(edge => <option key={edge.id} value={edge.id}>{edge.id}</option>)}
                </select>
              </label> : null}
              {step.type === "process" ? parameters.map(descriptor => {
                const name = descriptor.name as "processing" | "failureRate";
                const own = step[name] != null;
                const title = t(`editor.scenario.own.${name}`);
                return <div key={name}>
                  <div className="scenario-override">
                    <label><input type="checkbox" checked={own} disabled={disabled} onChange={event => {
                      if (!disabled) setParam(index, name, event.target.checked ? initialParams([descriptor])[name] : undefined);
                    }} />{title}</label>
                    <HelpHint label={title}>{t("editor.scenario.inherit")}</HelpHint>
                  </div>
                  {own ? <ParamField descriptor={descriptor} value={step[name]} path={`${path}.${name}`}
                    editable={canEdit} isOverridden={() => false} onCommit={value => setParam(index, name, value)}
                    onValidity={(field, valid) => onValidity(`${serviceId}.${field}`, valid)} /> : null}
                </div>;
              }) : null}
              <DiagnosticMessages diagnostics={diagnostics} />
              {!implicit ? <div className="scenario-actions">
                <button type="button" data-scenario-move="up" disabled={disabled || index === 0} onClick={() => move(index, index - 1)}>{t("editor.scenario.up")}</button>
                <button type="button" data-scenario-move="down" disabled={disabled || index === steps.length - 1} onClick={() => move(index, index + 1)}>{t("editor.scenario.down")}</button>
                <button type="button" disabled={disabled} onClick={() => write(steps.filter((_, at) => at !== index))}>{t("editor.scenario.delete")}</button>
              </div> : null}
            </fieldset>
          </li>;
        })}
      </ol>
      {!implicit ? <div className="scenario-actions">
        <button type="button" disabled={disabled} onClick={() => write([...steps, newStep("process")])}>{t("editor.scenario.addProcess")}</button>
        <button type="button" disabled={disabled || outgoing.length === 0} onClick={() => write([...steps, newStep("call")])}>{t("editor.scenario.addCall")}</button>
      </div> : null}
    </div>
  </InspectorSection>;
}
