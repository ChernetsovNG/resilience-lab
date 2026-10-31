import { describe, expect, it } from "vitest";
import en from "./en.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };
import catalogSnapshot from "../test/catalog.json" with { type: "json" };
import type { Catalog, ParamDescriptor } from "../api/apiTypes";

const catalog = catalogSnapshot as Catalog;

function parameterEntries(type: string, descriptor: ParamDescriptor, parent = ""): [string, string][] {
  const path = parent === "" ? descriptor.name : `${parent}.${descriptor.name}`;
  const key = `catalog.types.${type}.params.${path}`;
  return [
    [`${key}.title`, descriptor.title],
    [`${key}.description`, descriptor.description],
    ...descriptor.options.map((option): [string, string] => [`catalog.options.${option}`, option]),
    ...descriptor.fields.flatMap((field) => parameterEntries(type, field, path)),
  ];
}

const catalogEntries: [string, string][] = [
  ...catalog.assumptions.map((text, index): [string, string] => [`catalog.assumptions.${index}`, text]),
  ...catalog.types.flatMap((type): [string, string][] => [
    [`catalog.types.${type.id}.title`, type.title],
    [`catalog.types.${type.id}.description`, type.description],
    ...type.assumptions.map((text, index): [string, string] => [`catalog.types.${type.id}.assumptions.${index}`, text]),
    ...type.params.flatMap((descriptor) => parameterEntries(type.id, descriptor)),
    ...type.outputs.flatMap(output => {
      const prefix = `catalog.types.${type.id}.outputs.${output.id}`;
      return [
        [`${prefix}.title`, output.title], [`${prefix}.description`, output.description],
        ...(output.timeline == null ? [] : [[`${prefix}.timeline.groupTitle`, output.timeline.groupTitle]]),
        ...(output.inspector == null ? [] : [[`${prefix}.inspector.title`, output.inspector.title]]),
        ...(output.overlay == null ? [] : Object.entries(output.overlay)
          .filter(([key, value]) => typeof value === "string" && key !== "scaleParameter")
          .map(([key, value]) => [`${prefix}.overlay.${key}`, value])),
      ] as [string, string][];
    }),
  ]),
];

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name))].sort();

describe("language catalogs", () => {
  it.each([["en", en], ["ru", ru]] as const)("covers run field explanations in %s", (_, messages) => {
    const dictionary: Record<string, string> = messages;
    for (const field of ["replications", "warmup", "measurement", "window", "seed", "maxRealTime"]) {
      expect(dictionary[`editor.run.${field}.description`]?.trim(), field).toBeTruthy();
    }
  });

  it("keeps English and Russian keys identical", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps named placeholders identical for every message", () => {
    const russian: Record<string, string> = ru;
    for (const [key, text] of Object.entries(en)) {
      expect(placeholders(russian[key] ?? ""), key).toEqual(placeholders(text));
    }
  });

  it.each([["en", en], ["ru", ru]] as const)("covers every API catalog type, assumption and nested parameter in %s", (_, messages) => {
    const dictionary: Record<string, string> = messages;
    expect(catalogEntries.filter(([key]) => !dictionary[key]?.trim()).map(([key]) => key)).toEqual([]);
  });

  it("preserves the API catalog prose in English", () => {
    const english: Record<string, string> = en;
    for (const [key, text] of catalogEntries.filter(([key]) => !key.startsWith("catalog.options."))) expect(english[key], key).toBe(text);
  });
});
