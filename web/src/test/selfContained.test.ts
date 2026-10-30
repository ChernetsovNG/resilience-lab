/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** The web Docker image copies only web/, so a relative import outside it breaks `npm run build` there. */
describe("web sources are self-contained", () => {
  it("imports nothing outside web/ by relative path", () => {
    const outside = ["src", "e2e"].flatMap((dir) => sources(join(webRoot, dir))).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)]
        .map((match) => resolve(dirname(file), match[1]))
        .filter((target) => relative(webRoot, target).startsWith(".."))
        .map((target) => `${relative(webRoot, file)} -> ${relative(webRoot, target)}`));
    expect(outside).toEqual([]);
  });
});
