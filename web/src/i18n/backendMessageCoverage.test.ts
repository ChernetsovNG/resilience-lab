/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const catalogs = import.meta.glob<Record<string, string>>("./{en,ru}.json", { eager: true, import: "default" });
const paths = [
  "../core/src/main/kotlin/resiliencelab/core/compiler/CoreMessage.kt",
  "../apps/server/src/main/kotlin/resiliencelab/server/lab/ServerMessage.kt",
];
const inventories = paths.map(path => {
  const source = readFileSync(resolve(process.cwd(), path), "utf8");
  const contracts = [...source.matchAll(/^\s+[A-Z][A-Z_]+\(\s*"([A-Z_]+)",\s*(null|"([^"\n]+)"),\s*"((?:[^"\\]|\\.)*)",?\s*\)[,;]/gm)]
    .map(([, code, , reason, raw]) => ({
      key: `messages.${code}${reason === undefined ? "" : `.${reason}`}`,
      template: JSON.parse(`"${raw}"`) as string,
    }));
  return { path, contracts, entries: [...source.matchAll(/^\s+[A-Z][A-Z_]+\(/gm)].length };
});
const contracts = inventories.flatMap(inventory => inventory.contracts);
const parameters = (template: string) => [...new Set([...template.matchAll(/\{(\w+)\}/g)].map(([, name]) => name))].sort();

describe("backend translation coverage from Kotlin emitters", () => {
  it("finds the production contracts rather than a separate code list", () => {
    for (const { path, contracts, entries } of inventories) {
      expect(entries, path).toBeGreaterThan(0);
      expect(contracts, path).toHaveLength(entries);
    }
    expect(new Set(contracts.map(contract => contract.key)).size).toBe(contracts.length);
  });

  for (const [language, catalog] of Object.entries(catalogs)) {
    it(`${language} covers every emitted code and reason with the same scalar parameters`, () => {
      for (const { key, template } of contracts) {
        expect(catalog[key], key).toBeTypeOf("string");
        expect(parameters(catalog[key]), key).toEqual(parameters(template));
      }
    });
  }
});
