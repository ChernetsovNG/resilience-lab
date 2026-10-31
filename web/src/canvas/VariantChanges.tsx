import type { Catalog, ModelFile } from "../api/apiTypes";
import { t } from "../i18n";
import { applyOverrides, elementOf, type Params } from "../workspace/params";
import { catalogParameter, formatParameterValue } from "../workspace/parameterValues";

export interface VariantChangesProps {
  model: ModelFile;
  catalog: Catalog;
  overrides: Params;
  disabled?: boolean;
  onSelect?: (id: string, path: string) => void;
}

/** The same recorded overrides on the variant canvas and in its Inspector properties. */
export function VariantChanges({ model, catalog, overrides, disabled = false, onSelect }: VariantChangesProps) {
  const effective = applyOverrides(model, overrides, catalog);
  return <section className="variant-changes" aria-label={t("editor.variant.changes")}>
    {Object.keys(overrides).length === 0 ? <p>{t("editor.variant.sameAsModel")}</p> : <ul>
      {Object.keys(overrides).map(key => {
        const [id, ...fields] = key.split(".");
        const path = fields.join(".");
        const element = elementOf(model, id);
        const current = elementOf(effective, id);
        const before = element === null ? undefined : catalogParameter(catalog, element.type, element.params, path);
        const after = current === null ? undefined : catalogParameter(catalog, current.type, current.params, path);
        return <li key={key}><button type="button" disabled={disabled || element === null || after === undefined}
          onClick={() => onSelect?.(id, path)}>
          {t("editor.variant.change", { element: id, parameter: after?.title ?? before?.title ?? path,
            model: formatParameterValue(before?.value, before?.descriptor),
            variant: formatParameterValue(after?.value ?? overrides[key], after?.descriptor) })}
        </button></li>;
      })}
    </ul>}
  </section>;
}
