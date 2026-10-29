import type { Catalog, ParamDescriptor } from "../api/apiTypes";
import { messages, t } from "./index";

/** API prose remains the fallback until a language catalog supplies a matching stable identifier. */
export function catalogText(key: string, fallback: string): string {
  return Object.hasOwn(messages, key) ? t(key) : fallback;
}

/** Localize a view of /catalog while preserving parameter identifiers, values and the API object. */
export function localizeCatalog(catalog: Catalog): Catalog {
  const parameter = (type: string, descriptor: ParamDescriptor, parent = ""): ParamDescriptor => {
    const path = parent === "" ? descriptor.name : `${parent}.${descriptor.name}`;
    const key = `catalog.types.${type}.params.${path}`;
    return { ...descriptor,
      title: catalogText(`${key}.title`, descriptor.title),
      description: catalogText(`${key}.description`, descriptor.description),
      fields: descriptor.fields.map((field) => parameter(type, field, path)),
    };
  };
  return { ...catalog,
    assumptions: catalog.assumptions.map((text, index) => catalogText(`catalog.assumptions.${index}`, text)),
    types: catalog.types.map((type) => ({ ...type,
      title: catalogText(`catalog.types.${type.id}.title`, type.title),
      description: catalogText(`catalog.types.${type.id}.description`, type.description),
      assumptions: type.assumptions.map((text, index) => catalogText(`catalog.types.${type.id}.assumptions.${index}`, text)),
      params: type.params.map((descriptor) => parameter(type.id, descriptor)),
    })),
  };
}
