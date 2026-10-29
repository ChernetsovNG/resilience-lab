import { t } from "../../i18n";
import type { SeriesDecoder } from "./loader";
import { SeriesLoadError } from "./loader";
import type { DecodedSeriesPart } from "./types";

interface WorkerResponse {
  parts?: DecodedSeriesPart[];
  error?: string;
}

/** One-shot module worker; closing it rejects unfinished work and prevents stale cache writes. */
export class WorkerSeriesDecoder implements SeriesDecoder {
  private readonly worker = new Worker(new URL("./series.worker.ts", import.meta.url), { type: "module" });
  private pending: { resolve: (parts: DecodedSeriesPart[]) => void; reject: (error: Error) => void } | undefined;

  decode(texts: readonly string[]): Promise<DecodedSeriesPart[]> {
    return new Promise<DecodedSeriesPart[]>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        this.pending = undefined;
        if (event.data.error !== undefined) reject(new SeriesLoadError("INVALID_SERIES", event.data.error));
        else if (event.data.parts !== undefined) resolve(event.data.parts);
        else reject(new SeriesLoadError("INVALID_SERIES", t("results.series.emptyResponse")));
      };
      this.worker.onerror = (event) => {
        this.pending = undefined;
        reject(new SeriesLoadError("WORKER_ERROR", event.message));
      };
      this.worker.postMessage(texts);
    });
  }

  close(): void {
    this.worker.terminate();
    this.pending?.reject(new DOMException(t("results.series.aborted"), "AbortError"));
    this.pending = undefined;
  }
}
