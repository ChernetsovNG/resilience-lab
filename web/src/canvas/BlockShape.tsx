import { useLayoutEffect, type CSSProperties, type ReactNode } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";
import type { TypeDescriptor } from "../api/apiTypes";
import { blockGeometry, minimumBlockHeight } from "./blockGeometry";

interface BlockShapeProps {
  id: string;
  type: string;
  width?: number;
  height?: number;
  ports: TypeDescriptor["ports"];
  editable: boolean;
  replicas?: number;
  overridden?: boolean;
  fill?: string;
  children: ReactNode;
}

/** SVG and contour handles use React Flow's measured model coordinates. */
export function BlockShape({ id, type, width = 0, height = 0, ports, editable, replicas = 1, overridden, fill, children }: BlockShapeProps) {
  const w = width > 0 ? width : type === "router" ? 144 : replicas > 1 ? 264 : 192;
  const h = height > 0 ? height : minimumBlockHeight(type, w, 0, replicas);
  const geometry = blockGeometry(type, w, h, replicas);
  const updateNodeInternals = useUpdateNodeInternals();
  useLayoutEffect(() => { if (width > 0 && height > 0) updateNodeInternals(id); }, [updateNodeInternals, id, type, replicas, width, height]);
  const area = geometry.content;
  const style = {
    "--node-fill": fill,
    paddingTop: area.y, paddingLeft: area.x,
    paddingRight: w - area.x - area.width,
    paddingBottom: h - area.y - area.height,
  } as CSSProperties;
  return <div className={`block-shape block-shape--${geometry.shape} block-shape--type-${type}${geometry.back.length === 0 ? "" : " block-shape--replicas"}${overridden ? " block-shape--overridden" : ""}`} style={style}>
    <svg className="block-shape-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
      <g className="block-shape-back">{geometry.back.map((path, index) => <path key={index} d={path} />)}</g>
      <g className="block-shape-outline">{geometry.paths.map((path, index) => <g key={index}>
        <path d={path} />
        {overridden ? <g className="block-shape-override"><path d={path} /></g> : null}
      </g>)}</g>
      <g className="block-shape-details">{geometry.details.map((path, index) => <path key={index} d={path} />)}</g>
    </svg>
    {ports.map(port => {
      const point = geometry.ports[port.direction === "OUT" ? "OUT" : "IN"];
      return <Handle key={port.id} id={port.id} type={port.direction === "OUT" ? "source" : "target"}
        position={port.direction === "OUT" ? Position.Right : Position.Left} isConnectable={editable}
        style={{ left: point.x, top: point.y, right: "auto", transform: "translate(-50%, -50%)" }} />;
    })}
    <div className={`block-node block-node--${type}${overridden ? " block-node--overridden" : ""}`}
      data-testid="block-node" style={{ "--node-fill": fill } as CSSProperties}>{children}</div>
  </div>;
}
