"""Generate measured artifacts; keep all generated data under ignored build/."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
WRITER = BUILD / "install/results-volume/bin/results-volume"
FORMATS = ["json", "json-gzip", "csv", "arrow", "parquet"]


def invoke(out, kind, fmt, blocks, windows, seed, count=1, grid=False):
    with (BUILD / "writer-stderr.log").open("a") as log:
        result = subprocess.run(
            [str(WRITER), str(out), kind, fmt, str(blocks), str(windows), str(seed), str(count)] + (["grid"] if grid else []),
            check=True, stdout=subprocess.PIPE, stderr=log, text=True,
        )
    records = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(records) == count
    for record in records:
        path = Path(record["path"])
        assert path.stat().st_size == record["bytes"] > 0
        if kind.startswith("series"):
            assert record["rows"] == blocks * windows
            assert record["columnCount"] == 12
        else:
            assert record["rows"] == record["attempts"] * 4
            assert record["events"] == record["rows"]
        with path.open("rb") as f:
            record["fileSha256"] = hashlib.file_digest(f, "sha256").hexdigest()
    print(json.dumps({"phase": kind, "format": fmt, "blocks": blocks,
                      "files": count, "bytes": sum(r["bytes"] for r in records)}), flush=True)
    return records


def verify(records):
    hashes = {}
    for r in records:
        key = r["kind"], r["blocks"], r["windows"], r["seed"]
        value = r["canonicalSha256"], r["rows"], r["checksum"], tuple(r["columns"])
        assert hashes.setdefault(key, value) == value, ("cross-format mismatch", key)


def main():
    phase = sys.argv[1] if len(sys.argv) > 1 else "all"
    if phase not in ("single", "grid", "noise", "all"):
        raise SystemExit("Usage: python3 measure.py [single|grid|noise|all]")
    if not WRITER.exists():
        raise SystemExit("First run: ../../gradlew -p . installDist")
    BUILD.mkdir(exist_ok=True)
    for selected in (["single", "grid", "noise"] if phase == "all" else [phase]):
        started = time.monotonic()
        records = []
        if selected == "single":
            for trial in range(3):
                for kind, blocks in [("series", 50), ("series", 500), ("series", 5000), ("trace", 50)]:
                    for fmt in FORMATS[trial:] + FORMATS[:trial]:
                        items = invoke(BUILD / "data" / ("trial-" + str(trial)), kind, fmt, blocks, 600, 42)
                        for item in items:
                            item["trial"] = trial
                        records += items
                        (BUILD / "single-progress.json").write_text(json.dumps(records, indent=2) + "\n")
        elif selected == "grid":
            for fmt in FORMATS:
                records += invoke(BUILD / "grid", "series", fmt, 50, 600, 1000, 250, grid=True)
            for fmt in FORMATS:
                subset = [r for r in records if r["format"] == fmt]
                assert {r["seed"] for r in subset} == set(range(1000, 1250))
                assert sum(r["rows"] for r in subset) == 50 * 600 * 10 * 25
                for r in subset:
                    assert r["gridCell"] == (r["seed"] - 1000) // 10
                    assert r["replication"] == (r["seed"] - 1000) % 10
        else:
            for fmt in FORMATS:
                records += invoke(BUILD / "noise", "series-noise", fmt, 50, 600, 42)
        verify(records)
        (BUILD / (selected + "-results.json")).write_text(json.dumps({
            "wallSeconds": time.monotonic() - started, "measurements": records
        }, indent=2) + "\n")
    single_path = BUILD / "single-results.json"
    if single_path.exists():
        single = json.loads(single_path.read_text())["measurements"]
        browser = [r for r in single if r["trial"] == 2]
        # Full Chromium verification of three distinct partitions from the complete grid.
        grid_path = BUILD / "grid-results.json"
        if grid_path.exists():
            browser += [r for r in json.loads(grid_path.read_text())["measurements"]
                        if r["seed"] in (1000, 1123, 1249)]
        noise_path = BUILD / "noise-results.json"
        if noise_path.exists():
            browser += json.loads(noise_path.read_text())["measurements"]
        (BUILD / "browser-input.json").write_text(json.dumps(browser, indent=2) + "\n")


if __name__ == "__main__":
    main()
