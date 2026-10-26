import type { Execution, ExperimentDocument, Scenario, ValidationIssue } from "../api/types";
import { downloadJson, ScenarioIo } from "./ScenarioIo";

interface ScenarioIoControlsProps {
  scenario: Scenario;
  execution: Execution;
  replaceScenario: (scenario: Scenario) => void;
  replaceExperiment: (scenario: Scenario, execution: Execution) => void;
  onIssues: (issues: ValidationIssue[]) => void;
}

export function ScenarioIoControls(props: ScenarioIoControlsProps) {
  const createIo = () =>
    new ScenarioIo({
      getExecution: () => props.execution,
      replaceScenario: props.replaceScenario,
      replaceExperiment: props.replaceExperiment,
      onIssues: props.onIssues,
    });

  const importFile = (file: File | undefined, fullDocument: boolean) => {
    if (!file) return;
    const pending = fullDocument
      ? createIo().importExperimentDocument(file)
      : createIo().importScenario(file);
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
