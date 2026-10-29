import { t } from "../../i18n";
import { formatMultiplier, formatNumber } from "../../i18n/format";
import { PLAYBACK_WINDOWS_PER_SECOND, type usePlayback } from "./usePlayback";

interface PlaybackControlsProps {
  playback: ReturnType<typeof usePlayback>;
  window: number | null;
  windowCount: number;
  replication: number;
  replications: number;
  onReplicationChange: (replication: number) => void;
}

export function PlaybackControls({ playback, window, windowCount, replication, replications, onReplicationChange }: PlaybackControlsProps) {
  return <div className="playback-controls" role="group" aria-label={t("results.playback.title")}>
    <button type="button" onClick={playback.playing ? playback.pause : playback.play}>
      {playback.playing ? t("results.playback.pause") : t("results.playback.play")}
    </button>
    <button type="button" aria-label={t("results.playback.previous")} title={t("results.playback.previous")} onClick={() => playback.seek((window ?? 0) - 1)} disabled={window === null || window === 0}>{t("results.playback.previousSymbol")}</button>
    <button type="button" aria-label={t("results.playback.next")} title={t("results.playback.next")} onClick={() => playback.seek(window === null ? 0 : window + 1)} disabled={window === windowCount - 1}>{t("results.playback.nextSymbol")}</button>
    <label>{t("results.playback.speedLabel")} <select aria-label={t("results.playback.speed")} value={playback.speed} onChange={(event) => playback.setSpeed(Number(event.target.value))}>
      {[0.25, 0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed}>{t("results.playback.speedOption", { speed: formatMultiplier(speed), windows: formatNumber(speed * PLAYBACK_WINDOWS_PER_SECOND) })}</option>)}
    </select></label>
    <label>{t("results.replication")} <select aria-label={t("results.playback.replication")} value={replication} onChange={(event) => onReplicationChange(Number(event.target.value))}>
      {Array.from({ length: replications }, (_, index) => <option key={index} value={index}>{formatNumber(index)}</option>)}
    </select></label>
    <input type="range" aria-label={t("results.playback.window")} min={0} max={windowCount - 1} step={1} value={window ?? 0}
      onChange={(event) => playback.seek(Number(event.target.value))} />
    <button type="button" onClick={() => playback.seek(null)} disabled={window === null}>{t("results.playback.summary")}</button>
    {playback.loading ? <span role="status">{t("results.playback.loading")}</span> : null}
    {playback.problem === null ? null : <span role="status">{playback.problem}</span>}
  </div>;
}
