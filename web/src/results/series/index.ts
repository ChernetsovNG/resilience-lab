import { SeriesLoader } from "./loader";

export { SeriesLoadError, SeriesLoader } from "./loader";
/** Timeline and playback share one decoded-part cache within the 64 MiB budget. */
export const seriesLoader = new SeriesLoader();
export type {
  ConnectionSeriesLoadRequest,
  SeriesApi,
  SeriesDecoder,
  SeriesDecoderFactory,
  SeriesLoadErrorCode,
  SeriesLoadRequest,
  SeriesLoaderOptions,
} from "./loader";
export { DEFAULT_SERIES_CACHE_BYTES, SeriesPartCache } from "./cache";
export type { SeriesPartKey } from "./cache";
export type { DecodedConnection, DecodedConnectionWindow, DecodedConnectionLatency, NodeSeriesMetrics, WindowMetricValues } from "./types";
