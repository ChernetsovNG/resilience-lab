import type { SweepSpec } from "../api/types";
import type { ScenarioEditorState } from "../scenario/useScenarioEditor";
import {
  assertExclusiveSubmissionMode,
  buildComparison,
  buildSweep,
} from "../scenario/submission";
import type { useExperimentJob } from "./useExperimentJob";

interface ExperimentControlsProps {
  editor: Pick<ScenarioEditorState, "baseline" | "candidate" | "execution">;
  sweep?: SweepSpec | null;
  controller: ReturnType<typeof useExperimentJob>;
}

export function ExperimentControls({ editor, sweep, controller }: ExperimentControlsProps) {
  const runComparison = () => {
    const submission = buildComparison(editor.baseline, editor.candidate, editor.execution);
    assertExclusiveSubmissionMode(submission);
    void controller.startComparison(submission);
  };

  const runSweep = () => {
    if (!sweep) return;
    const submission = buildSweep(editor.baseline, editor.execution, sweep);
    assertExclusiveSubmissionMode(submission);
    void controller.startSweep(submission);
  };

  return (
    <div className="experiment-controls">
      <button type="button" disabled={controller.isRunning} onClick={runComparison}>
        Run comparison
      </button>
      <button type="button" disabled={controller.isRunning || !sweep} onClick={runSweep}>
        Run sweep
      </button>
    </div>
  );
}
