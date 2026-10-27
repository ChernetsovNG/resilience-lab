#!/usr/bin/env python3
"""Three fresh JVMs; preserves raw rows, environment and source hashes without host/user names."""
import argparse
import csv
import hashlib
import pathlib
import statistics
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True, type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent
args.output.mkdir(parents=True, exist_ok=False)
rows = []
for run in range(1, 4):
    result = subprocess.run(
        ["java", "-Xms256m", "-Xmx2g", "-cp", str(root / "build/install/ksl-streams/lib/*"),
         "resiliencelab.research.streams.MeasurementsKt"],
        text=True, capture_output=True, check=True, timeout=180,
    )
    (args.output / f"run-{run}.csv").write_text(result.stdout)
    (args.output / f"run-{run}-environment.txt").write_text(result.stderr)
    parsed = list(csv.DictReader(result.stdout.splitlines()))
    assert len(parsed) == 17, f"Incomplete measurement set: {len(parsed)} rows"
    rows.extend(dict(run=run, **row) for row in parsed)

with (args.output / "measurements.csv").open("w") as out:
    writer = csv.DictWriter(out, fieldnames=rows[0].keys(), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
groups = {}
for row in rows:
    key = tuple(row[k] for k in ("phase", "sources", "replications", "address"))
    groups.setdefault(key, []).append(row)
with (args.output / "medians.csv").open("w") as out:
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["phase", "sources", "replications", "address",
                     "median_ms", "min_ms", "max_ms", "median_retained_heap_bytes"])
    for key, group in groups.items():
        assert len({row["checksum"] for row in group}) == 1, f"Non-reproducible checksum: {key}"
        elapsed = [float(row["elapsed_ms"]) for row in group]
        heap = [int(row["retained_heap_bytes"]) for row in group]
        writer.writerow([*key, statistics.median(elapsed), min(elapsed), max(elapsed), statistics.median(heap)])
with (args.output / "source-sha256.txt").open("w") as out:
    files = [*root.glob("*.kts"), root / "oracle.py", pathlib.Path(__file__), *root.glob("src/**/*.kt")]
    for path in sorted(files):
        out.write(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(root)}\n")
with (args.output / "jars-sha256.txt").open("w") as out:
    for path in sorted((root / "build/install/ksl-streams/lib").glob("*.jar")):
        out.write(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
print(f"Verified 3 JVMs, {len(rows)} rows, identical checksums; results: {args.output}")
