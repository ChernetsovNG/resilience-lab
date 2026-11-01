import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Handle, NodeResizer, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { TypeDescriptor } from "../api/apiTypes";
import { blockGeometry, minimumBlockHeight, minimumRouterDiameter } from "./blockGeometry";
import type { PolicyWindowState } from "../results/policyState";
import { observeResize } from "../layout/observeResize";
import { policyStateDescription } from "./policyPresentation";

const routerMeasurementWidth = blockGeometry("service", 192, 192).content.width;

interface BlockShapeProps {
  id: string;
  type: string;
  width?: number;
  height?: number;
  ports: TypeDescriptor["ports"];
  editable: boolean;
  authoredSize?: boolean;
  resizable?: boolean;
  onResizeStart?: (id: string, value: { x: number; y: number; width: number; height: number }) => void;
  onResize?: (id: string, value: { x: number; y: number; width: number; height: number }) => void;
  onResizeEnd?: (id: string, value: { x: number; y: number; width: number; height: number }) => void;
  replicas?: number;
  overridden?: boolean;
  fill?: string;
  policyState?: PolicyWindowState;
  instances?: { id: string; replica: number; policyState?: PolicyWindowState }[];
  children: ReactNode;
}

/** SVG and contour handles use React Flow's measured model coordinates. */
export function BlockShape({ id, type, width = 0, height = 0, ports, editable, replicas = 1, overridden, fill, children, policyState, instances, authoredSize = false, resizable = false, onResizeStart, onResize, onResizeEnd }: BlockShapeProps) {
  const content = useRef<HTMLDivElement>(null);
  const routerContent = type === "router" ? children : null;
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (content.current === null) return;
    const element = content.current;
    const measure = () => {
      // Measure independently of the circle, allowing the same wrapping as a normal
      // card's content area. Wrapped text must not resize the circle that wraps it.
      const measured = type === "router" ? element.cloneNode(true) as HTMLElement : element;
      if (measured !== element) {
        measured.inert = true;
        measured.setAttribute("aria-hidden", "true");
        measured.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:max-content;max-width:${routerMeasurementWidth}px`;
        element.parentElement!.append(measured);
      }
      const dimensions = type === "router" ? getComputedStyle(measured) : null;
      const next = { width: dimensions === null ? 0 : Math.ceil(Math.max(measured.scrollWidth, parseFloat(dimensions.width) || 0)),
        height: dimensions === null ? measured.offsetHeight : Math.ceil(Math.max(measured.offsetHeight, parseFloat(dimensions.height) || 0)) };
      if (measured !== element) measured.remove();
      setContentSize(current => current.width === next.width && current.height === next.height ? current : next);
    };
    measure();
    if (typeof ResizeObserver !== "undefined") return observeResize([element], measure);
  }, [type, routerContent]);
  const contentHeight = contentSize.height;
  const router = type === "router";
  const minimumWidth = router ? minimumRouterDiameter(contentSize.width, contentHeight) : replicas > 1 ? 264 : 176;
  const w = router && !authoredSize ? minimumWidth : Math.max(minimumWidth, width > 0 ? width : replicas > 1 ? 264 : 192);
  const minimumHeight = router ? minimumWidth : minimumBlockHeight(type, w, contentHeight, replicas);
  const h = router && !authoredSize ? minimumHeight : Math.max(height, minimumHeight);
  const geometry = blockGeometry(type, w, h, replicas, router ? contentSize : undefined);
  const updateNodeInternals = useUpdateNodeInternals();
  useLayoutEffect(() => {
    // The first measurement belongs to React Flow; fallback geometry must not mark a node ready.
    if (width > 0 && height > 0) updateNodeInternals(id);
  }, [updateNodeInternals, id, type, replicas, width, height, w, h]);
  const area = geometry.content;
  const inactive = (state?: PolicyWindowState) => (state?.ejectedShare ?? 0) > 0 || (state?.notReadyShare ?? 0) > 0;
  const singleInactive = replicas === 1 && inactive(policyState);
  const frontInactive = replicas > 1 && inactive(instances?.find(instance => instance.replica === 1)?.policyState);
  const description = replicas === 1 ? policyStateDescription(policyState)
    : instances?.flatMap(instance => {
      const state = policyStateDescription(instance.policyState);
      return state ? [`${instance.id}: ${state}`] : [];
    }).join("\n");
  const style = {
    "--node-fill": fill,
    width: authoredSize || router ? w : undefined,
    height: authoredSize || router ? h : undefined,
    minWidth: minimumWidth, minHeight: minimumHeight,
    paddingTop: area.y, paddingLeft: area.x,
    paddingRight: w - area.x - area.width,
    paddingBottom: h - area.y - area.height,
  } as CSSProperties;
  return <div className={`block-shape block-shape--${geometry.shape} block-shape--type-${type}${geometry.back.length === 0 ? "" : " block-shape--replicas"}${overridden ? " block-shape--overridden" : ""}${singleInactive ? " block-shape--inactive" : ""}`} style={style} title={description || undefined}>
    {resizable ? <NodeResizer minWidth={minimumWidth} minHeight={minimumHeight}
      shouldResize={(_, value) => value.height >= (router ? minimumHeight : minimumBlockHeight(type, value.width, contentHeight, replicas))}
      onResizeStart={(_, value) => onResizeStart?.(id, value)}
      onResize={(_, value) => onResize?.(id, value)}
      onResizeEnd={(_, value) => onResizeEnd?.(id, value)} /> : null}
    <svg className="block-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      <g className="block-shape-back">{geometry.back.map((path, index) => {
        // The existing three-card silhouette represents replicas 1, 2 and the remaining instances.
        const members = instances?.filter(instance => index === 1 ? instance.replica === 2 : instance.replica >= 3) ?? [];
        return <path key={index} d={path} data-replicas={members.map(instance => instance.replica).join(",") || undefined}
          className={members.some(instance => inactive(instance.policyState)) ? "policy-replica--inactive" : undefined} />;
      })}</g>
      <g className={`block-shape-outline${frontInactive ? " policy-replica--inactive" : ""}`} data-replicas={replicas > 1 ? "1" : undefined}>{geometry.paths.map((path, index) => <g key={index}>
        <path d={path} />
        {overridden ? <g className="block-shape-override"><path d={path} /></g> : null}
      </g>)}</g>
      <g className="block-shape-details">{geometry.details.map((path, index) => <path key={index} d={path} />)}</g>
    </svg>
    {ports.map(port => {
      const point = geometry.ports[port.direction === "OUT" ? "OUT" : "IN"];
      return <Handle key={port.id} id={port.id} className="block-port" type={port.direction === "OUT" ? "source" : "target"}
        position={port.direction === "OUT" ? Position.Right : Position.Left} isConnectable={editable}
        style={{ left: point.x, top: point.y, right: "auto", transform: "translate(-50%, -50%)" }} />;
    })}
    <div ref={content} className={`block-node block-node--${type}${overridden ? " block-node--overridden" : ""}${frontInactive ? " policy-replica--inactive" : ""}`}
      data-testid="block-node" style={{ "--node-fill": fill } as CSSProperties}>{children}</div>
  </div>;
}
