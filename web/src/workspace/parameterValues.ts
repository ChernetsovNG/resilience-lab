import type { Catalog, ParamDescriptor } from "../api/apiTypes";
import { language, t } from "../i18n";
import { catalogOption } from "../i18n/catalog";
import { isObject, type Params } from "./params";
import { parameterApplies } from "./parameterApplicability";

/** Resolve an applicable catalog parameter and its effective value, including defaults along nested paths. */
export function catalogParameter(catalog: Catalog, type: string, params: Params, path: string) {
  const [root, ...fields] = path.split(".");
  let descriptor = catalog.types.find(candidate => candidate.id === type)?.params.find(param => param.name === root);
  if (descriptor === undefined) return undefined;
  let value = params[root] ?? descriptor.default;
  const titles = [descriptor.title];
  for (const field of fields) {
    if (descriptor.kind === "ARRAY" && /^\d+$/.test(field)) {
      value = Array.isArray(value) ? value[Number(field)] : undefined;
      continue;
    }
    const siblings: ParamDescriptor[] = descriptor.fields;
    descriptor = siblings.find(param => param.name === field);
    if (descriptor === undefined || !parameterApplies(descriptor, isObject(value) ? value : {}, siblings)) return undefined;
    value = (isObject(value) ? value[field] : undefined) ?? descriptor.default;
    titles.push(descriptor.title);
  }
  return { descriptor, value, title: titles.join(t("editor.symbols.separator")) };
}

/** Display catalog values without changing the syntax accepted by parameter inputs. */
export function formatParameterValue(value: unknown, descriptor?: ParamDescriptor): string {
  value ??= descriptor?.default;
  if (value == null) return t(descriptor?.required ? "editor.param.required" : "editor.param.notSet");
  if (typeof value === "number") return new Intl.NumberFormat(language, { maximumSignificantDigits: 17 }).format(value);
  if (descriptor?.kind === "CHOICE") return catalogOption(String(value));
  if (Array.isArray(value)) return JSON.stringify(value);
  if (isObject(value)) {
    const current = value;
    const keys = new Set([...(descriptor?.fields.map(field => field.name) ?? []), ...Object.keys(current)]);
    return [...keys].flatMap(key => {
      const child = descriptor?.fields.find(param => param.name === key);
      if (child !== undefined && !parameterApplies(child, current, descriptor?.fields ?? [])) return [];
      if (!Object.hasOwn(current, key) && child?.default == null && !child?.required) return [];
      return [`${child?.title ?? key}: ${formatParameterValue(current[key], child)}`];
    }).join(t("editor.symbols.separator"));
  }
  return String(value);
}
