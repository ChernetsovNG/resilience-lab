import { useId, useState } from "react";
import type { ParamDescriptor } from "../api/apiTypes";
import { HelpHint } from "../help/HelpHint";
import { t } from "../i18n";
import { resetVariantParam, setVariantParam } from "../workspace/experimentCommands";
import { initialParams } from "../workspace/initialParams";
import { elementOf, isObject, isOverridden, ownEntry } from "../workspace/params";
import { policyNames } from "../workspace/policyParameters";
import type { InspectorProps } from "./Inspector";
import { ParamField } from "./ParamField";

type Props = Pick<InspectorProps, "catalog" | "model" | "baseModel" | "experiment" | "editable" | "invalid" | "variantId"
  | "overrides" | "onParam" | "onCommand" | "onValidity" | "fieldDiagnostics" | "variantFieldDiagnostics" | "onVariantDiagnostic">
  & { selected: string };

const order = ["retryBudget", "circuitBreaker", "fallback", "outlierDetection", "rateLimit", "healthCheck"];

/** Optional policy sections, ordered by their place in a call, with catalog-driven object fields. */
export function Policies({ catalog, model, baseModel = model, experiment, selected, editable, invalid = false, variantId = null,
  overrides, onParam, onCommand, onValidity, fieldDiagnostics, variantFieldDiagnostics, onVariantDiagnostic }: Props) {
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const element = elementOf(model, selected);
  const descriptors = catalog.types.find(type => type.id === element?.type)?.params.filter(param => policyNames.has(param.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) ?? [];
  if (element === null || descriptors.length === 0) return null;
  const connection = model.connections.find(edge => edge.id === selected);
  const target = connection === undefined ? undefined : ownEntry(model.blocks, connection.to);
  const disabled = !editable || invalid || (variantId !== null && onCommand === undefined);
  const reason = (descriptor: ParamDescriptor) => isObject(element.params[descriptor.name]) ? t("editor.policies.alreadyAdded")
    : descriptor.name === "outlierDetection" && connection?.type === "call" && !(target?.type === "service" && Number(target.params.replicas ?? 1) > 1)
      ? t("editor.policies.replicaGroupOnly") : null;
  const enabled = descriptors.filter(descriptor => isObject(element.params[descriptor.name]) || overrides[`${selected}.${descriptor.name}`] === null);
  const commit = (name: string, value: unknown) => {
    if (variantId === null) onParam(selected, name, value);
    else onCommand?.(setVariantParam(variantId, selected, name, value, catalog));
  };
  const restore = (name: string) => {
    if (variantId !== null) onCommand?.(resetVariantParam(variantId, selected, name, catalog));
  };
  const noAvailable = descriptors.every(descriptor => reason(descriptor) !== null);
  return <div className="policy-editor" onKeyDown={event => {
    if (event.key === "Escape") { setMenuOpen(false); event.stopPropagation(); }
  }}>
    {element.type === "call" && enabled.length > 0 ? <HelpHint label={t("editor.policies.order")}>{t("editor.policies.callOrder")}</HelpHint> : null}
    {enabled.map(descriptor => {
      const removed = element.params[descriptor.name] == null;
      const overridden = isOverridden(overrides, selected, descriptor.name);
      return <details className="policy-section" data-policy={descriptor.name} data-inspector-field={removed ? descriptor.name : undefined}
        key={descriptor.name} open={!removed}>
        <summary>{descriptor.title}{removed ? <>
          <span className="param-badge">{t("editor.policies.removed")}</span>
          <button type="button" disabled={disabled} onClick={event => {
            event.preventDefault(); restore(descriptor.name);
          }}>{t("editor.policies.restore")}</button>
        </> : null}</summary>
        {removed ? null : <>
          <ParamField descriptor={{ ...descriptor, description: `${descriptor.description} ${t(`editor.policies.state.${descriptor.name}`)}` }}
            value={element.params[descriptor.name]} path={descriptor.name} editable={editable}
            isOverridden={path => isOverridden(overrides, selected, path)}
            isSwept={path => variantId !== null && (experiment.grid ?? []).some(axis => axis.path === `${selected}.${path}` || axis.path.startsWith(`${selected}.${path}.`))}
            onCommit={value => commit(descriptor.name, value)} onValidity={(path, valid) => onValidity(`${selected}.${path}`, valid)}
            fieldDiagnostics={fieldDiagnostics} variantFieldDiagnostics={variantId === null ? variantFieldDiagnostics : undefined}
            onVariantDiagnostic={onVariantDiagnostic} navigationDisabled={invalid} />
          <div className="policy-actions">
            {variantId !== null && overridden ? <button type="button" disabled={disabled}
              aria-label={t("editor.param.reset", { title: descriptor.title })} onClick={() => restore(descriptor.name)}>{t("editor.param.useModelValue")}</button> : null}
            <button type="button" disabled={disabled} onClick={() => {
              if (variantId !== null && !isObject(elementOf(baseModel, selected)?.params[descriptor.name])) restore(descriptor.name);
              else commit(descriptor.name, variantId === null ? undefined : null);
            }}>{t("editor.policies.remove")}</button>
          </div>
        </>}
      </details>;
    })}
    <div className="policy-actions"><button type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId}
      disabled={disabled || noAvailable} title={noAvailable ? t("editor.policies.noneAvailable") : undefined}
      onClick={() => setMenuOpen(open => !open)}>{t("editor.policies.add")}</button>
      {noAvailable ? <HelpHint label={t("editor.policies.add")}>{t("editor.policies.noneAvailable")}</HelpHint> : null}</div>
    {menuOpen ? <div id={menuId} role="menu" aria-label={t("editor.policies.menu")} className="policy-menu">
      {descriptors.map(descriptor => {
        const unavailable = reason(descriptor);
        return <button type="button" role="menuitem" key={descriptor.name} disabled={disabled || unavailable !== null}
          onClick={() => {
            if (disabled || unavailable !== null) return;
            commit(descriptor.name, descriptor.initial ?? descriptor.default ?? initialParams(descriptor.fields));
            setMenuOpen(false);
          }}>{descriptor.title}{unavailable === null ? null : <span>{unavailable}</span>}</button>;
      })}
    </div> : null}
  </div>;
}
