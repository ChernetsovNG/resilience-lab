import { useEffectEvent, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { XYPosition } from "@xyflow/react";
import { t } from "../i18n";
import { edgeBends, editEdgePoints, type EdgeControl } from "./manualEdge";

type Gesture = { control: EdgeControl; path: XYPosition[]; anchors: readonly XYPosition[]; pointer: number;
  origin: XYPosition; handle: XYPosition; position: XYPosition; edited: XYPosition[] | null };
const same = (a: XYPosition, b: XYPosition) => a.x === b.x && a.y === b.y;

/** Window listeners keep a gesture stable while preview routing introduces new segments. */
export function EdgeEditControls({ id, path, anchors, identity, toFlow, onPreview, onCommit, onStart }: {
  id: string; path: XYPosition[]; anchors: readonly XYPosition[]; identity: object;
  toFlow: (point: XYPosition) => XYPosition; onPreview: (points: XYPosition[] | null) => void; onCommit: (points: XYPosition[]) => void; onStart?: () => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const [active, setActive] = useState<Gesture | null>(null);
  const [limit, setLimit] = useState(false);
  const cancel = useEffectEvent(() => {
    if (gesture.current === null) return;
    gesture.current = null;
    setActive(null);
    onPreview(null);
  });
  const move = useEffectEvent((event: globalThis.PointerEvent) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.pointer) return;
    const cursor = toFlow({ x: event.clientX, y: event.clientY });
    const position = { x: current.handle.x + cursor.x - current.origin.x, y: current.handle.y + cursor.y - current.origin.y };
    if (current.control.kind === "segment") {
      const horizontal = current.path[current.control.index].y === current.path[current.control.index + 1].y;
      if (horizontal) position.x = current.handle.x; else position.y = current.handle.y;
    }
    current.position = position;
    current.edited = same(position, current.handle) ? null : editEdgePoints(current.path, current.anchors, current.control, position);
    setLimit(!same(position, current.handle) && current.edited === null);
    onPreview(current.edited);
    setActive({ ...current });
  });
  const finish = useEffectEvent((event: globalThis.PointerEvent) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.pointer) return;
    move(event);
    const edited = current.edited;
    cancel();
    if (edited !== null) onCommit(edited);
  });
  useLayoutEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    const stop = () => cancel();
    const pointermove = (event: globalThis.PointerEvent) => move(event);
    const pointerup = (event: globalThis.PointerEvent) => finish(event);
    window.addEventListener("pointermove", pointermove);
    window.addEventListener("pointerup", pointerup);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", keydown);
    return () => {
      cancel();
      window.removeEventListener("pointermove", pointermove);
      window.removeEventListener("pointerup", pointerup);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      window.removeEventListener("keydown", keydown);
    };
  }, [identity]);
  const begin = (event: PointerEvent<HTMLButtonElement>, control: EdgeControl, handle: XYPosition) => {
    if (event.button !== 0 || gesture.current !== null) return;
    event.preventDefault(); event.stopPropagation();
    onStart?.();
    const current = { control, path, anchors, pointer: event.pointerId,
      origin: toFlow({ x: event.clientX, y: event.clientY }), handle, position: handle, edited: null };
    gesture.current = current;
    setActive(current);
    setLimit(false);
  };
  const points = active?.path ?? path;
  const controls = [
    ...points.slice(1).flatMap((end, index) => same(points[index], end) ? [] : [{ kind: "segment" as const, index,
      point: { x: (points[index].x + end.x) / 2, y: (points[index].y + end.y) / 2 }, order: index + 1 }]),
    ...edgeBends(points).map(({ point, index }, order) => ({ kind: "bend" as const, index, point, order: order + 1 })),
  ];
  return <>
    {controls.map(({ kind, index, point, order }) => {
      const position = active?.control.kind === kind && active.control.index === index ? active.position : point;
      const label = t(kind === "segment" ? "editor.canvas.moveSegment" : "editor.canvas.moveBend", { index: order, id });
      return <button key={`${kind}-${index}`} type="button" className={`canvas-edge-handle canvas-edge-handle--${kind} nodrag nopan nowheel`}
        aria-label={label} title={label} data-edge-control={kind}
        style={{ transform: `translate(-50%, -50%) translate(${position.x}px,${position.y}px)`,
          cursor: kind === "bend" ? "move" : points[index].y === points[index + 1].y ? "ns-resize" : "ew-resize" }}
        onPointerDown={event => begin(event, { kind, index }, point)}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => {
          event.stopPropagation();
          if (kind === "bend") {
            const edited = editEdgePoints(path, anchors, { kind, index }, null);
            setLimit(edited === null);
            if (edited !== null) onCommit(edited);
          }
        }}
        onKeyDown={event => {
          if (event.key === "Delete" && kind === "bend") {
            event.preventDefault(); event.stopPropagation();
            const edited = editEdgePoints(path, anchors, { kind, index }, null);
            setLimit(edited === null);
            if (edited !== null) onCommit(edited);
            return;
          }
          const step = event.shiftKey ? 1 : 10;
          const delta = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[event.key];
          if (delta === undefined) return;
          event.preventDefault(); event.stopPropagation();
          const horizontal = kind === "segment" && points[index].y === points[index + 1].y;
          if (kind === "segment" && (horizontal ? delta.y === 0 : delta.x === 0)) return;
          const edited = editEdgePoints(path, anchors, { kind, index }, { x: point.x + delta.x, y: point.y + delta.y });
          setLimit(edited === null);
          if (edited !== null) onCommit(edited);
        }} />;
    })}
    {limit ? <div role="status" className="canvas-edge-edit-limit" style={{ transform: `translate(${(active?.position ?? path[0]).x}px,${(active?.position ?? path[0]).y}px)` }}>
      {t("editor.canvas.edgePointLimit")}
    </div> : null}
  </>;
}
