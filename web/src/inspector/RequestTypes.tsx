import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { useBeforeUnload } from "../components/useBeforeUnload";
import { sumLoadProfiles } from "../experiment/course";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { DiagnosticMessages, VariantDiagnosticLinks } from "../validation/DiagnosticDisplay";
import type { EditorCommand } from "../workspace/editor";
import { isObject } from "../workspace/params";
import { editRequestTypes, nextRequestTypeId, renameRequestType, requestTypeRenameError, resetClientLoad, switchClientLoad } from "../workspace/requestTypes";
import { InspectorSection } from "./InspectorSection";
import { LoadProfile } from "./LoadProfile";

type Props = ComponentProps<typeof LoadProfile> & { onCommand?: (command: EditorCommand) => void; variantId: string | null };

function RequestTypeIdentifier({ types, index, editable, onRename, onValidity, clientId, errorFor }: {
  types: unknown[]; index: number; editable: boolean; clientId: string;
  onRename: (value: string) => void; onValidity: Props["onValidity"];
  errorFor: (value: string) => string | null;
}) {
  const input = useId();
  const value = isObject(types[index]) && typeof types[index].id === "string" ? types[index].id : "";
  const [draft, setDraft] = useState(value);
  const [previous, setPrevious] = useState(value);
  if (previous !== value) { setPrevious(value); setDraft(value); }
  const error = editable ? errorFor(draft) : null;
  const path = `${clientId}.classes.${index}.id`;
  const validity = useRef(onValidity);
  useEffect(() => { validity.current = onValidity; }, [onValidity]);
  useEffect(() => { validity.current(path, error === null || draft === value); }, [path, error, draft, value]);
  useEffect(() => () => validity.current(path, true), [path]);
  useBeforeUnload(editable && draft !== value);
  const commit = () => { if (editable && error === null && draft !== value) onRename(draft); };
  return <div className="param-field" data-inspector-field={`classes.${index}.id`}>
    <label htmlFor={input}>{t("editor.requestTypes.id")}</label>
    <input id={input} value={draft} readOnly={!editable} aria-invalid={error !== null}
      aria-describedby={error === null ? undefined : `${input}-error`} onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(value); }
      }} />
    {error === null ? null : <span id={`${input}-error`} className="param-error" role="alert">{error}</span>}
  </div>;
}

/** A client's mutually exclusive load representations share one section and the existing profile editor. */
export function RequestTypes(props: Props) {
  const { model, clientId, catalog, editable, invalid, onCommand, variantId, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic } = props;
  const group = useId();
  const raw = model.blocks[clientId].params.classes;
  const multiple = raw != null;
  const types: unknown[] = Array.isArray(raw) ? raw : [];
  const disabled = !editable || invalid || onCommand === undefined;
  const cannotCombine = multiple && (!Array.isArray(raw) || sumLoadProfiles(types.map(value => isObject(value) ? value.load : undefined), catalog) === null);
  const write = (next: unknown[]) => { if (!disabled) onCommand?.(editRequestTypes(clientId, next, catalog, variantId)); };
  const reset = variantId === null ? undefined : () => onCommand?.(resetClientLoad(clientId, variantId, catalog));
  const move = (index: number, offset: number) => {
    const next = [...types];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    write(next);
  };
  return <InspectorSection name="load" title={<>{t("editor.load.title")} <span onClick={event => event.stopPropagation()}>
    <HelpHint label={t("editor.load.title")}>{props.descriptor.description}</HelpHint></span></>}>
    <div className="request-load-mode" role="radiogroup" aria-label={t("editor.requestTypes.mode")}>
      {[false, true].map(value => <label key={String(value)}>
        <input type="radio" name={group} checked={multiple === value} disabled={disabled || (!value && cannotCombine)}
          onChange={() => onCommand?.(switchClientLoad(clientId, value, catalog, variantId))} />
        {t(value ? "editor.requestTypes.multiple" : "editor.requestTypes.single")}
      </label>)}
      {cannotCombine ? <HelpHint label={t("editor.requestTypes.single")}>{t("editor.requestTypes.invalidSum")}</HelpHint> : null}
    </div>
    {!multiple ? <LoadProfile {...props} embedded onReset={reset} /> : <div data-inspector-field="classes">
      <DiagnosticMessages diagnostics={fieldDiagnostics?.get("classes")} />
      <VariantDiagnosticLinks diagnostics={variantFieldDiagnostics?.get("classes")} disabled={invalid}
        onSelect={variant => onVariantDiagnostic?.(variant, "classes")} />
      {Array.isArray(raw) ? null : <pre className="request-types-invalid" aria-label={t("editor.requestTypes.invalid")}>{JSON.stringify(raw, null, 2)}</pre>}
      {types.map((raw, index) => {
        const value = isObject(raw) ? raw : {};
        const id = typeof value.id === "string" ? value.id : String(index + 1);
        const path = `classes.${index}`;
        return <fieldset className="request-type" key={index} aria-label={id} data-inspector-field={path}>
          <legend>{id}</legend>
          {isObject(raw) ? null : <pre className="request-types-invalid" aria-label={t("editor.requestTypes.invalid")}>{JSON.stringify(raw, null, 2)}</pre>}
          <RequestTypeIdentifier types={types} index={index} clientId={clientId} editable={editable && onCommand !== undefined}
            errorFor={next => requestTypeRenameError(model, props.experiment, clientId, index, next, variantId)}
            onValidity={props.onValidity} onRename={next => onCommand?.(renameRequestType(clientId, index, next, catalog, variantId))} />
          <DiagnosticMessages diagnostics={fieldDiagnostics?.get(`${path}.id`)} />
          <DiagnosticMessages diagnostics={fieldDiagnostics?.get(path)} />
          <div className="request-type-actions">
            <button type="button" disabled={disabled || index === 0} aria-label={t("editor.requestTypes.up", { id })} onClick={() => move(index, -1)}>{t("editor.requestTypes.moveUp")}</button>
            <button type="button" disabled={disabled || index === types.length - 1} aria-label={t("editor.requestTypes.down", { id })} onClick={() => move(index, 1)}>{t("editor.requestTypes.moveDown")}</button>
            <button type="button" disabled={disabled} aria-label={t("editor.requestTypes.remove", { id })} onClick={() => write(types.filter((_, at) => at !== index))}>{t("editor.load.delete")}</button>
          </div>
          <LoadProfile {...props} embedded overridden={false} onReset={undefined} value={value.load} path={`${path}.load`} label={t("course.requestType", { client: clientId, id })}
            onCommit={load => {
              if (editable) onCommand?.(editRequestTypes(clientId, types.map((original, at) => at === index ? { ...value, load } : original), catalog, variantId));
            }} />
        </fieldset>;
      })}
      <button type="button" disabled={disabled} onClick={() => {
        const last = types.at(-1);
        write([...types, { id: nextRequestTypeId(types), load: isObject(last) ? last.load : props.descriptor.initial }]);
      }}>{t(Array.isArray(raw) ? "editor.requestTypes.add" : "editor.requestTypes.replaceInvalid")}</button>
      {props.overridden && reset !== undefined ? <button type="button" className="param-reset" disabled={disabled}
        aria-label={t("editor.requestTypes.reset")} onClick={reset}>{t("editor.param.useModelValue")}</button> : null}
    </div>}
  </InspectorSection>;
}
