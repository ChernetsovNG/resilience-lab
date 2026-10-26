import type { ExperimentResult, ExperimentSubmission } from "../api/types";
import { downloadJson } from "../io/ScenarioIo";

interface ResultDownloadProps {
  result: ExperimentResult;
  submission?: ExperimentSubmission | null;
}

export function ResultDownload({ result, submission }: ResultDownloadProps) {
  return (
    <button
      type="button"
      data-testid="result-download"
      onClick={() =>
        downloadJson("experiment-result.json", submission ? { ...result, submission } : result)
      }
    >
      Download full result JSON
    </button>
  );
}
