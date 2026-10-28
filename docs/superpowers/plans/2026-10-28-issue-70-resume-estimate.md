# Core Resume and Cost Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Lab.resume` for incomplete artifacts and `Lab.estimate` for deterministic pre-run cost estimates.

**Architecture:** Keep artifact integrity in `results`, task selection in `execution`, and document/version validation in `Lab`. Resume preserves valid task files, removes and recomputes only invalid tasks, then atomically replaces summary and manifest. Estimation walks compiled IR without starting KSL and applies S1 timing plus S3/S5 size anchors.

**Tech Stack:** Kotlin/JVM 25, kotlinx.serialization, KSLCore R1.8.1, JUnit 5, AssertJ.

**Spec:** `docs/superpowers/plans/2026-10-28-stage-1-track-t1-core.md`, section T1.7; ADR 0008 and 0009.

## Global Constraints

- Same application version and canonical model/experiment hashes are mandatory; mismatches produce diagnostics asking for a fresh run.
- Resumed and uninterrupted artifacts are byte-identical, including gzip files and manifest ordering.
- Summary is rebuilt only from persisted `replication.json` files in variant/point/replication order.
- No API, CLI, UI, new dependency, artifact schema change, or automatic pilot run.
- Estimation supports drafts like `Lab.validate` and never starts a model.
- Existing Windows symlink fix is a separate commit and is not part of this feature.

## Review Focus

- Missing, malformed, stale, or checksum-mismatched task files must force recomputation of their owning task.
- Extra files from a partial task must not survive into the resumed manifest.
- Cancellation during resume must leave an incomplete, resumable artifact without a summary.
- An incomplete manifest with all tasks valid must rebuild summary without running KSL.
- Large grids and models must produce arithmetic-safe estimates and explicit ADR 0008 cache warnings.

---

### Task 1: Artifact Integrity and Replacement

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/results/RunArtifact.kt`
- Create: `core/src/main/kotlin/resiliencelab/core/results/ResumeArtifact.kt`
- Create: `core/src/main/kotlin/resiliencelab/core/execution/ExperimentTask.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/workspace/FileWorkspaceTest.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/RunArtifactTest.kt`

**Interfaces:**
- Produces: `Workspace.delete(path: String)`, idempotent for a missing regular file and confined like writes.
- Produces: `ArtifactWriter.rewrite(runDirectory, manifest, summary)`, replacing existing summary/manifest but excluding `manifest.json` from `parts`.
- Produces: `ResumeArtifact.prepare(runDirectory, manifest, tasks): Set<ExperimentTask>`; returns invalid tasks and removes their files, stale summary, and unrelated regular files in the run directory.

- [ ] **Step 1: Write failing deletion and rewrite tests**

Assert delete removes a regular file, ignores a second delete, and rejects `../outside`. Assert rewrite replaces old summary/manifest, computes their new hashes, and does not include `manifest.json` in `parts`.

- [ ] **Step 2: Run tests to verify RED**

Run: `./gradlew :core:test --tests 'resiliencelab.core.workspace.FileWorkspaceTest' --tests 'resiliencelab.core.results.RunArtifactTest'`
Expected: compilation fails because `delete` and `rewrite` are absent.

- [ ] **Step 3: Implement storage and publication primitives**

Make the private file mutation helper generic so delete returns `Unit`. Keep existing create/write behavior unchanged. Implement rewrite through the existing uninterrupted artifact writer.

- [ ] **Step 4: Write failing integrity tests**

Use one completed example artifact. For each corruption of `replication.json`, `index.json`, and gzip bytes, assert only that task is returned. Assert missing files and stale extra task files are removed, valid task bytes remain untouched, and stale `summary.json` is deleted.

- [ ] **Step 5: Run integrity tests to verify RED, implement, then verify GREEN**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.RunArtifactTest'`
Expected: initial compilation failure, then PASS after `ResumeArtifact` validates parsed formats, manifest hashes, index hashes, and actual stored bytes.

- [ ] **Step 6: Commit**

```bash
git add core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt core/src/main/kotlin/resiliencelab/core/results core/src/test/kotlin/resiliencelab/core
 git commit -m "feat: add artifact resume integrity checks"
```

### Task 2: Selective `Lab.resume`

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/execution/ExperimentExecutor.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/lab/Lab.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/lab/LabTest.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/ArtifactPipelineTest.kt`

**Interfaces:**
- Consumes: `ExperimentTask` from Task 1.
- Produces: internal `ExperimentExecutor.runSelected(experiment, tasks, isCancelled, onWindow, onReplication, onProgress)`, preserving original replication numbers and reporting progress against selected tasks.
- Produces: `Lab.resume(runDirectory: String, isCancelled: () -> Boolean = { false }, onProgress: (Int, Int) -> Unit = { _, _ -> }): RunOutcome`.

- [ ] **Step 1: Write the failing cancelled/resumed equality test**

Create continuous and cancelled copies of `retry-storm`. Cancel after the first progress callback, corrupt one completed gzip part, resume, and recursively compare every regular file byte-for-byte with the continuous artifact. Assert the resumed manifest is complete.

- [ ] **Step 2: Run the equality test to verify RED**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.LabTest'`
Expected: compilation fails because `resume` is absent.

- [ ] **Step 3: Implement selected execution and resume**

Validate canonical run location, schema/application versions, canonical document hashes, and manifest execution metadata before mutation. Use diagnostics `RUN_COMPLETE`, `RUN_INCOMPATIBLE`, and `RUN_DOCUMENT_CHANGED`; incompatibility text includes `run again`. Reuse `SeriesWriter`, `ArtifactWriter.summarize`, and uninterrupted publication. Cancellation rewrites `complete: false` without a summary.

- [ ] **Step 4: Add refusal, no-work, and repeated-cancellation tests**

Assert changed model and incompatible application version leave all artifact bytes untouched and return their diagnostic codes. Assert a valid-tasks/incomplete-manifest case performs zero model executions. Assert cancellation during resume leaves no summary and permits another resume.

- [ ] **Step 5: Run resume and artifact pipeline tests**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.LabTest' --tests 'resiliencelab.core.results.ArtifactPipelineTest'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/src/main/kotlin/resiliencelab/core/execution core/src/main/kotlin/resiliencelab/core/lab core/src/test/kotlin/resiliencelab/core
 git commit -m "feat: resume incomplete experiment artifacts"
```

### Task 3: Deterministic `Lab.estimate`

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/execution/CostEstimator.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/lab/Lab.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/execution/CostEstimatorTest.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/lab/LabTest.kt`

**Interfaces:**
- Produces: serializable `ExperimentEstimate(tasks, expectedEvents, expectedRows, workers, estimatedSeconds, estimatedUncompressedBytes, estimatedArtifactBytes, estimatedParts, warnings)` and `EstimateWarning(code, message)`.
- Produces: `Lab.estimate(experimentPath: String, drafts: Map<String, String> = emptyMap(), workers: Int = ExperimentExecutor.defaultWorkers()): ExperimentEstimate`.

- [ ] **Step 1: Write failing formula and facade tests**

For `retry-storm`, assert 4 tasks, positive event/row/byte counts, 4 estimated parts at one worker, and no KSL invocation. Assert workers affect only time, drafts affect the estimate, invalid workers are rejected, and estimates do not create `.results`. For a synthetic model whose estimated uncompressed task data exceeds 64 MiB, assert `ESTIMATE_UI_CACHE`.

- [ ] **Step 2: Run estimator tests to verify RED**

Run: `./gradlew :core:test --tests 'resiliencelab.core.execution.CostEstimatorTest' --tests 'resiliencelab.core.lab.LabTest'`
Expected: compilation fails because estimate types and methods are absent.

- [ ] **Step 3: Implement S1/S3/S5 formulas**

Use `N = rate × (warmup + measurement)`, configured attempt multipliers for visits, activation/seize/processing/network/timeout/resumption events, and window/fault/monitor events. Interpolate S1 anchors at 50/500/5000 services and speedups at 1/2/4/8 workers, retain the longest-task lower bound, and warn on extrapolation. Use 512 uncompressed bytes per node-window (S3 metrics plus S5 sketch/JSON allowance), S3 gzip ratio 0.25, and 4 MiB part splitting. Include task metadata allowance and the 64 MiB decoded-cache warning.

- [ ] **Step 4: Verify estimator tests and calibrate the example**

Run: `./gradlew :core:test --tests 'resiliencelab.core.execution.CostEstimatorTest' --tests 'resiliencelab.core.lab.LabTest'`
Expected: PASS. Measure `Lab.run` wall time separately from JVM/Gradle startup; accept the S1 estimate when it is within 8× of measured time, documenting that models below 50 services and this hardware are outside S1 anchors.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/resiliencelab/core/execution/CostEstimator.kt core/src/main/kotlin/resiliencelab/core/lab/Lab.kt core/src/test/kotlin/resiliencelab/core
 git commit -m "feat: estimate experiment execution cost"
```

### Task 4: Documentation and Final Verification

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/results-format.md`
- Modify: `docs/superpowers/specs/2026-10-27-stage-1-design.md`

- [ ] **Step 1: Update current contracts**

Document core-only resume/estimate signatures, selective integrity behavior, estimate fields and the 8× calibration bound. Keep API and CLI assigned to T2.

- [ ] **Step 2: Run all required checks**

Run: `./gradlew clean build`
Expected: `BUILD SUCCESSFUL`; Windows-only symlink tests may report skipped when the privilege is unavailable.

Run: `git diff --check origin/main` and inspect `git diff origin/main --stat` plus the full diff.
Expected: no whitespace errors or unrelated files.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/results-format.md docs/superpowers/specs/2026-10-27-stage-1-design.md docs/superpowers/plans/2026-10-28-issue-70-resume-estimate.md
 git commit -m "docs: record core resume and estimate contracts"
```
