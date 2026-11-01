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

/** Snaps the insertion position to the selected grid when enabled and keeps a gap between measured footprints.
 * Prefers the selected node's right side, then below it, or the nearest free position inside the supplied bounds.
 * The caller reveals the fallback when the visible area is full.
 */
export function insertionPosition(center: Position, occupied: readonly (Position & { width: number; height: number })[],
  { width, height }: { width: number; height: number }, gridStep = 20, snapToGrid = true,
  bounds?: Position & { width: number; height: number }, anchor?: Position & { width: number; height: number }): Position {
  const gap = 40;
  const overlaps = (position: Position) => occupied.some(node => position.x < node.x + (node.width || width) + gap && position.x + width + gap > node.x &&
    position.y < node.y + (node.height || height) + gap && position.y + height + gap > node.y);
  const visible = (position: Position) => bounds === undefined || (position.x >= bounds.x && position.y >= bounds.y &&
    position.x + width <= bounds.x + bounds.width && position.y + height <= bounds.y + bounds.height);
  const after = (value: number) => snapToGrid ? Math.ceil(value / gridStep) * gridStep : value;
  const preferred = anchor === undefined ? [gridPosition(center, gridStep, snapToGrid)] : [
    { x: after(anchor.x + anchor.width + gap), y: gridPosition(anchor, gridStep, snapToGrid).y },
    { x: gridPosition(anchor, gridStep, snapToGrid).x, y: after(anchor.y + anchor.height + gap) },
  ];
  for (const position of preferred) if (!overlaps(position) && visible(position)) return position;
  let nearest: Position | undefined;
  let distance = Infinity;
  let fallback: Position | undefined;
  let fallbackDistance = Infinity;
  if (bounds !== undefined) {
    const left = snapToGrid ? Math.ceil(bounds.x / gridStep) * gridStep : bounds.x;
    const top = snapToGrid ? Math.ceil(bounds.y / gridStep) * gridStep : bounds.y;
    for (let y = top; y + height <= bounds.y + bounds.height; y += gridStep) {
      for (let x = left; x + width <= bounds.x + bounds.width; x += gridStep) {
        const candidate = { x, y };
        const squared = (x - center.x) ** 2 + (y - center.y) ** 2;
        if (squared >= distance && squared >= fallbackDistance || overlaps(candidate)) continue;
        if (squared < fallbackDistance) { fallback = candidate; fallbackDistance = squared; }
        if (anchor !== undefined && x < anchor.x + anchor.width + gap && y < anchor.y + anchor.height + gap) continue;
        if (squared < distance) { nearest = candidate; distance = squared; }
      }
    }
  }
  if (nearest !== undefined || fallback !== undefined) return nearest ?? fallback!;
  const position = { ...preferred[anchor === undefined ? 0 : 1] };
  while (overlaps(position)) {
    position.x += 2 * gridStep;
    position.y += 2 * gridStep;
  }
  return position;
}

function gridPosition(point: Position, gridStep: number, snapToGrid: boolean): Position {
  return snapToGrid ? { x: Math.round(point.x / gridStep) * gridStep, y: Math.round(point.y / gridStep) * gridStep } : { ...point };
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
    const params = initialParams(catalog.types.find(entry => entry.id === rule.type)?.params ?? []);
    // Keep balancing implicit; an explicit override is ignored for single targets and routers.
    if (rule.type === "call") delete params.balancing;
    return { ...documents, model: { ...documents.model, connections: [
      ...documents.model.connections, { id, type: rule.type, from, to, params },
    ] } };
  };
}

// Grid arrives in a later track; preserve and cascade it if a document already contains it.
type WithGrid = ExperimentFile & { grid?: { path: string; values: unknown[] }[] | null };

/** Rewrites experiment references by exact element id, retaining parameter paths and replica suffixes. */
export function experimentReferences(experiment: ExperimentFile, mapId: (id: string) => string | null): ExperimentFile {
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
      layout: { ...documents.layout,
        positions: Object.fromEntries(Object.entries(documents.layout.positions).filter(([id]) => !removed.has(id))),
        sizes: Object.fromEntries(Object.entries(documents.layout.sizes).filter(([id]) => !removed.has(id))),
        edges: Object.fromEntries(Object.entries(documents.layout.edges).filter(([id]) => !removed.has(id))),
      },
      experiment: experimentReferences(documents.experiment, mapId),
    };
  };
}

/** Connections whose generated ids follow a renamed endpoint; manually named connections stay independent. */
export function incidentAutomaticConnections(model: ModelFile, id: string): ModelFile["connections"] {
  return model.connections.filter(edge => {
    const prefix = `${edge.from}-to-${edge.to}`;
    const suffix = edge.id.slice(prefix.length);
    return (edge.from === id || edge.to === id) && edge.id.startsWith(prefix) && (suffix === "" || /^-[1-9][0-9]*$/.test(suffix));
  });
}

/** Renames an element and incident automatic connection ids, including every document reference, in one operation. */
export function renameElement(id: string, next: string): EditorCommand {
  return (documents) => {
    if (id === next || elementOf(documents.model, id) === null || identifierError(documents.model, next, id) !== null) return documents;
    const ids = new Map([[id, next]]);
    const mapId = (value: string) => ids.get(value) ?? value;
    const automatic = incidentAutomaticConnections(documents.model, id)
      .map(edge => ({ edge, suffix: edge.id.slice(`${edge.from}-to-${edge.to}`.length) }));
    const used = usedIds(documents.model);
    used.delete(id);
    for (const { edge } of automatic) used.delete(edge.id);
    used.add(next);
    for (const { edge, suffix } of automatic) {
      const prefix = `${mapId(edge.from)}-to-${mapId(edge.to)}`;
      const preferred = prefix + suffix;
      const renamed = used.has(preferred) ? freeId(prefix, used, suffix !== "") : preferred;
      used.add(renamed);
      ids.set(edge.id, renamed);
    }
    // Authored entries win over stale metadata already stored at a destination id.
    const renameManualEntries = <T,>(entries: Record<string, T>) => Object.fromEntries([
      ...Object.entries(entries).filter(([key]) => !ids.has(key)),
      ...Object.entries(entries).filter(([key]) => ids.has(key)).map(([key, value]) => [mapId(key), value]),
    ]);
    return {
      ...documents,
      model: { ...documents.model,
        blocks: Object.fromEntries(Object.entries(documents.model.blocks).map(([key, value]) => [mapId(key), scenarioReferences(value, mapId)])),
        connections: documents.model.connections.map((edge) => ({ ...edge, id: mapId(edge.id), from: mapId(edge.from), to: mapId(edge.to) })),
      },
      layout: { ...documents.layout,
        positions: Object.fromEntries(Object.entries(documents.layout.positions).map(([key, value]) => [mapId(key), value])),
        sizes: renameManualEntries(documents.layout.sizes),
        edges: renameManualEntries(documents.layout.edges),
      },
      experiment: experimentReferences(documents.experiment, mapId),
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

/** A resize, including a left/top origin change, is one editor operation. */
export function resizeBlock(id: string, position: Position, size: { width: number; height: number }): EditorCommand {
  return documents => {
    if (!Object.hasOwn(documents.model.blocks, id) || !Number.isFinite(position.x) || !Number.isFinite(position.y)
      || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return documents;
    return { ...documents, layout: { ...documents.layout,
      positions: { ...documents.layout.positions, [id]: { ...position } },
      sizes: { ...documents.layout.sizes, [id]: { ...size } },
    } };
  };
}

/** Removes only the authored size; the next render measures automatic content again. */
export function resetBlockSize(id: string): EditorCommand {
  return documents => {
    if (!Object.hasOwn(documents.layout.sizes, id)) return documents;
    const sizes = { ...documents.layout.sizes };
    delete sizes[id];
    return { ...documents, layout: { ...documents.layout, sizes } };
  };
}

export interface ClipboardFragment {
  blocks: ModelFile["blocks"];
  connections: ModelFile["connections"];
  positions: LayoutFile["positions"];
  sizes: LayoutFile["sizes"];
}

/** Snapshots selected blocks and all connections internal to them, including annotations. */
export function copySelection(documents: EditorDocuments, selection: string[]): ClipboardFragment {
  const selected = new Set(selection);
  const blocks = Object.fromEntries(Object.entries(documents.model.blocks).filter(([id]) => selected.has(id)));
  return structuredClone({
    blocks,
    sizes: Object.fromEntries(Object.entries(documents.layout.sizes).filter(([id]) => selected.has(id))),
    connections: documents.model.connections.filter((edge) => Object.hasOwn(blocks, edge.from) && Object.hasOwn(blocks, edge.to)),
    positions: Object.fromEntries(Object.keys(blocks).map((id) => [id, positionOf(documents.model, documents.layout, id)])),
  });
}

/** Pastes a fragment as one model/layout operation with fresh ids and shifted positions. */
export function pasteSelection(fragment: ClipboardFragment, offset = 40, gridStep = 20, snapToGrid = true): EditorCommand {
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
      layout: { ...documents.layout,
        sizes: { ...documents.layout.sizes, ...Object.fromEntries(Object.entries(fragment.sizes).map(([id, size]) => [ids.get(id)!, { ...size }])) },
        positions: { ...documents.layout.positions, ...Object.fromEntries(Object.entries(fragment.positions)
        .map(([id, point]) => [ids.get(id)!, gridPosition({ x: point.x + offset, y: point.y + offset }, gridStep, snapToGrid)])) } },
    };
  };
}
