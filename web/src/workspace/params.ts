import type { Catalog, ModelFile } from "../api/apiTypes";

export type Params = Record<string, unknown>;

export function isObject(value: unknown): value is Params {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own entry [key] of [record]; inherited names such as `constructor` are valid IDs, not entries. */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Type and parameters of block or connection [id]; null when the model has no such element. */
export function elementOf(model: ModelFile, id: string): { type: string; params: Params } | null {
  const block = ownEntry(model.blocks, id);
  if (block !== undefined) return { type: block.type, params: block.params };
  const connection = model.connections.find((candidate) => candidate.id === id);
  return connection === undefined ? null : { type: connection.type, params: connection.params };
}

/** Copy of [model] with parameter [name] of element [id] set to [value]; undefined removes it so its default applies. */
export function withParam(model: ModelFile, id: string, name: string, value: unknown): ModelFile {
  const update = (params: Params): Params => {
    const next = { ...params };
    if (value === undefined) delete next[name];
    else next[name] = value;
    return next;
  };
  const block = ownEntry(model.blocks, id);
  if (block !== undefined) {
    return { ...model, blocks: { ...model.blocks, [id]: { ...block, params: update(block.params) } } };
  }
  return {
    ...model,
    connections: model.connections.map((connection) =>
      connection.id === id ? { ...connection, params: update(connection.params) } : connection,
    ),
  };
}

/**
 * The model as a variant sees it (ADR 0002): overrides are `id.param[.field]` paths, and a missing object starts from
 * its catalog default. As in the core compiler, overrides apply in key order, so an object comes before its fields.
 */
export function applyOverrides(model: ModelFile, overrides: Params, catalog: Catalog): ModelFile {
  let result = model;
  for (const key of Object.keys(overrides).sort()) {
    const value = overrides[key];
    const [id, name, ...fields] = key.split(".");
    const element = elementOf(result, id);
    const descriptor = catalog.types
      .find((type) => type.id === element?.type)
      ?.params.find((param) => param.name === name);
    if (element === null || descriptor === undefined) continue;
    const next = fields.length === 0 ? value : setField(objectOr(element.params[name], descriptor.default), fields, value);
    result = withParam(result, id, name, next);
  }
  return result;
}

/** True when the variant overrides [path] of element [id], the object holding it, or a field inside it. */
export function isOverridden(overrides: Params, id: string, path: string): boolean {
  const prefix = `${id}.`;
  return Object.keys(overrides)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .some((overridden) => overridden === path || overridden.startsWith(`${path}.`) || path.startsWith(`${overridden}.`));
}

function setField(target: Params, path: string[], value: unknown): Params {
  const [head, ...rest] = path;
  return { ...target, [head]: rest.length === 0 ? value : setField(objectOr(target[head], undefined), rest, value) };
}

function objectOr(value: unknown, fallback: unknown): Params {
  if (isObject(value)) return value;
  return isObject(fallback) ? fallback : {};
}
