import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Catalog, ParamDescriptor } from "../api/apiTypes";
import { t } from "../i18n";
import { formatParameterValue } from "../workspace/parameterValues";

function parameterRows(params: ParamDescriptor[], depth = 0, parent = ""): { descriptor: ParamDescriptor; depth: number; path: string }[] {
  return params.flatMap(descriptor => {
    const path = parent + descriptor.name;
    return [{ descriptor, depth, path }, ...parameterRows(descriptor.fields, depth + 1, path + ".")];
  });
}

function bounds(descriptor: ParamDescriptor): string {
  const unit = descriptor.units[0];
  const value = (bound: number) => formatParameterValue(unit == null ? bound : bound * unit.denominator / unit.numerator)
    + (unit == null ? "" : " " + unit.symbol);
  return [
    descriptor.minimum == null ? null : "≥ " + value(descriptor.minimum),
    descriptor.exclusiveMinimum == null ? null : "> " + value(descriptor.exclusiveMinimum),
    descriptor.maximum == null ? null : "≤ " + value(descriptor.maximum),
  ].filter(part => part !== null).join("; ") || t("help.noValue");
}

/** Catalog-backed help for any block or connection, including nested object and array parameters. */
export function TypeHelp({ catalog, typeId, children }: { catalog: Catalog; typeId: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const type = catalog.types.find(candidate => candidate.id === typeId);
  const label = t("help.type.open", { type: type?.title ?? typeId });
  const close = () => { setOpen(false); button.current?.focus(); };
  return <>
    <button ref={button} type="button" className="help-hint-button type-help-button" aria-label={children == null ? label : undefined}
      title={label} onClick={() => setOpen(true)}>{children ?? t("help.symbol")}</button>
    {open ? <TypeHelpDialog catalog={catalog} typeId={typeId} onClose={close} /> : null}
  </>;
}

function TypeHelpDialog({ catalog, typeId, onClose }: { catalog: Catalog; typeId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const type = catalog.types.find(candidate => candidate.id === typeId);
  useEffect(() => {
    if (dialog.current?.showModal) dialog.current.showModal();
    else dialog.current?.setAttribute("open", "");
  }, []);
  const close = () => { dialog.current?.close?.(); onClose(); };
  return <dialog ref={dialog} className="type-help-dialog" aria-labelledby={titleId}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 id={titleId}>{type?.title ?? t("help.type.title")}</h2>
      <button type="button" onClick={close} autoFocus>{t("help.type.close")}</button>
    </header>
    {type === undefined ? <p>{t("help.type.unknown", { type: typeId })}</p> : <>
      <p>{type.description}</p>
      <h3>{t("help.parameters")}</h3>
      {type.params.length === 0 ? <p>{t("editor.inspector.noParameters")}</p> : <div className="type-help-table">
        <table aria-label={t("help.parameters")}>
          <thead><tr>{["parameter", "description", "units", "default", "bounds"].map(key => <th key={key} scope="col">{t("help." + key)}</th>)}</tr></thead>
          <tbody>{parameterRows(type.params).map(({ descriptor, depth, path }) => <tr key={path}>
            <th scope="row" style={{ paddingInlineStart: (0.5 + depth * 1.25) + "rem" }}>{descriptor.title}</th>
            <td>{descriptor.description}{descriptor.options.length === 0 ? null : <p>{t("help.choices", { values: descriptor.options.map(option => formatParameterValue(option, descriptor)).join(", ") })}</p>}</td>
            <td>{descriptor.units.map(unit => unit.symbol).join(", ") || t("help.noValue")}</td>
            <td>{formatParameterValue(descriptor.default, descriptor)}</td>
            <td>{bounds(descriptor)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <h3>{t("help.assumptions")}</h3>
      {type.assumptions.length === 0 ? <p>{t("help.noAssumptions")}</p> : <ul>{type.assumptions.map(assumption => <li key={assumption}>{assumption}</li>)}</ul>}
      <h3>{t("help.outputs")}</h3>
      {type.outputs.length === 0 ? <p>{t("help.noOutputs")}</p> : <dl className="type-help-outputs">
        {type.outputs.map(output => <div key={output.id}><dt>{output.title}</dt><dd>{output.description}</dd></div>)}
      </dl>}
    </>}
  </dialog>;
}
