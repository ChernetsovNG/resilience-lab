import type { ExperimentResult } from "../api/types";
import { downloadJson } from "../io/ScenarioIo";

interface ResultDownloadProps {
  result: ExperimentResult;
}

export function ResultDownload({ result }: ResultDownloadProps) {
  return (
    <button
      type="button"
      data-testid="result-download"
      onClick={() => downloadJson("experiment-result.json", result)}
    >
      Download full result JSON
    </button>
  );
}
