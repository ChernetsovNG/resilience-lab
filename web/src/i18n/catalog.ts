import type { Catalog, ParamDescriptor } from "../api/apiTypes";
import { catalogs, language, t, type Language } from "./index";

/** API prose remains the fallback until a language catalog supplies a matching stable identifier. */
export function catalogText(key: string, fallback: string, locale: Language = language): string {
  return Object.hasOwn(catalogs[locale], key) ? t(key, {}, locale) : fallback;
}

/** Only the label is translated; choice values remain the API/document tokens. */
export function catalogOption(value: string): string {
  return catalogText(`catalog.options.${value}`, value);
}

/** Localize a view of /catalog while preserving parameter identifiers, values and the API object. */
export function localizeCatalog(catalog: Catalog, locale: Language = language): Catalog {
  const parameter = (type: string, descriptor: ParamDescriptor, parent = ""): ParamDescriptor => {
    const path = parent === "" ? descriptor.name : `${parent}.${descriptor.name}`;
    const key = `catalog.types.${type}.params.${path}`;
    return { ...descriptor,
      title: catalogText(`${key}.title`, descriptor.title, locale),
      description: catalogText(`${key}.description`, descriptor.description, locale),
      fields: descriptor.fields.map((field) => parameter(type, field, path)),
    };
  };
  return { ...catalog,
    assumptions: catalog.assumptions.map((text, index) => catalogText(`catalog.assumptions.${index}`, text, locale)),
    types: catalog.types.map((type) => ({ ...type,
      title: catalogText(`catalog.types.${type.id}.title`, type.title, locale),
      description: catalogText(`catalog.types.${type.id}.description`, type.description, locale),
      assumptions: type.assumptions.map((text, index) => catalogText(`catalog.types.${type.id}.assumptions.${index}`, text, locale)),
      params: type.params.map((descriptor) => parameter(type.id, descriptor)),
    })),
  };
}
