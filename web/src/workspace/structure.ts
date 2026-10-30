import { t } from "../i18n";
import type { BlockInstance, Catalog, ExperimentFile, LayoutFile, ModelFile } from "../api/apiTypes";
import type { EditorCommand, EditorDocuments } from "./editor";
import { elementOf, ownEntry } from "./params";
import { initialParams } from "./initialParams";

type Position = LayoutFile["positions"][string];

function usedIds(model: ModelFile): Set<string> {
  return new Set([...Object.keys(model.blocks), ...model.connections.map((edge) => edge.id)]);
}

function freeId(prefix: string, used: Set<string>, numbered = false): string {
  let id = prefix;
  for (let n = 1; (numbered && n === 1) || used.has(id); n++) id = `${prefix}-${n}`;
  used.add(id);
  return id;
}

/** Same path-segment syntax and shared block/connection namespace as ModelCompiler.ID. */
export function identifierError(model: ModelFile, id: string, current?: string): string | null {
  if (id !== id.trim() || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    return t("app.structure.invalidId");
  }
  return id !== current && usedIds(model).has(id) ? t("app.structure.idUsed") : null;
}

/** Position in the layout, or the deterministic automatic position used by the canvas. */
export function positionOf(model: ModelFile, layout: LayoutFile | null, id: string): Position {
  return (layout === null ? undefined : ownEntry(layout.positions, id))
    ?? { x: Object.keys(model.blocks).indexOf(id) * 260, y: 100 };
}

/** Snaps the viewport center to the 20-unit grid and offsets by 40 until measured block footprints are clear. */
export function insertionPosition(center: Position, occupied: readonly (Position & { width: number; height: number })[],
  { width, height }: { width: number; height: number }): Position {
  const position = { x: Math.round(center.x / 20) * 20, y: Math.round(center.y / 20) * 20 };
  while (occupied.some((node) => position.x < node.x + (node.width || width) && position.x + width > node.x &&
    position.y < node.y + (node.height || height) && position.y + height > node.y)) {
    position.x += 40;
    position.y += 40;
  }
  return position;
}

/** Chooses a numbered block id in the shared block/connection namespace, including for measurement previews. */
export function nextBlockId(model: ModelFile, type: string): string {
  return freeId(type, usedIds(model), true);
}

/** Writes catalog initial values explicitly together with the block position; reading existing elements never applies them. */
export function addBlock(catalog: Catalog, type: string, position: Position): EditorCommand {
  return (documents) => {
    const descriptor = catalog.types.find((entry) => entry.id === type && entry.category === "BLOCK");
    if (descriptor === undefined) return documents;
    const id = nextBlockId(documents.model, type);
    return {
      ...documents,
      model: { ...documents.model, blocks: { ...documents.model.blocks, [id]: { type, params: initialParams(descriptor.params) } } },
      layout: { ...documents.layout, positions: { ...documents.layout.positions, [id]: position } },
    };
  };
}

/** Resolves the catalog connection rule and verifies the selected ports' directions. */
export function connectionRule(catalog: Catalog, model: ModelFile, from: string, to: string, sourcePort: string | null, targetPort: string | null):
  { type: string; error: null } | { type: null; error: string } {
  const source = ownEntry(model.blocks, from);
  const target = ownEntry(model.blocks, to);
  const output = catalog.types.find((type) => type.id === source?.type)?.ports
    .some((port) => port.id === sourcePort && port.direction === "OUT");
  const input = catalog.types.find((type) => type.id === target?.type)?.ports
    .some((port) => port.id === targetPort && port.direction === "IN");
  if (!output || !input) return { type: null, error: t("app.structure.connectPorts") };
  const type = catalog.types.find((type) => type.category === "CONNECTION"
    && type.connects?.fromTypes.includes(source?.type ?? "") && target !== undefined && type.connects?.toTypes.includes(target.type));
  return type === undefined
    ? { type: null, error: t("app.structure.connectionNotAllowed", { from: String(source?.type), to: String(target?.type) }) }
    : { type: type.id, error: null };
}

/** Adds a catalog-approved connection with an id unique across blocks and connections. */
export function addConnection(catalog: Catalog, from: string, to: string, sourcePort: string | null, targetPort: string | null): EditorCommand {
  return (documents) => {
    const rule = connectionRule(catalog, documents.model, from, to, sourcePort, targetPort);
    if (rule.type === null) return documents;
    const id = freeId(`${from}-to-${to}`, usedIds(documents.model));
    return { ...documents, model: { ...documents.model, connections: [
      ...documents.model.connections, { id, type: rule.type, from, to, params: initialParams(catalog.types.find(entry => entry.id === rule.type)?.params ?? []) },
    ] } };
  };
}

// Grid arrives in a later track; preserve and cascade it if a document already contains it.
type WithGrid = ExperimentFile & { grid?: { path: string; values: unknown[] }[] | null };

function references(experiment: ExperimentFile, mapId: (id: string) => string | null): ExperimentFile {
  const mapPath = (path: string): string | null => {
    const dot = path.indexOf(".");
    const id = dot < 0 ? path : path.slice(0, dot);
    const next = mapId(id);
    return next === null ? null : next + path.slice(id.length);
  };
  const grid = (experiment as WithGrid).grid;
  return {
    ...experiment,
    variants: experiment.variants.map((variant) => variant.overrides == null ? variant : {
      ...variant,
      overrides: Object.fromEntries(Object.entries(variant.overrides).flatMap(([path, value]) => {
        const next = mapPath(path);
        return next === null ? [] : [[next, value]];
      })),
    }),
    faults: experiment.faults.flatMap((fault) => {
      const suffix = fault.target.indexOf("#");
      const id = suffix < 0 ? fault.target : fault.target.slice(0, suffix);
      const target = mapId(id);
      return target === null ? [] : [{ ...fault, target: target + fault.target.slice(id.length) }];
    }),
    ...(grid == null ? {} : { grid: grid.flatMap((axis) => {
      const path = mapPath(axis.path);
      return path === null ? [] : [{ ...axis, path }];
    }) }),
  };
}

function scenarioReferences(block: BlockInstance, mapId: (id: string) => string | null): BlockInstance {
  if (block.scenario == null) return block;
  const scenario = block.scenario.flatMap((step) => {
    if (step.type !== "call" || step.connection == null) return [step];
    const connection = mapId(step.connection);
    return connection === null ? [] : [{ ...step, connection }];
  });
  const next: BlockInstance = { ...block, scenario };
  if (scenario.length === 0) delete next.scenario;
  return next;
}

/** Removes a selection and every reference to it in one undoable document operation. */
export function deleteElements(selection: string[]): EditorCommand {
  return (documents) => {
    const selected = new Set(selection);
    const removed = new Set(Object.keys(documents.model.blocks).filter((id) => selected.has(id)));
    for (const edge of documents.model.connections) {
      if (selected.has(edge.id) || removed.has(edge.from) || removed.has(edge.to)) removed.add(edge.id);
    }
    const mapId = (id: string) => removed.has(id) ? null : id;
    return {
      ...documents,
      model: { ...documents.model,
        blocks: Object.fromEntries(Object.entries(documents.model.blocks).filter(([id]) => !removed.has(id))
          .map(([id, block]) => [id, scenarioReferences(block, mapId)])),
        connections: documents.model.connections.filter((edge) => !removed.has(edge.id)),
      },
      layout: { ...documents.layout, positions: Object.fromEntries(Object.entries(documents.layout.positions).filter(([id]) => !removed.has(id))) },
      experiment: references(documents.experiment, mapId),
    };
  };
}

/** Renames a block or connection in place, including every document reference. */
export function renameElement(id: string, next: string): EditorCommand {
  return (documents) => {
    if (id === next || elementOf(documents.model, id) === null || identifierError(documents.model, next, id) !== null) return documents;
    const mapId = (value: string) => value === id ? next : value;
    return {
      ...documents,
      model: { ...documents.model,
        blocks: Object.fromEntries(Object.entries(documents.model.blocks).map(([key, value]) => [mapId(key), scenarioReferences(value, mapId)])),
        connections: documents.model.connections.map((edge) => ({ ...edge, id: mapId(edge.id), from: mapId(edge.from), to: mapId(edge.to) })),
      },
      layout: { ...documents.layout, positions: Object.fromEntries(Object.entries(documents.layout.positions).map(([key, value]) => [mapId(key), value])) },
      experiment: references(documents.experiment, mapId),
    };
  };
}

/** Commits only moved block positions; missing automatic positions stay absent. */
export function moveBlocks(positions: Record<string, Position>): EditorCommand {
  return (documents) => ({ ...documents, layout: {
    ...documents.layout,
    positions: { ...documents.layout.positions, ...Object.fromEntries(Object.entries(positions)
      .filter(([id, point]) => Object.hasOwn(documents.model.blocks, id) && Number.isFinite(point.x) && Number.isFinite(point.y))) },
  } });
}

export interface ClipboardFragment {
  blocks: ModelFile["blocks"];
  connections: ModelFile["connections"];
  positions: LayoutFile["positions"];
}

/** Snapshots selected blocks and all connections internal to them, including annotations. */
export function copySelection(documents: EditorDocuments, selection: string[]): ClipboardFragment {
  const selected = new Set(selection);
  const blocks = Object.fromEntries(Object.entries(documents.model.blocks).filter(([id]) => selected.has(id)));
  return structuredClone({
    blocks,
    connections: documents.model.connections.filter((edge) => Object.hasOwn(blocks, edge.from) && Object.hasOwn(blocks, edge.to)),
    positions: Object.fromEntries(Object.keys(blocks).map((id) => [id, positionOf(documents.model, documents.layout, id)])),
  });
}

/** Pastes a fragment as one model/layout operation with fresh ids and shifted positions. */
export function pasteSelection(fragment: ClipboardFragment, offset = 40): EditorCommand {
  return (documents) => {
    const used = usedIds(documents.model);
    const ids = new Map(Object.entries(fragment.blocks).map(([id, block]) => [id, freeId(block.type, used, true)]));
    const connectionIds = new Map<string, string>();
    const connections = fragment.connections.map((edge) => {
      const from = ids.get(edge.from)!;
      const to = ids.get(edge.to)!;
      const id = freeId(`${from}-to-${to}`, used);
      connectionIds.set(edge.id, id);
      return { ...structuredClone(edge), id, from, to };
    });
    return {
      ...documents,
      model: { ...documents.model,
        blocks: { ...documents.model.blocks, ...Object.fromEntries(Object.entries(fragment.blocks)
          .map(([id, block]) => [ids.get(id)!, scenarioReferences(structuredClone(block), (id) => connectionIds.get(id) ?? null)])) },
        connections: [...documents.model.connections, ...connections],
      },
      layout: { ...documents.layout, positions: { ...documents.layout.positions, ...Object.fromEntries(Object.entries(fragment.positions)
        .map(([id, point]) => [ids.get(id)!, { x: point.x + offset, y: point.y + offset }])) } },
    };
  };
}
