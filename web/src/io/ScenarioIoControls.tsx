import { useEffect, useRef } from "react";
import type { Execution, ExperimentDocument, Scenario, ValidationIssue } from "../api/types";
import type { ActiveVariantId } from "../scenario/useScenarioEditor";
import { downloadJson, ScenarioIo } from "./ScenarioIo";

interface ScenarioIoControlsProps {
  activeVariantId: ActiveVariantId;
  scenario: Scenario;
  execution: Execution;
  replaceScenario: (scenario: Scenario, variantId?: ActiveVariantId) => void;
  replaceExperiment: (
    scenario: Scenario,
    execution: Execution,
    variantId?: ActiveVariantId,
  ) => void;
  onIssues: (issues: ValidationIssue[]) => void;
}

export function ScenarioIoControls(props: ScenarioIoControlsProps) {
  const propsRef = useRef(props);
  const ioRef = useRef<ScenarioIo | null>(null);
  const createIo = () => {
    ioRef.current ??= new ScenarioIo({
      getExecution: () => propsRef.current.execution,
      replaceScenario: (scenario) => propsRef.current.replaceScenario(scenario),
      replaceExperiment: (scenario, execution) =>
        propsRef.current.replaceExperiment(scenario, execution),
      onIssues: (issues) => propsRef.current.onIssues(issues),
    });
    return ioRef.current;
  };

  useEffect(() => {
    propsRef.current = props;
  }, [props]);

  useEffect(() => () => ioRef.current?.cancel(), []);

  const importFile = (file: File | undefined, fullDocument: boolean) => {
    if (!file) return;
    const variantId = propsRef.current.activeVariantId;
    const pending = fullDocument
      ? createIo().importExperimentDocument(file, (scenario, execution) =>
          propsRef.current.replaceExperiment(scenario, execution, variantId),
        )
      : createIo().importScenario(file, (scenario) =>
          propsRef.current.replaceScenario(scenario, variantId),
        );
    void pending.catch(() => undefined);
  };

  return (
    <section className="scenario-io" aria-label="Scenario import and export">
      <label>
        Import scenario
        <input
          type="file"
          name="scenarioFile"
          accept="application/json,.json"
          onChange={(event) => {
            importFile(event.target.files?.[0], false);
            event.target.value = "";
          }}
        />
      </label>
      <label>
        Import experiment
        <input
          type="file"
          name="experimentFile"
          accept="application/json,.json"
          onChange={(event) => {
            importFile(event.target.files?.[0], true);
            event.target.value = "";
          }}
        />
      </label>
      <button
        type="button"
        onClick={() => {
          const experiment: ExperimentDocument = {
            schemaVersion: 1,
            execution: props.execution,
            variants: [
              {
                id: "imported",
                label: "imported",
                scenario: props.scenario,
                sweepParameter: null,
                sweepValue: null,
              },
            ],
          };
          downloadJson("experiment.json", experiment);
        }}
      >
        Export experiment
      </button>
    </section>
  );
}
