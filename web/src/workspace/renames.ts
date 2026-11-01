import { api } from "../api/apiClient";
import type { ModelFile } from "../api/apiTypes";
import { MessageError } from "../i18n/MessageError";
import { dirtyDocuments, documentValuesEqual, elementIdentity, type LoadedExperiment } from "./editor";
import { storedExperiments } from "./fileActions";
import { resolveRef } from "./paths";
import { experimentsForModel } from "./modelSelection";
import { experimentReferences, incidentAutomaticConnections } from "./structure";

export type StoredExperiment = Awaited<ReturnType<typeof storedExperiments>>[number];
/** Last successfully written reference basis for one question while the model save is incomplete. */
export interface AppliedRename { modelPath: string; model: ModelFile; version: string }
const elements = (model: ModelFile) => [...Object.entries(model.blocks), ...model.connections.map(edge => [edge.id, edge] as const)];

/** Net replacements between the persisted model and the current history snapshot, including undo after a save. */
export function modelRenames(before: ModelFile, after: ModelFile): Map<string, string> {
  const ids = new Map(elements(after).map(([id, element]) => [elementIdentity(element), id]));
  return new Map(elements(before).flatMap(([id, element]) => {
    const next = ids.get(elementIdentity(element));
    return next === undefined || next === id ? [] : [[id, next]];
  }));
}

/** Successful sibling writes remain pending until the model save completes, including Undo after a partial failure. */
export function hasPendingRelatedRenames(loaded: LoadedExperiment | null, applied: ReadonlyMap<string, AppliedRename>): boolean {
  return loaded !== null && [...applied.values()].some(previous => previous.modelPath === loaded.modelPath && modelRenames(previous.model, loaded.model).size > 0);
}

/** Other saved questions whose reference fields would change when this element is renamed. */
export function experimentsUsing(loaded: LoadedExperiment, id: string, questions: readonly StoredExperiment[], applied: ReadonlyMap<string, AppliedRename> = new Map()): string[] {
  return questions.filter(({ entry, experiment }) => {
    if (entry.path === loaded.experimentPath || resolveRef(entry.path, experiment.modelRef) !== loaded.modelPath) return false;
    const previous = applied.get(entry.path);
    const basis = previous?.modelPath === loaded.modelPath ? previous.model : loaded.saved.model;
    const origins = new Map([...modelRenames(basis, loaded.model)].map(([before, after]) => [after, before]));
    const ids = new Set([id, ...incidentAutomaticConnections(loaded.model, id).map(edge => edge.id)].map(id => origins.get(id) ?? id));
    return [...experiment.faults.map(fault => fault.target.split("#")[0]),
      ...experiment.variants.flatMap(variant => Object.keys(variant.overrides ?? {}).map(path => path.split(".")[0])),
      ...(experiment.grid ?? []).map(axis => axis.path.split(".")[0])].some(id => ids.has(id));
  })
    .map(({ entry }) => entry.path.split("/").at(-1)!.replace(/\.experiment\.json$/, "")).sort();
}

/** Reads owned questions and preflights all affected versions before the first conditional write. */
export async function prepareRelatedRenames(loaded: LoadedExperiment, applied: ReadonlyMap<string, AppliedRename> = new Map()): Promise<StoredExperiment[]> {
  const ids = modelRenames(loaded.saved.model, loaded.model);
  if (ids.size === 0 && !hasPendingRelatedRenames(loaded, applied)) return [];
  const questions = await storedExperiments((await api.documents()).filter(entry => entry.path !== loaded.experimentPath));
  const owned = questions.filter(({ entry, experiment }) => resolveRef(entry.path, experiment.modelRef) === loaded.modelPath);
  const writes = owned.flatMap(question => {
    const previous = applied.get(question.entry.path);
    const known = previous?.modelPath === loaded.modelPath ? previous : undefined;
    if (known !== undefined && known.version !== question.entry.version && modelRenames(loaded.saved.model, known.model).size > 0) {
      throw new MessageError("app.workspace.renameConflict", { path: question.entry.path });
    }
    const replacements = known === undefined ? ids : modelRenames(known.model, loaded.model);
    const experiment = experimentReferences(question.experiment, id => replacements.get(id) ?? id);
    return documentValuesEqual(experiment, question.experiment) ? [] : [{ ...question, experiment }];
  });
  const latest = await api.documents();
  const ownedPaths = new Set(owned.map(({ entry }) => entry.path));
  const latestOwned = new Set(experimentsForModel(latest, loaded.modelPath).filter(path => path !== loaded.experimentPath));
  const changedOwner = [...ownedPaths, ...latestOwned].find(path => ownedPaths.has(path) !== latestOwned.has(path));
  if (changedOwner !== undefined) throw new MessageError("app.workspace.renameConflict", { path: changedOwner });
  const versions = new Map(latest.map(entry => [entry.path, entry.version]));
  const expected = new Map<string, string | null>(owned.map(({ entry }) => [entry.path, entry.version]));
  expected.set(loaded.modelPath, loaded.versions.model);
  const dirty = dirtyDocuments(loaded);
  for (const kind of ["layout", "model", "experiment"] as const) {
    if (dirty[kind] || (kind === "experiment" && loaded.versions.experiment === null)) expected.set(loaded[`${kind}Path`], loaded.versions[kind]);
  }
  for (const [path, version] of expected) {
    if ((versions.get(path) ?? null) !== version) throw new MessageError("app.workspace.renameConflict", { path });
  }
  return writes;
}
