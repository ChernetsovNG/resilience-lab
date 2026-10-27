#!/usr/bin/env python3
"""Reproduce S1 macrobenchmarks. Only stdlib; JVM forks run sequentially."""
import argparse
import csv
import datetime
import json
import os
from pathlib import Path
import platform
import re
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def read_csv(path):
    with path.open(newline="") as stream:
        return list(csv.DictReader(stream))


def write_csv(path, rows):
    with path.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forks", type=int, default=3)
    parser.add_argument("--warmups", type=int, default=2)
    parser.add_argument("--output", type=Path, default=ROOT / "build" / "measurements")
    args = parser.parse_args()
    if args.forks < 1 or args.warmups < 0:
        parser.error("forks >= 1 and warmups >= 0 required")
    output = args.output.resolve()
    if output.exists():
        parser.error("output already exists; choose a new directory to preserve earlier evidence")
    output.mkdir(parents=True)
    java_home = os.environ.get("JAVA_HOME")
    java = str(Path(java_home) / "bin" / "java") if java_home else "java"
    classpath = str(ROOT / "build/install/ksl-capabilities/lib/*")
    cases = [(b, n, "none", 1, 1) for b in (50, 500, 5000) for n in (60_000, 400_000)]
    cases += [(b, n, mode, 1, 1) for b, n in ((500, 400_000), (5000, 60_000)) for mode in ("series", "trace", "both")]
    cases += [(500, 60_000, "none", p, 8) for p in (1, 2, 4, 8)]
    cases += [(500, 200_000, "none", 1, 1)]  # held-out cost-estimate validation
    environment = {
        "recorded_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "platform": platform.platform(), "python": platform.python_version(),
        "java": subprocess.check_output([java, "-version"], stderr=subprocess.STDOUT, text=True).strip(),
        "base_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "jvm_flags": ["-Xms512m", "-Xmx2g", "-XX:+UseG1GC"],
        "forks": args.forks, "warmups_per_fork": args.warmups,
        "notes": "No background-load isolation or thermal control; local exploratory benchmark.",
    }
    if sys.platform == "darwin":
        for key in ("machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize"):
            environment[key] = subprocess.check_output(["sysctl", "-n", key], text=True).strip()
        environment["power"] = subprocess.check_output(["pmset", "-g", "batt"], text=True).strip()
    (output / "environment.json").write_text(json.dumps(environment, indent=2) + "\n")
    rows, replication_rows = [], []
    reference = {}
    for fork in range(1, args.forks + 1):
        # Rotate order without changing logical replication identities or seeds.
        shift = ((fork - 1) * 5) % len(cases)
        for blocks, requests, mode, workers, reps in cases[shift:] + cases[:shift]:
            case_id = f"b{blocks}-n{requests}-{mode}-p{workers}-r{reps}-f{fork}"
            directory = output / case_id
            directory.mkdir()
            time_log = directory / "time.txt"
            timing = ["/usr/bin/time", "-l", "-o", str(time_log)] if sys.platform == "darwin" else ["/usr/bin/time", "-v", "-o", str(time_log)]
            command = timing + [java, *environment["jvm_flags"], "-cp", classpath, "resiliencelab.research.ksl.BenchmarkKt", str(blocks), str(requests), mode, str(workers), str(reps), str(args.warmups), str(directory)]
            with (directory / "process.log").open("w") as log:
                subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=1800)
            row = read_csv(directory / "summary.csv")[0]
            timing_text = time_log.read_text()
            if sys.platform == "darwin":
                peak_rss = int(re.search(r"(\d+)\s+maximum resident set size", timing_text)[1])
            else:
                peak_rss = int(re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", timing_text)[1]) * 1024
            row.update(fork=fork, case_id=case_id, peak_rss_bytes=peak_rss)
            rows.append(row)
            for rep in read_csv(directory / "replications.csv"):
                # Instrumentation and worker count must not perturb any client's result.
                key = (blocks, requests, rep["replication"])
                hashes = reference.setdefault(key, {})
                for field in ("semantic_sha256", "series_sha256", "trace_sha256"):
                    if rep[field] == "none":
                        continue
                    if field in hashes and hashes[field] != rep[field]:
                        raise AssertionError(f"Reproducibility failure: {case_id} replication={key[-1]} {field}")
                    hashes[field] = rep[field]
                replication_rows.append(dict(case_id=case_id, **rep))
            write_csv(output / "measurements.csv", rows)
            write_csv(output / "replications.csv", replication_rows)
            print(f"{len(rows)}/{len(cases) * args.forks} {case_id}: {float(row['batch_ms'])/1000:.3f}s, RSS {peak_rss / 2**20:.0f} MiB", flush=True)
    groups = {}
    for row in rows:
        key = tuple(row[k] for k in ("blocks", "requests", "mode", "workers", "replications"))
        groups.setdefault(key, []).append(row)
    medians = []
    fields = ("batch_ms", "simulation_ms_sum", "build_ms_sum", "collection_ms_sum", "write_ms_sum", "file_hash_ms_sum", "heap_sampled_peak_bytes", "peak_rss_bytes", "events", "series_bytes", "trace_bytes")
    for key, samples in groups.items():
        row = dict(zip(("blocks", "requests", "mode", "workers", "replications"), key))
        for field in fields:
            row[field] = statistics.median(float(s[field]) for s in samples)
        row["batch_min_ms"] = min(float(s["batch_ms"]) for s in samples)
        row["batch_max_ms"] = max(float(s["batch_ms"]) for s in samples)
        medians.append(row)
    write_csv(output / "medians.csv", medians)
    (output / "verification.txt").write_text(f"PASS: {len(rows)} fresh JVM forks; {len(replication_rows)} measured replications; exact semantic/artifact hashes matched wherever comparable.\n")


if __name__ == "__main__":
    main()
