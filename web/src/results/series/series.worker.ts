import { decodeSeriesPart } from "./decode";
import type { DecodedSeriesPart } from "./types";
import { MessageError } from "../../i18n/MessageError";

interface WorkerResponse {
  parts?: DecodedSeriesPart[];
  error?: string | Pick<MessageError, "key" | "params">;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<readonly string[]>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

scope.onmessage = (event) => {
  try {
    scope.postMessage({ parts: event.data.map(decodeSeriesPart) });
  } catch (error) {
    scope.postMessage({ error: error instanceof MessageError ? { key: error.key, params: error.params }
      : error instanceof Error ? error.message : String(error) });
  }
};
