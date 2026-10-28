import { decodeSeriesPart } from "./decode";
import type { DecodedSeriesPart } from "./types";

interface WorkerResponse {
  parts?: DecodedSeriesPart[];
  error?: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<readonly string[]>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

scope.onmessage = (event) => {
  try {
    scope.postMessage({ parts: event.data.map(decodeSeriesPart) });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
