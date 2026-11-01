import type { Catalog, ExperimentFile, ModelFile } from "../api/apiTypes";
import { sumLoadProfiles } from "../experiment/course";
import { t } from "../i18n";
import { rememberRequestTypeCopy, requestTypeIdentity, type EditorCommand } from "./editor";
import { resetVariantParam, setVariantParam } from "./experimentCommands";
import { applyOverrides, isObject, withParam, type Params } from "./params";
import { identifierError } from "./structure";
import { mapScenario } from "./scenarioTree";

/** Smallest free generated identifier within this client's request types. */
export function nextRequestTypeId(types: unknown[]): string {
  let number = 1;
  while (types.some(value => isObject(value) && value.id === `request-${number}`)) number++;
  return `request-${number}`;
}

/** Same syntax as block IDs, with a separate client-local namespace and reserved implicit type. */
export function requestTypeIdError(types: unknown[], index: number, id: string): string | null {
  if (id === "default") return t("editor.requestTypes.reserved");
  const syntax = identifierError({ schemaVersion: 1, blocks: {}, connections: [] }, id);
  if (syntax !== null) return syntax;
  return types.some((value, at) => at !== index && isObject(value) && value.id === id) ? t("editor.requestTypes.duplicate") : null;
}

/** A model rename changes a shared ID; no affected client or variant list may acquire a duplicate. */
export function requestTypeRenameError(model: ModelFile, experiment: ExperimentFile, client: string, index: number, id: string,
  variant: string | null = null): string | null {
  const types = model.blocks[client].params.classes;
  if (!Array.isArray(types)) return null;
  const error = requestTypeIdError(types, index, id);
  if (error !== null || variant !== null) return error;
  const old = isObject(types[index]) ? types[index].id : undefined;
  if (typeof old !== "string" || old === id) return null;
  const lists = [
    ...Object.values(model.blocks).filter(block => block.type === "client").map(block => block.params.classes),
    ...experiment.variants.flatMap(entry => Object.entries(entry.overrides).filter(([path]) => path.endsWith(".classes")).map(([, value]) => value)),
  ];
  return lists.some(list => Array.isArray(list) && list.some(value => isObject(value) && value.id === old)
    && list.some(value => isObject(value) && value.id === id)) ? t("editor.requestTypes.renameConflict") : null;
}

function declarations(model: ModelFile): { id: string; value: Params }[] {
  return Object.values(model.blocks).filter(block => block.type === "client").flatMap(block =>
    Array.isArray(block.params.classes) ? block.params.classes.flatMap(value =>
      isObject(value) && typeof value.id === "string" ? [{ id: value.id, value }] : []) : []);
}

/** Net ID changes across history and profile edits, shared with the related-experiment save mechanism. */
export function modelRequestTypeRenames(before: ModelFile, after: ModelFile): Map<string, string> {
  const ids = new Map(declarations(after).map(({ id, value }) => [requestTypeIdentity(value), id]));
  return new Map(declarations(before).flatMap(({ id, value }) => {
    const next = ids.get(requestTypeIdentity(value));
    return next === undefined || next === id ? [] : [[id, next]];
  }));
}

/** Rewrites whole-list overrides simultaneously; null means the rename would merge two IDs in one list. */
export function experimentRequestTypeReferences(experiment: ExperimentFile, ids: ReadonlyMap<string, string>): ExperimentFile | null {
  let collision = false;
  const variants = experiment.variants.map(variant => ({ ...variant,
    overrides: Object.fromEntries(Object.entries(variant.overrides).map(([path, value]) => {
      if (!path.endsWith(".classes") || !Array.isArray(value)) return [path, value];
      const before = value.flatMap(item => isObject(item) && typeof item.id === "string" ? [item.id] : []);
      const after = before.map(id => ids.get(id) ?? id);
      if (new Set(after).size < new Set(before).size) collision = true;
      return [path, value.map(item => isObject(item) && typeof item.id === "string" && ids.has(item.id) ? { ...item, id: ids.get(item.id)! } : item)];
    })),
  }));
  return collision ? null : { ...experiment, variants };
}

function setClientLoad(client: string, field: "load" | "classes", value: unknown, catalog: Catalog, variant: string | null): EditorCommand {
  const opposite = field === "load" ? "classes" : "load";
  return documents => {
    if (variant !== null) {
      return setVariantParam(variant, client, opposite, null, catalog)(setVariantParam(variant, client, field, value, catalog)(documents));
    }
    const switching = documents.model.blocks[client].params[opposite] != null;
    const variants = switching ? documents.experiment.variants.map(entry => {
      const explicit = Object.keys(entry.overrides).some(path => path === `${client}.${opposite}` || path.startsWith(`${client}.${opposite}.`));
      if (!explicit) return entry;
      const effective = applyOverrides(documents.model, entry.overrides, catalog).blocks[client].params;
      return effective[opposite] != null && effective[field] == null
        ? { ...entry, overrides: { ...entry.overrides, [`${client}.${field}`]: null } } : entry;
    }) : documents.experiment.variants;
    return { ...documents,
      model: withParam(withParam(documents.model, client, opposite, undefined), client, field, value),
      experiment: variants === documents.experiment.variants ? documents.experiment : { ...documents.experiment, variants },
    };
  };
}

/** Replaces the entire list; deletions deliberately retain scenario and route references for core diagnostics. */
export function editRequestTypes(client: string, types: unknown[], catalog: Catalog, variant: string | null = null): EditorCommand {
  return setClientLoad(client, "classes", types, catalog, variant);
}

/** Converts both parameters atomically, preserving the effective variant profile and every knot of a sum. */
export function switchClientLoad(client: string, multiple: boolean, catalog: Catalog, variant: string | null = null): EditorCommand {
  return documents => {
    const overrides = documents.experiment.variants.find(value => value.id === variant)?.overrides ?? {};
    const model = variant === null ? documents.model : applyOverrides(documents.model, overrides, catalog);
    const params = model.blocks[client].params;
    if (multiple === (params.classes != null)) return documents;
    if (multiple) {
      const descriptor = catalog.types.find(type => type.id === "client")?.params.find(param => param.name === "load");
      return editRequestTypes(client, [{ id: "request-1", load: params.load ?? descriptor?.initial }], catalog, variant)(documents);
    }
    if (!Array.isArray(params.classes)) return documents;
    const load = sumLoadProfiles(params.classes.map(value => isObject(value) ? value.load : undefined), catalog);
    return load === null ? documents : setClientLoad(client, "load", load, catalog, variant)(documents);
  };
}

/** Restores both mutually exclusive load parameters to the model in one Undo entry. */
export function resetClientLoad(client: string, variant: string, catalog: Catalog): EditorCommand {
  return documents => resetVariantParam(variant, client, "load", catalog)(resetVariantParam(variant, client, "classes", catalog)(documents));
}

/** Model-page renames update structural filters and all clients' lists in the open experiment's variants. */
export function renameRequestType(client: string, index: number, id: string, catalog: Catalog, variant: string | null = null): EditorCommand {
  return documents => {
    const overrides = documents.experiment.variants.find(value => value.id === variant)?.overrides ?? {};
    const model = variant === null ? documents.model : applyOverrides(documents.model, overrides, catalog);
    const types = model.blocks[client].params.classes;
    if (!Array.isArray(types) || index < 0 || index >= types.length || requestTypeRenameError(model, documents.experiment, client, index, id, variant) !== null) return documents;
    const original = types[index];
    const old = isObject(original) ? original.id : undefined;
    if (id === old) return documents;
    const renamed = (value: Params) => {
      const next = { ...value, id };
      rememberRequestTypeCopy(value, next);
      return next;
    };
    const renameTypes = (values: unknown[]) => values.map(value => typeof old === "string" && isObject(value) && value.id === old ? renamed(value) : value);
    const descriptor = catalog.types.find(type => type.id === "client")?.params.find(param => param.name === "load");
    const edited = editRequestTypes(client, types.map((value, at) => at === index
      ? isObject(original) ? renamed(original) : { id, load: descriptor?.initial } : value), catalog, variant)(documents);
    if (variant !== null) return edited;
    const renameFilter = (values: string[] | null | undefined) => values == null ? values : [...new Set(values.map(value => value === old ? id : value))];
    return { ...edited,
      model: { ...edited.model,
        blocks: Object.fromEntries(Object.entries(edited.model.blocks).map(([key, block]) => [key, {
          ...block,
          params: block.type === "client" && Array.isArray(block.params.classes) ? { ...block.params, classes: renameTypes(block.params.classes) } : block.params,
          ...(block.scenario == null ? {} : { scenario: mapScenario(block.scenario, step =>
            step.classes == null ? step : { ...step, classes: renameFilter(step.classes) }) }),
        }])),
        connections: edited.model.connections.map(connection => connection.classes == null ? connection : { ...connection, classes: renameFilter(connection.classes) }),
      },
      experiment: typeof old === "string" ? experimentRequestTypeReferences(edited.experiment, new Map([[old, id]]))! : edited.experiment,
    };
  };
}
