import type { usePlayback } from "./usePlayback";

interface PlaybackControlsProps {
  playback: ReturnType<typeof usePlayback>;
  window: number | null;
  windowCount: number;
  replication: number;
  replications: number;
  onReplicationChange: (replication: number) => void;
}

export function PlaybackControls({ playback, window, windowCount, replication, replications, onReplicationChange }: PlaybackControlsProps) {
  return <div className="playback-controls" role="group" aria-label="Run playback">
    <button type="button" onClick={playback.playing ? playback.pause : playback.play}>
      {playback.playing ? "Pause run" : "Play run"}
    </button>
    <button type="button" aria-label="Previous window" title="Previous window" onClick={() => playback.seek((window ?? 0) - 1)} disabled={window === null || window === 0}>‹</button>
    <button type="button" aria-label="Next window" title="Next window" onClick={() => playback.seek(window === null ? 0 : window + 1)} disabled={window === windowCount - 1}>›</button>
    <label>Speed <select aria-label="Playback speed" value={playback.speed} onChange={(event) => playback.setSpeed(Number(event.target.value))}>
      {[0.25, 0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
    </select></label>
    <label>Replication <select aria-label="Playback replication" value={replication} onChange={(event) => onReplicationChange(Number(event.target.value))}>
      {Array.from({ length: replications }, (_, index) => <option key={index} value={index}>{index}</option>)}
    </select></label>
    <input type="range" aria-label="Playback window" min={0} max={windowCount - 1} step={1} value={window ?? 0}
      onChange={(event) => playback.seek(Number(event.target.value))} />
    <button type="button" onClick={() => playback.seek(null)} disabled={window === null}>Return to summary</button>
    {playback.loading ? <span role="status">Loading playback series; waiting for the selected window…</span> : null}
    {playback.problem === null ? null : <span role="status">{playback.problem}</span>}
  </div>;
}
