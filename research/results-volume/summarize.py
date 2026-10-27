"""Validate generated evidence and publish compact, portable measurement files."""
import csv
from datetime import datetime
from zoneinfo import ZoneInfo
import hashlib
import json
from pathlib import Path
import platform
import statistics
import subprocess

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
FORMATS = ["json", "json-gzip", "csv", "arrow", "parquet"]


def read(name):
    return json.loads((BUILD / name).read_text())


def main():
    single = read("single-results.json")["measurements"]
    grid = read("grid-results.json")["measurements"]
    noise = read("noise-results.json")["measurements"]
    browser = read("browser-results.json")
    inputs = read("browser-input.json")
    assert len(single) == 60 and len(grid) == 1250 and len(noise) == 5
    assert len(inputs) == len(browser["results"]) == 40
    canonical = {}
    for r in single + grid + noise:
        path = Path(r["path"])
        assert path.stat().st_size == r["bytes"]
        with path.open("rb") as f:
            assert hashlib.file_digest(f, "sha256").hexdigest() == r["fileSha256"]
        key = r["kind"], r["blocks"], r["windows"], r["seed"]
        value = r["canonicalSha256"], r["checksum"], r["rows"], tuple(r["columns"])
        assert canonical.setdefault(key, value) == value
    for expected, actual in zip(inputs, browser["results"], strict=True):
        for field in ("kind", "format", "blocks", "windows", "seed", "bytes", "rows"):
            assert expected[field] == actual[field]
        assert expected["canonicalSha256"] == actual["cold"]["canonicalSha256"]
        if actual["streaming"] is not None:
            assert actual["streaming"]["canonicalSha256"] == expected["canonicalSha256"]
        if actual.get("slice") is not None:
            assert actual["slice"]["canonicalSha256"] == actual["cold"]["uiCanonicalSha256"]
        for trial in [actual["cold"]] + actual["trials"]:
            assert trial["rows"] == expected["rows"]
            assert trial["values"] == expected["rows"] * expected["columnCount"]
            assert trial["bytes"] == expected["bytes"]
            assert trial["checksum"] == expected["checksum"]
    grids = []
    with (ROOT / "grid-sizes.csv").open("w", newline="") as f:
        columns = ["format", "seed", "gridCell", "replication", "arrivalMultiplier", "latencyMultiplier", "rows", "bytes", "canonicalSha256", "fileSha256"]
        writer = csv.DictWriter(f, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        for r in grid:
            writer.writerow({c: r[c] for c in columns})
    for fmt in FORMATS:
        rows = [r for r in grid if r["format"] == fmt]
        assert len(rows) == 250
        assert {(r["gridCell"], r["replication"]) for r in rows} == {
            (cell, rep) for cell in range(25) for rep in range(10)}
        assert sum(r["rows"] for r in rows) == 7_500_000
        grids.append({"format": fmt, "files": len(rows), "rows": sum(r["rows"] for r in rows),
                      "bytes": sum(r["bytes"] for r in rows),
                      "minFileBytes": min(r["bytes"] for r in rows),
                      "maxFileBytes": max(r["bytes"] for r in rows),
                      "sumWriteMs": sum(r["writeMs"] for r in rows)})
    summaries = []
    for kind, blocks in [("series", 50), ("series", 500), ("series", 5000), ("trace", 50)]:
        for fmt in FORMATS:
            rows = [r for r in single if (r["kind"], r["blocks"], r["format"]) == (kind, blocks, fmt)]
            assert {r["trial"] for r in rows} == {0, 1, 2}
            assert len({r["bytes"] for r in rows}) == 1
            times = [r["writeMs"] for r in rows]
            summaries.append({"kind": kind, "blocks": blocks, "format": fmt, "rows": rows[0]["rows"],
                              "bytes": rows[0]["bytes"], "writeMs": times,
                              "medianWriteMs": statistics.median(times),
                              "canonicalSha256": rows[0]["canonicalSha256"],
                              "fileSha256": rows[0]["fileSha256"]})
    environment = {"os": platform.system(), "osVersion": platform.mac_ver()[0] or platform.release(),
                   "architecture": platform.machine(),
                   "java": subprocess.run(["java", "-version"], capture_output=True, text=True, check=True).stderr.strip(),
                   "node": browser.get("node"), "chromium": browser["chromium"]}
    if platform.system() == "Darwin":
        for key, setting in [("cpu", "machdep.cpu.brand_string"), ("memoryBytes", "hw.memsize"), ("logicalCpus", "hw.ncpu")]:
            value = subprocess.check_output(["sysctl", "-n", setting], text=True).strip()
            environment[key] = value if key == "cpu" else int(value)
    source_files = ["src/main/java/resiliencelab/research/ResultsVolume.java", "browser-entry.mjs", "browser.mjs", "measure.py"]
    output = {"measuredOn": datetime.now(ZoneInfo("Europe/Moscow")).date().isoformat(),
              "baselineCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "environment": environment,
              "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_files},
              "rawFloat64Bytes": {str(b): b * 600 * 10 * 10 * 25 * 8 for b in (50, 500, 5000)},
              "single": summaries, "grid50": grids,
              "trace": {k: v for k, v in single[-1].items() if k in
                        ["originalRequests", "sampledRequests", "attempts", "events", "sampleRate", "hops", "durationSeconds", "requestRatePerSecond"]},
              "noise": [{k: v for k, v in r.items() if k != "path"} for r in noise],
              "browser": browser}
    (ROOT / "results.json").write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"validatedFiles": len(single) + len(grid) + len(noise),
                      "chromiumFullSha256": len(inputs), "gridRowsPerFormat": 7_500_000,
                      "totalFileBytes": sum(r["bytes"] for r in single + grid + noise)}))


if __name__ == "__main__":
    main()
