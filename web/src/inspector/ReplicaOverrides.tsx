import { policyNames } from "../workspace/policyParameters";
import { useState } from "react";
import type { Catalog, Diagnostic, ModelFile } from "../api/apiTypes";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { DiagnosticMessages } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { initialParams } from "../workspace/initialParams";
import { isObject, ownEntry, setField, type Params } from "../workspace/params";
import { reconcileParameter } from "../workspace/parameterApplicability";
import { InspectorSection } from "./InspectorSection";
import { ParamField } from "./ParamField";

/** Sparse structural overrides; every edit changes one document snapshot in the shared history. */
export function ReplicaOverrides({ catalog, model, serviceId, editable, invalid, readOnlyHint, onCommand, onValidity, fieldDiagnostics, replica: selectedReplica }: {
  catalog: Catalog; model: ModelFile; serviceId: string; editable: boolean; invalid: boolean;
  replica?: number;
  readOnlyHint?: string; onCommand: (command: EditorCommand) => void;
  onValidity: (key: string, valid: boolean) => void;
  fieldDiagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}) {
  const [draft, setDraft] = useState("");
  const [parameter, setParameter] = useState("processing");
  const service = model.blocks[serviceId];
  const overrides = service.replicaOverrides ?? {};
  const parameters = catalog.types.find(type => type.id === "service")?.params.filter(param => param.name !== "replicas") ?? [];
  const selected = parameters.find(param => param.name === parameter) ?? parameters[0];
  const initialValue = (descriptor: (typeof parameters)[number]) => policyNames.has(descriptor.name)
    ? descriptor.initial ?? descriptor.default ?? initialParams(descriptor.fields) : initialParams([descriptor])[descriptor.name];
  const count = Number(service.params.replicas ?? 1);
  const entries = Object.entries(overrides).filter(([number]) => selectedReplica === undefined || Number(number) === selectedReplica).sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
  const names = new Set(entries.flatMap(([, params]) => Object.keys(params)));
  const columns = [...parameters.filter(param => names.has(param.name)).map(param => param.name),
    ...[...names].filter(name => !parameters.some(param => param.name === name))];
  let next = 1;
  while (next <= count && Object.hasOwn(overrides, String(next))) next++;
  const replica = draft || String(next);
  const validIndex = (key: string) => /^[1-9]\d*$/.test(key) && Number.isSafeInteger(Number(key)) && Number(key) <= count;
  const disabled = !editable || invalid;
  const canAdd = !disabled && selected !== undefined && validIndex(replica) && !Object.hasOwn(overrides, replica);
  const write = (number: string, update: (current: Params | undefined) => Params | undefined) => {
    if (!editable) return;
    onCommand(documents => {
      const block = documents.model.blocks[serviceId];
      const replicaOverrides = { ...block.replicaOverrides };
      const current = ownEntry(replicaOverrides, number);
      let params = update(current);
      for (const descriptor of parameters) {
        const name = descriptor.name;
        if (descriptor.kind !== "OBJECT" || !isObject(params?.[name])) continue;
        const inherited = block.params[name];
        const group = isObject(inherited) ? inherited : {};
        const effective = (params: Params | undefined) => {
          const own = params?.[name];
          return { ...group, ...(isObject(own) ? own : {}) };
        };
        const after = effective(params);
        const reconciled = reconcileParameter(descriptor, effective(current), after);
        if (reconciled === after || !isObject(reconciled)) continue;
        const patch = { ...reconciled };
        // Replica objects merge with the group; null suppresses an inherited field without changing the group.
        for (const field of Object.keys(group)) if (!Object.hasOwn(patch, field)) patch[field] = null;
        params = { ...params, [name]: patch };
      }
      if (params === undefined || Object.keys(params).length === 0) delete replicaOverrides[number];
      else replicaOverrides[number] = params;
      const updated: typeof block = { ...block, replicaOverrides };
      if (Object.keys(replicaOverrides).length === 0) delete updated.replicaOverrides;
      return { ...documents, model: { ...documents.model, blocks: { ...documents.model.blocks, [serviceId]: updated } } };
    });
  };
  const change = (number: string, path: string, value: unknown) => write(number, current => setField(current ?? {}, path.split("."), value));

  return <InspectorSection name="replicaOverrides" title={<>{t("editor.replicas.title")} <span onClick={event => event.stopPropagation()}>
    <HelpHint label={t("editor.replicas.title")}>{t("editor.replicas.description")}</HelpHint></span></>}>
    <div title={readOnlyHint}>
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("replicaOverrides")} />
      {entries.length === 0 ? <p>{t("editor.replicas.empty")}</p> : <div className="replica-overrides-scroll">
        <table className="replica-overrides-table" aria-label={t("editor.replicas.title")}>
          <thead><tr><th scope="col">{t("editor.replicas.number")}</th>
            {columns.map(name => { const descriptor = parameters.find(param => param.name === name);
              return <th scope="col" key={name}>{descriptor?.title ?? name}
                {descriptor?.description ? <HelpHint label={descriptor.title}>{descriptor.description}</HelpHint> : null}</th>;
            })}
            {selectedReplica === undefined ? <th scope="col">{t("editor.replicas.actions")}</th> : null}
          </tr></thead>
          <tbody>{entries.map(([number, params]) => {
            const path = `replicaOverrides.${number}`;
            const diagnostics = [...(fieldDiagnostics ?? [])].filter(([field]) => field === path || field.startsWith(`${path}.`))
              .flatMap(([, findings]) => findings);
            if (!validIndex(number) && !diagnostics.some(finding => finding.code === "REPLICA_INDEX")) diagnostics.push({
              code: "REPLICA_INDEX", severity: "ERROR", args: { replica: number, service: serviceId, replicas: count },
              message: t("messages.REPLICA_INDEX", { replica: number, service: serviceId, replicas: count }),
            });
            return <tr key={number} data-inspector-field={path} aria-invalid={diagnostics.some(finding => finding.severity === "ERROR") || undefined}>
              <th scope="row">{t("editor.replicas.row", { number })}<DiagnosticMessages diagnostics={diagnostics} /></th>
              {columns.map(name => {
                const descriptor = parameters.find(param => param.name === name);
                const value = ownEntry(params, name);
                const shown = isObject(value) ? { ...(descriptor !== undefined && policyNames.has(name) ? initialParams(descriptor.fields) : {}),
                  ...(isObject(service.params[name]) ? service.params[name] : {}), ...value } : value;
                return <td key={name}>{!Object.hasOwn(params, name) ? t("editor.replicas.inherited") : <>
                  {descriptor === undefined ? <code>{JSON.stringify(value)}</code> : <ParamField descriptor={{ ...descriptor, description: "" }}
                    value={shown} path={`${path}.${name}`} editable={editable} isOverridden={() => false}
                    onCommit={value => change(number, name, value)}
                    onFieldCommit={policyNames.has(name) ? undefined : (field, value) => change(number, field.slice(path.length + 1), value)}
                    onValidity={(field, valid) => onValidity(`${serviceId}.${field}`, valid)} />}
                  {selectedReplica === undefined ? <button type="button" disabled={disabled} aria-label={t("editor.replicas.reset", { parameter: descriptor?.title ?? name, number })}
                    onClick={() => change(number, name, undefined)}>{t("editor.replicas.useGroup")}</button> : null}
                </>}</td>;
              })}
              {selectedReplica === undefined ? <td><select value="" disabled={disabled || parameters.every(param => Object.hasOwn(params, param.name))}
                aria-label={t("editor.replicas.addParameter", { number })} onChange={event => {
                  const descriptor = parameters.find(param => param.name === event.target.value);
                  if (!disabled && descriptor !== undefined) change(number, descriptor.name, initialValue(descriptor));
                }}>
                <option value="" disabled>{t("editor.replicas.parameter")}</option>
                {parameters.filter(param => !Object.hasOwn(params, param.name)).map(param => <option key={param.name} value={param.name}>{param.title}</option>)}
              </select>
                <button type="button" disabled={disabled} aria-label={t("editor.replicas.remove", { number })}
                  onClick={() => write(number, () => undefined)}>{t("editor.replicas.delete")}</button>
              </td> : null}
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {selectedReplica === undefined ? <form className="replica-overrides-add" onSubmit={event => {
        event.preventDefault();
        if (!canAdd) return;
        write(replica, current => current ?? { [selected.name]: initialValue(selected) });
        setDraft("");
      }}>
        <label>{t("editor.replicas.number")}<input type="number" min={1} max={count} step={1} value={replica}
          readOnly={!editable} aria-invalid={!validIndex(replica) || Object.hasOwn(overrides, replica) || undefined}
          onChange={event => setDraft(event.target.value)} /></label>
        <label>{t("editor.replicas.newParameter")}<select value={selected?.name ?? ""} disabled={disabled}
          onChange={event => setParameter(event.target.value)}>
          {parameters.map(param => <option key={param.name} value={param.name}>{param.title}</option>)}
        </select></label>
        <button type="submit" disabled={!canAdd}>{t("editor.replicas.add")}</button>
      </form> : null}
    </div>
  </InspectorSection>;
}
