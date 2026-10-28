# Issue 89 Resume and Estimate API/CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose core run resume and cost estimation through the REST API and CLI, including incomplete runs in the run catalog.

**Architecture:** Keep API and CLI as thin adapters over `Lab`. `RunCatalog` reads both complete and incomplete manifests; a shared `Lab.validateResume` preflight rejects invalid resume requests before job submission, while `Lab.resume` repeats all checks at execution.

**Tech Stack:** Kotlin/JVM 25, kotlinx.serialization, Spring Boot 4.1.2, springdoc OpenAPI, Gradle, AssertJ, generated TypeScript API types.

**Spec:** `docs/superpowers/plans/2026-10-28-stage-1-track-t2-server-cli.md`, section T2.3; `docs/superpowers/specs/2026-10-27-stage-1-design.md`, sections 4.5 and 5.2–5.3; ADR 0008–0010.

## Global Constraints

- No new dependencies and no UI buttons.
- API and CLI call the same `Lab` operations and preserve core diagnostics.
- API responses contain every field; OpenAPI and `web/src/api/schema.d.ts` are regenerated, not hand-edited.
- Unknown runs return 404; complete runs return 409 `RUN_COMPLETE`; incomplete summaries return 404 `RUN_INCOMPLETE`.
- Resume works in place and produces bytes identical to a continuous run with the same documents and seed.
- Every commit uses Conventional Commits and `Co-authored-by: Kimi <noreply@moonshot.ai>`.

## Review Focus

- A document changed after API preflight but before execution must fail without mutating the artifact; pin in `JobServiceTest`.
- A second resume after publication must return `RUN_COMPLETE`, not recompute; pin in `ResumeApiTest`.
- An incomplete run must expose its manifest and finished series but not a summary; pin in `ResumeApiTest`.
- CLI resume must accept IDs and workspace-internal paths but reject traversal; pin in `CliTest`.
- Estimate drafts must change only the estimate, never stored documents or `.results/`; pin in `EstimateApiTest` and `CliTest`.

---

### Task 1: Run catalog includes incomplete artifacts

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/results/RunCatalog.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/RunCatalogTest.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/ArtifactPipelineTest.kt`
- Create: `docs/superpowers/plans/2026-10-28-issue-89-resume-estimate-api-cli.md`

**Interfaces:**
- Produces: `RunEntry(id, experiment, directory, complete)`, `RunCatalog.entry(id): RunEntry?`, and `RunIncompleteException` for summary reads of incomplete runs.
- Later tasks consume `entry` to resolve API/CLI resume targets and `complete` for API responses.

- [ ] **Step 1: Write failing catalog tests**

Replace the old incomplete-run assertions: both complete and incomplete runs are listed newest first with the correct `complete` flag; `entry` and `manifest` read either state; `summary` throws `RunIncompleteException` only for incomplete runs. Update `ArtifactPipelineTest` to expect one incomplete entry with `complete == false`.

- [ ] **Step 2: Run tests to verify failure**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.RunCatalogTest' --tests 'resiliencelab.core.results.ArtifactPipelineTest'`
Expected: FAIL because incomplete runs are filtered and `RunEntry.complete` does not exist.

- [ ] **Step 3: Implement catalog behavior**

Add `complete` to `RunEntry`, expose `entry(id)`, list both states, and make only `summary` reject incomplete runs. Keep manifest version checks and series reads unchanged so finished tasks remain readable.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/resiliencelab/core/results/RunCatalog.kt core/src/test/kotlin/resiliencelab/core/results/RunCatalogTest.kt core/src/test/kotlin/resiliencelab/core/results/ArtifactPipelineTest.kt docs/superpowers/plans/2026-10-28-issue-89-resume-estimate-api-cli.md
git commit -m "feat(core): expose incomplete runs" -m "Co-authored-by: Kimi <noreply@moonshot.ai>"
```

### Task 2: Shared resume preflight

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/lab/Lab.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/lab/LabTest.kt`

**Interfaces:**
- Consumes: existing `Lab.resume(runDirectory, isCancelled, onProgress)`.
- Produces: `Lab.validateResume(runDirectory): RunManifest`, which performs all non-mutating checks under the same per-run lock and returns the validated manifest.

- [ ] **Step 1: Write failing preflight tests**

Prove valid incomplete artifacts pass without byte changes or KSL execution; complete artifacts throw `InvalidExperimentException` with `RUN_COMPLETE`; changed documents throw `RUN_DOCUMENT_CHANGED` before mutation.

- [ ] **Step 2: Run tests to verify failure**

Run: `./gradlew :core:test --tests 'resiliencelab.core.lab.LabTest'`
Expected: FAIL because `validateResume` does not exist.

- [ ] **Step 3: Extract shared validation**

Move manifest reading, version/canonical-path checks, document compilation and hash/metadata checks into one private preparation function. Call it from both `validateResume` and `resume`; keep `ResumeArtifact.prepare` and all mutations exclusively in `resume`.

- [ ] **Step 4: Run all core Lab tests**

Run the command from Step 2. Expected: PASS, including existing byte-identity, corruption and concurrency tests.

- [ ] **Step 5: Commit**

```bash
git add core/src/main/kotlin/resiliencelab/core/lab/Lab.kt core/src/test/kotlin/resiliencelab/core/lab/LabTest.kt
git commit -m "feat(core): add resume preflight" -m "Co-authored-by: Kimi <noreply@moonshot.ai>"
```

### Task 3: Estimate endpoint

**Files:**
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/Documents.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/ValidationController.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/ApiTypes.kt`
- Create: `apps/server/src/main/kotlin/resiliencelab/server/lab/EstimateController.kt`
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/EstimateApiTest.kt`
- Modify: `apps/server/src/test/kotlin/resiliencelab/server/lab/OpenApiSpecTest.kt`
- Generate: `apps/server/openapi.json`
- Generate: `web/src/api/schema.d.ts`

**Interfaces:**
- Consumes: `Lab.estimate(experimentPath, drafts): ExperimentEstimate` and the same `ValidationRequest` JSON as validation.
- Produces: `POST /api/v1/estimate`, returning the core `ExperimentEstimate` directly.

- [ ] **Step 1: Write failing API tests**

Assert API output equals `Lab.estimate` on the same workspace; a model draft changes the estimate without changing stored files or creating `.results/`; invalid experiments and duplicate/ambiguous draft paths return documented 400 responses.

- [ ] **Step 2: Run tests to verify failure**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.EstimateApiTest'`
Expected: FAIL with 404 for `/api/v1/estimate`.

- [ ] **Step 3: Implement shared draft conversion and endpoint**

Move duplicate-safe `List<DocumentDraft> -> Map<String, String>` conversion into `Documents`; use it from validation and estimation. Return `lab.estimate(request.experiment, drafts)` without a wrapper.

- [ ] **Step 4: Regenerate contracts and run tests**

Run the Step 2 test, `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`, then `npm run api:types` from `web`. Add `/api/v1/estimate` and estimate schemas to `OpenApiSpecTest`; run server tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/server/openapi.json web/src/api/schema.d.ts
git commit -m "feat(server): add estimate endpoint" -m "Co-authored-by: Kimi <noreply@moonshot.ai>"
```

### Task 4: Resume endpoint and incomplete-run API behavior

**Files:**
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/JobService.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/RunController.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/LabExceptionHandler.kt`
- Test: `apps/server/src/test/kotlin/resiliencelab/server/lab/JobServiceTest.kt`
- Create: `apps/server/src/test/kotlin/resiliencelab/server/lab/ResumeApiTest.kt`
- Modify: `apps/server/src/test/kotlin/resiliencelab/server/lab/OpenApiSpecTest.kt`
- Generate: `apps/server/openapi.json`
- Generate: `web/src/api/schema.d.ts`

**Interfaces:**
- Consumes: `RunCatalog.entry`, `Lab.validateResume`, and `Lab.resume` from Tasks 1–2.
- Produces: `JobService.resume(run: RunEntry): JobView` and `POST /api/v1/runs/{id}/resume` returning 202 with a job whose `runId` is the resumed run ID.

- [ ] **Step 1: Write failing service and API tests**

Cover API cancellation followed by resume to bytes identical to a continuous run; list `complete == false`; summary 404 `RUN_INCOMPLETE`; manifest and a finished task index remain readable; unknown run 404; repeated resume 409 `RUN_COMPLETE`; changed documents 400 with core `RUN_DOCUMENT_CHANGED`. In `JobServiceTest`, change a document after preflight and before a queued execution and assert a failed job without artifact mutation.

- [ ] **Step 2: Run tests to verify failure**

Run: `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.ResumeApiTest' --tests 'resiliencelab.server.lab.JobServiceTest'`
Expected: FAIL because resume submission and incomplete-summary mapping do not exist.

- [ ] **Step 3: Implement resume jobs and error mapping**

Resolve the run in `RunController`, preflight in `JobService.resume`, map core `RUN_COMPLETE` to `Conflict`, and schedule `Lab.resume` with the same cancellation/progress lifecycle as run jobs. Map `RunIncompleteException` to 404 `RUN_INCOMPLETE`; update KDoc for new error codes.

- [ ] **Step 4: Regenerate contracts and run server tests**

Run the Step 2 tests, regenerate OpenAPI and TypeScript as in Task 3, add `/api/v1/runs/{id}/resume` to `OpenApiSpecTest`, then run `./gradlew :apps:server:test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/server/openapi.json web/src/api/schema.d.ts
git commit -m "feat(server): add resume endpoint" -m "Co-authored-by: Kimi <noreply@moonshot.ai>"
```

### Task 5: CLI estimate/resume and documentation

**Files:**
- Modify: `apps/cli/src/main/kotlin/resiliencelab/cli/Main.kt`
- Test: `apps/cli/src/test/kotlin/resiliencelab/cli/CliTest.kt`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-10-27-stage-1-design.md`

**Interfaces:**
- Consumes: `Lab.estimate`, `Lab.resume`, `RunCatalog.entry`, and shared resume preflight from earlier tasks.
- Produces: `estimate <experiment>` printing one `ExperimentEstimate` JSON line; `resume <run>` accepting a run ID or workspace-internal run-directory path and printing exactly the same outcome format as `run`.

- [ ] **Step 1: Write failing CLI tests**

Assert estimate JSON equals `Lab.estimate` and leaves no results. Resume cancelled artifacts by ID and absolute directory path; compare every resulting file with a continuous run. Cover invalid estimate, unknown/traversal/complete resume, pre-cancelled resume code 130, usage text, and installed-launcher estimate/resume output.

- [ ] **Step 2: Run tests to verify failure**

Run: `./gradlew :apps:cli:test`
Expected: FAIL because both commands are absent from parsing and usage.

- [ ] **Step 3: Implement commands and shared outcome printing**

Parse both commands, enable `SignalCancellation` for `resume`, resolve IDs through `RunCatalog.entry`, validate workspace paths, call the core methods, and extract the existing run summary output for reuse. Preserve stdout/stderr separation and exit codes 0/1/2/130.

- [ ] **Step 4: Update documented behavior and run CLI tests**

Document both commands, JSON estimate output, incomplete run listing/summary behavior, resume errors and signal handling in `AGENTS.md`; update the stage 1 signal wording from `run` to `run`/`resume`. Run `./gradlew :apps:cli:test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src AGENTS.md docs/superpowers/specs/2026-10-27-stage-1-design.md
git commit -m "feat(cli): add estimate and resume" -m "Co-authored-by: Kimi <noreply@moonshot.ai>"
```

### Final verification

- [ ] Run `./gradlew clean build` from the repository root; expect `BUILD SUCCESSFUL`.
- [ ] From `web`, run `npm ci && npm run lint && npm run api:check && npm test -- --run && npm run build && npm run test:e2e`; expect all commands to pass.
- [ ] Run `git diff --check origin/main` and inspect `git diff origin/main --stat` plus the full diff for scope and generated-contract consistency.
- [ ] Fetch and rebase onto `origin/main`; rerun affected verification if the rebase changes the result.
- [ ] Push with `git push -u origin HEAD` and open a PR containing `Closes #89`, verification results, new error codes, and unrelated findings.
