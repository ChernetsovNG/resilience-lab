import type { Catalog, OutputDescriptor, ParamDescriptor } from "../api/apiTypes";
import { catalogs, language, t, type Language } from "./index";

/** API prose remains the fallback until a language catalog supplies a matching stable identifier. */
export function catalogText(key: string, fallback: string, locale: Language = language): string {
  return catalogs[locale]?.[key] === undefined ? fallback : t(key, {}, locale);
}

/** Only the label is translated; choice values remain the API/document tokens. */
export function catalogOption(value: string): string {
  return catalogText(`catalog.options.${value}`, value);
}

/** Localize a view of /catalog while preserving parameter identifiers, values and the API object. */
export function localizeCatalog(catalog: Catalog, locale: Language = language): Catalog {
  const output = (type: string, descriptor: OutputDescriptor): OutputDescriptor => {
    const key = `catalog.types.${type}.outputs.${descriptor.id}`;
    // Preserve placeholders until the surface supplies its value and interval.
    const text = (path: string, fallback: string) => catalogs[locale]?.[`${key}.${path}`] ?? fallback;
    return { ...descriptor,
      title: text("title", descriptor.title), description: text("description", descriptor.description),
      timeline: descriptor.timeline == null ? descriptor.timeline : { ...descriptor.timeline,
        groupTitle: text("timeline.groupTitle", descriptor.timeline.groupTitle) },
      inspector: descriptor.inspector == null ? descriptor.inspector : { ...descriptor.inspector,
        title: text("inspector.title", descriptor.inspector.title) },
      overlay: descriptor.overlay == null ? descriptor.overlay : { ...descriptor.overlay,
        title: text("overlay.title", descriptor.overlay.title), label: text("overlay.label", descriptor.overlay.label),
        description: text("overlay.description", descriptor.overlay.description),
        windowDescription: descriptor.overlay.windowDescription == null ? descriptor.overlay.windowDescription
          : text("overlay.windowDescription", descriptor.overlay.windowDescription),
        scaleTitle: descriptor.overlay.scaleTitle == null ? descriptor.overlay.scaleTitle : text("overlay.scaleTitle", descriptor.overlay.scaleTitle),
      },
    };
  };
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
      outputs: (type.outputs ?? []).map(descriptor => output(type.id, descriptor)),
    })),
  };
}
