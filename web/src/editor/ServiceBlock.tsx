import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ServiceSpec } from "../api/types";

export type ServiceNode = Node<{ service: ServiceSpec }, "service">;

export function ServiceBlock({ data }: NodeProps<ServiceNode>) {
  const { service } = data;

  return (
    <div className="service-block" data-testid="service-block">
      <Handle type="target" position={Position.Left} />
      <strong>{service.id}</strong>
      <span>{service.handlers} handlers</span>
      <span>Queue {service.queueCapacity}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
