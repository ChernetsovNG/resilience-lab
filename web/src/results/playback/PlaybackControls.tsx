import { t } from "../../i18n";
import { formatMultiplier, formatNumber } from "../../i18n/format";
import { PLAYBACK_WINDOWS_PER_SECOND, type usePlayback } from "./usePlayback";

interface PlaybackControlsProps {
  playback: ReturnType<typeof usePlayback>;
  window: number | null;
  windowCount: number;
  disabled?: boolean;
}

export function PlaybackControls({ playback, window, windowCount, disabled = false }: PlaybackControlsProps) {
  return <div className="playback-controls" role="group" aria-label={t("results.playback.title")}>
    <button type="button" disabled={disabled} onClick={playback.playing ? playback.pause : playback.play}
      aria-label={playback.playing ? t("results.playback.pause") : t("results.playback.play")}
      title={playback.playing ? t("results.playback.pause") : t("results.playback.play")}>
      {playback.playing ? t("results.context.pauseSymbol") : t("results.context.playSymbol")}
    </button>
    <button type="button" aria-label={t("results.playback.previous")} title={t("results.playback.previous")} onClick={() => playback.seek((window ?? 0) - 1)} disabled={window === null || window === 0}>{t("results.playback.previousSymbol")}</button>
    <button type="button" aria-label={t("results.playback.next")} title={t("results.playback.next")} onClick={() => playback.seek(window === null ? 0 : window + 1)} disabled={window === windowCount - 1}>{t("results.playback.nextSymbol")}</button>
    <select aria-label={t("results.playback.speed")} title={t("results.playback.speedOption", {
      speed: formatMultiplier(playback.speed), windows: formatNumber(playback.speed * PLAYBACK_WINDOWS_PER_SECOND),
    })} value={playback.speed} onChange={(event) => playback.setSpeed(Number(event.target.value))}>
      {[0.25, 0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed} label={formatMultiplier(speed)}>{t("results.playback.speedOption", { speed: formatMultiplier(speed), windows: formatNumber(speed * PLAYBACK_WINDOWS_PER_SECOND) })}</option>)}
    </select>
    <input type="range" aria-label={t("results.playback.window")} min={0} max={windowCount - 1} step={1} value={window ?? 0}
      onChange={(event) => playback.seek(Number(event.target.value))} />
    {playback.loading ? <span className="playback-status" role="status" title={t("results.playback.loading")}>
      <span aria-hidden="true">{t("results.context.loadingSymbol")}</span><span className="sr-only">{t("results.playback.loading")}</span>
    </span> : null}
    {playback.problem === null ? null : <span className="playback-status" role="status" title={playback.problem}>
      <span aria-hidden="true">{t("results.context.errorSymbol")}</span><span className="sr-only">{playback.problem}</span>
    </span>}
  </div>;
}
