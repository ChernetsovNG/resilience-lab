import { useState } from "react";
import { Background, ReactFlow } from "@xyflow/react";
import type { Connection, Edge, NodeChange, XYPosition } from "@xyflow/react";
import { useScenarioEditor } from "../scenario/useScenarioEditor";
import { EditorToolbar } from "./EditorToolbar";
import { ServiceBlock } from "./ServiceBlock";
import type { ServiceNode } from "./ServiceBlock";
import { TopologyIssues } from "./TopologyIssues";
import "@xyflow/react/dist/style.css";

const nodeTypes = { service: ServiceBlock };

export function ChainCanvas() {
  const editor = useScenarioEditor();
  const [positions, setPositions] = useState<Record<string, XYPosition>>({});
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const scenario = editor[editor.activeVariantId];

  const nodes: ServiceNode[] = scenario.services.map((service, index) => ({
    id: service.id,
    type: "service",
    data: { service },
    position: positions[service.id] ?? { x: index * 260, y: 100 },
    selected: selectedServiceId === service.id,
    ariaLabel: service.id,
  }));
  const edges: Edge[] = scenario.links.map((link) => ({
    id: link.id,
    source: link.from,
    target: link.to,
    deletable: false,
    selectable: false,
  }));

  const onNodesChange = (changes: NodeChange<ServiceNode>[]) => {
    changes.forEach((change) => {
      if (change.type === "position" && change.position) {
        const position = change.position;
        setPositions((current) => ({ ...current, [change.id]: position }));
      } else if (change.type === "select") {
        setSelectedServiceId(change.selected ? change.id : null);
      } else if (change.type === "remove") {
        editor.deleteService(change.id);
        setSelectedServiceId((current) => (current === change.id ? null : current));
      }
    });
  };

  const onConnect = (connection: Connection) => {
    editor.connectServices(connection.source, connection.target);
  };

  const resetCanvas = (reset: () => void) => {
    setPositions({});
    setSelectedServiceId(null);
    reset();
  };

  return (
    <div className="chain-editor">
      <EditorToolbar
        canDelete={selectedServiceId !== null}
        canRun={editor.issues.length === 0}
        onNew={() => resetCanvas(editor.newThreeServiceChain)}
        onLoadExample={() => resetCanvas(editor.loadRetryStormExample)}
        onAddService={editor.addService}
        onDeleteService={() => {
          if (selectedServiceId) {
            editor.deleteService(selectedServiceId);
            setSelectedServiceId(null);
          }
        }}
      />
      <div className="chain-canvas">
        <ReactFlow
          aria-label="Service chain canvas"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedServiceId(node.id)}
          onPaneClick={() => setSelectedServiceId(null)}
        >
          <Background />
        </ReactFlow>
      </div>
      <TopologyIssues issues={editor.issues} />
    </div>
  );
}
