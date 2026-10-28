#!/usr/bin/env python3
"""Reproduce S5 checks. Timings vary; canonical payload hashes must not."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    project = Path(__file__).resolve().parent
    repository = project.parents[1]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    launcher = project / "build/install/latency-sketch/bin/latency-sketch"
    if not launcher.is_file():
        raise SystemExit("First run: ./gradlew -p research/latency-sketch installDist")

    def run(command, name, cwd=repository):
        print(name, flush=True)
        with (output / (name + ".log")).open("w") as log:
            subprocess.run([str(arg) for arg in command], cwd=cwd, stdout=log,
                           stderr=subprocess.STDOUT, check=True)

    run([launcher, "verify", output], "verify")
    run([launcher, "retry", output, repository], "retry")
    # One shared corpus lets Chromium verify actual retry-storm samples too.
    fixtures = json.loads((output / "fixtures.json").read_text())
    retry = json.loads((output / "retry-fixtures.json").read_text())
    fixtures["cases"].extend(retry["cases"])
    (output / "fixtures.json").write_text(json.dumps(fixtures, separators=(",", ":")) + "\n")
    for fork in range(3):
        run([launcher, "measure", output / ("insert-" + str(fork))], "insert-" + str(fork))
    for blocks in (50, 500, 5000):
        for requests in (60000, 400000):
            name = "s1-" + str(blocks) + "-" + str(requests)
            run([launcher, "s1", output / name, blocks, requests], name)
    run([launcher, "sizes", output], "sizes")
    run(["node", "run.mjs", output], "browser", cwd=project / "browser")
    paths = []
    for directory in (project, repository / "research/ksl-capabilities/src/main/kotlin",
                      repository / "core/src/main/kotlin", repository / "examples/retry-storm"):
        for root, dirs, files in os.walk(directory):
            dirs[:] = [d for d in dirs if d not in {"build", ".gradle", ".kotlin", "node_modules", "dist", "results"}]
            paths.extend(Path(root) / name for name in files)
    hashes = {str(path.relative_to(repository)): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted(set(paths))}
    (output / "source-sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    jars = {}
    for name in ("latency-sketch.jar", "core.jar", "sketches-java-0.8.3.jar", "KSLCore-R1.8.1.jar", "jol-core-0.17.jar"):
        path = launcher.parent.parent / "lib" / name
        jars[name] = {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    (output / "jars.json").write_text(json.dumps(jars, indent=2) + "\n")
    (output / "verification.txt").write_text("PASS: accuracy, deterministic merges, guards, retry-storm, S1, sizes, Chromium\n")
    print("PASS: " + str(output))


if __name__ == "__main__":
    main()
