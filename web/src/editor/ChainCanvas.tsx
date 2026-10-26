import { useCallback, useState } from "react";
import { Background, ReactFlow } from "@xyflow/react";
import type { Connection, Edge, NodeChange, XYPosition } from "@xyflow/react";
import type { SweepSpec } from "../api/types";
import { ExperimentControls } from "../experiment/ExperimentControls";
import { JobStatus } from "../experiment/JobStatus";
import { useExperimentJob } from "../experiment/useExperimentJob";
import { DraftValidityContext } from "../forms/DraftValidityContext";
import { useScenarioEditor } from "../scenario/useScenarioEditor";
import type { ActiveVariantId } from "../scenario/useScenarioEditor";
import { DegradationInspector } from "../forms/DegradationInspector";
import { ExecutionInspector } from "../forms/ExecutionInspector";
import { LinkInspector } from "../forms/LinkInspector";
import { ServiceInspector } from "../forms/ServiceInspector";
import { WorkloadInspector } from "../forms/WorkloadInspector";
import { ScenarioIoControls } from "../io/ScenarioIoControls";
import { ResultPanel } from "../results/ResultPanel";
import { SweepControls } from "../results/SweepControls";
import { EditorToolbar } from "./EditorToolbar";
import { ServiceBlock } from "./ServiceBlock";
import type { ServiceNode } from "./ServiceBlock";
import { TopologyIssues } from "./TopologyIssues";
import "@xyflow/react/dist/style.css";

const nodeTypes = { service: ServiceBlock };

export function ChainCanvas() {
  const editor = useScenarioEditor();
  const controller = useExperimentJob();
  const [sweep, setSweep] = useState<SweepSpec | null>(null);
  const [sweepDraftApplied, setSweepDraftApplied] = useState(false);
  const [positions, setPositions] = useState<Record<string, XYPosition>>({});
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [invalidDrafts, setInvalidDrafts] = useState<ReadonlySet<string>>(new Set());
  const scenario = editor[editor.activeVariantId];
  const onDraftValidityChange = useCallback((id: string, valid: boolean) => {
    setInvalidDrafts((current) => {
      if (!valid && !current.has(id)) return new Set(current).add(id);
      if (valid && current.has(id)) {
        const next = new Set(current);
        next.delete(id);
        return next;
      }
      return current;
    });
  }, []);

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
    setInvalidDrafts(new Set());
    controller.reset();
    reset();
  };

  const selectVariant = (variantId: ActiveVariantId) => {
    if (variantId === editor.activeVariantId) return;
    setPositions({});
    setSelectedServiceId(null);
    editor.selectActiveVariant(variantId);
  };

  const selectedService =
    scenario.services.find((service) => service.id === selectedServiceId) ?? scenario.services[0];

  return (
    <DraftValidityContext.Provider value={onDraftValidityChange}>
      <div className="chain-editor">
        <EditorToolbar
          canDelete={selectedServiceId !== null}
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
        <fieldset className="variant-selector">
          <legend>Edit variant</legend>
          <label>
            <input
              type="radio"
              name="activeVariant"
              value="baseline"
              checked={editor.activeVariantId === "baseline"}
              onChange={() => selectVariant("baseline")}
            />
            Baseline
          </label>
          <label>
            <input
              type="radio"
              name="activeVariant"
              value="candidate"
              checked={editor.activeVariantId === "candidate"}
              onChange={() => selectVariant("candidate")}
            />
            Candidate
          </label>
        </fieldset>
        <ExperimentControls
          editor={editor}
          sweep={sweep}
          controller={controller}
          canRun={editor.issues.length === 0 && invalidDrafts.size === 0}
          canRunSweep={sweepDraftApplied}
        />
        <JobStatus job={controller.job} isRunning={controller.isRunning} error={controller.error} />
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
        <ScenarioIoControls
          activeVariantId={editor.activeVariantId}
          scenario={scenario}
          execution={editor.execution}
          replaceScenario={editor.replaceScenario}
          replaceExperiment={editor.replaceExperiment}
          onIssues={editor.setIssues}
        />
        <div className="parameter-panels">
          {selectedService ? (
            <ServiceInspector
              service={selectedService}
              onChange={(patch) => editor.updateService(editor.activeVariantId, selectedService.id, patch)}
            />
          ) : null}
          {scenario.links.map((link) => (
            <LinkInspector key={link.id} link={link} onChange={(patch) => editor.updateLink(link.id, patch)} />
          ))}
          <WorkloadInspector workload={scenario.workload} onChange={editor.updateWorkload} />
          <DegradationInspector
            degradation={scenario.degradation}
            serviceIds={scenario.services.map((service) => service.id)}
            onChange={editor.updateDegradation}
          />
          <ExecutionInspector execution={editor.execution} onChange={editor.updateExecution} />
        </div>
        <SweepControls
          onChange={setSweep}
          appliedSweep={sweep}
          onDraftStateChange={setSweepDraftApplied}
        />
        <TopologyIssues issues={editor.issues} />
        <ResultPanel
          jobId={controller.jobId}
          result={controller.result}
          submission={controller.submission}
          error={controller.error}
          issues={controller.issues}
        />
      </div>
    </DraftValidityContext.Provider>
  );
}
