# T4.1 Results Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the stage 1 results panel with summary uncertainty, pooled handler utilization, grid-point context, catalog assumptions, run conditions, stale-result marking, cancellation, and three panel sizes.

**Architecture:** Extend the core catalog additively and regenerate the existing OpenAPI and TypeScript contracts. Keep run artifacts and the submitted model/experiment snapshot in `useRun`; keep point selection and panel size outside documents and undo history. Build the panel from the existing React components and CSS grid without new dependencies.

**Tech Stack:** Kotlin/JDK 25, kotlinx.serialization, Spring Boot, OpenAPI, React 19, TypeScript, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/plans/2026-10-28-stage-1-track-t4-web-results.md`, section T4.1; `docs/superpowers/specs/2026-10-27-stage-1-design.md`, sections 4.3–4.6 and 6.3.

## Global Constraints

- No Timeline, Map, conclusion text, estimate, resume, or opening historical runs.
- Results are read-only; point selection and panel size never enter documents or undo/redo.
- Summary keeps every variant/point row and existing unclipped Student 95% confidence limits.
- Handler utilization is pooled `busyHandlerTimeMs / handlerCapacityTimeMs`, not an average of replication ratios.
- Assumption text lives in the core catalog in English; run conditions come only from the run manifest.
- Cancel uses `POST /api/v1/jobs/{id}/cancel`; 409 `JOB_FINISHED` refreshes the job instead of showing an error.
- No new dependencies. The page never scrolls; only panel bodies and wide tables may scroll.
- Regenerate and commit `apps/server/openapi.json` and `web/src/api/schema.d.ts` through the standard commands.

## Review Focus

- Zero handler capacity and missing metrics must render `n/a`, never `NaN` or `Infinity` (Task 3 utilization tests).
- A cancelled job has no summary and must not become a generic `JOB_FAILED` problem (Task 2 cancellation tests).
- A 409 cancellation race must publish the terminal job and still load a completed summary (Task 2 race test).
- Undoing edits back to the submitted documents must clear stale marking; comparing object identity is insufficient (Task 4 structural-equality test).
- Collapsed and workspace-height states must preserve the one-screen layout at 1280×720 (Task 5 unit state test and Task 6 E2E).

---

### Task 1: Catalog Assumptions and API Contract

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/catalog/Catalog.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/catalog/Stage1Catalog.kt`
- Modify: `core/src/test/kotlin/resiliencelab/core/catalog/Stage1CatalogTest.kt`
- Modify: `apps/server/src/test/kotlin/resiliencelab/server/lab/WorkspaceApiTest.kt`
- Generate: `apps/server/openapi.json`
- Generate: `web/src/api/schema.d.ts`

**Interfaces:**
- Produces: `Catalog.assumptions: List<String>` and `TypeDescriptor.assumptions: List<String>`, both serialized and non-empty for the stage 1 catalog and each of its four types.

- [ ] **Step 1: Write failing catalog and API tests**
  Assert global cohort/event-window/sketch/Student assumptions and non-empty per-type assumptions. Assert service handler retention, call orphaned work/late-response/no-cancellation semantics, and OpenAPI-conformant `GET /api/v1/catalog` arrays.
- [ ] **Step 2: Run the tests to verify they fail**
  Run `./gradlew :core:test --tests 'resiliencelab.core.catalog.Stage1CatalogTest' :apps:server:test --tests 'resiliencelab.server.lab.WorkspaceApiTest'`; expect missing `assumptions` properties.
- [ ] **Step 3: Add the additive catalog fields and English texts**
  Cover handler retention through calls/backoff, orphaned work, discarded late responses, no downstream cancellation, measurement cohort/run-out, event-time windows, 0.78125% sketch representation bound, and unclipped Student intervals. Every stage 1 type receives at least one assumption.
- [ ] **Step 4: Regenerate contracts and run focused checks**
  Run `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`, then `npm run api:types` from `web`, then the focused JVM tests; expect PASS.
- [ ] **Step 5: Commit**
  `git add` the Task 1 files and commit `feat: expose model assumptions in catalog`.

### Task 2: Run Artifacts, Submitted Documents, and Cancellation

**Files:**
- Modify: `web/src/api/apiClient.ts`
- Modify: `web/src/api/apiTypes.ts`
- Modify: `web/src/api/apiClient.test.ts`
- Modify: `web/src/run/useRun.ts`
- Modify: `web/src/run/useRun.test.ts`
- Modify: `web/src/layout/TopBar.tsx`
- Modify: `web/src/layout/TopBar.test.tsx`
- Modify: `web/src/test/fixtures.ts`

**Interfaces:**
- Consumes: generated `RunManifest` and existing job/cancel endpoints.
- Produces: `Run.manifest`, `Run.documents` (submitted `{ model, experiment }`), `Run.cancel(): Promise<void>`; `run(experimentPath, documents)` accepts the submission snapshot. `api.runManifest(runId)` and `api.cancelJob(id)` return typed data.

- [ ] **Step 1: Write failing API and hook tests**
  Verify encoded manifest/cancel URLs and POST method. Extend completion to require summary plus manifest. Test queued/running cancellation, `cancelRequested`, `CANCELLED` without `JOB_FAILED`, and 409 `JOB_FINISHED` followed by terminal-job refresh. Test reset/new-run generation guards.
- [ ] **Step 2: Run focused tests to verify they fail**
  Run `npm test -- --run src/api/apiClient.test.ts src/run/useRun.test.ts src/layout/TopBar.test.tsx` from `web`; expect missing methods/properties.
- [ ] **Step 3: Implement artifact loading and cancellation**
  Load summary and manifest together after completion. Store the submitted document snapshot. Poll until terminal state; leave cancelled summary/manifest null. On 409 `JOB_FINISHED`, fetch and publish the current job. Add TopBar Cancel only for queued/running jobs and expose cancellation-requested status.
- [ ] **Step 4: Run focused tests to verify they pass**
  Repeat Step 2; expect PASS.
- [ ] **Step 5: Commit**
  `git add` the Task 2 files and commit `feat: load run conditions and cancel jobs`.

### Task 3: Summary Metrics and Grid-Point Context

**Files:**
- Modify: `web/src/layout/SummaryTable.tsx`
- Modify: `web/src/layout/SummaryTable.test.tsx`
- Modify: `web/src/layout/ResultsPanel.tsx`
- Modify: `web/src/layout/ResultsPanel.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `SummaryTable({ summary, activeVariantId, selectedPointId })`; `ResultsPanel` receives `selectedPointId` and `onPointChange`. Point IDs come from summary variants; no grid hides the selector and uses `p0`.

- [ ] **Step 1: Write failing rendering and selection tests**
  Assert every variant/point row, existing CI/unit text, per-service amplification, and pooled utilization (`1000 / 2000 = 50.0%`). Cover missing totals and zero capacity. Assert active-variant and selected-point row classes, coordinate-bearing selector options, selection callback, and no selector for an empty grid.
- [ ] **Step 2: Run focused tests to verify they fail**
  Run `npm test -- --run src/layout/SummaryTable.test.tsx src/layout/ResultsPanel.test.tsx` from `web`; expect missing utilization and selector.
- [ ] **Step 3: Implement metrics and shared point selection**
  Compute utilization once from pooled totals. Keep all rows visible and highlight the active variant and selected point. Store selected point in `App`, reset to `p0` for a new summary, and pass it to the panel without changing workspace history.
- [ ] **Step 4: Run focused tests to verify they pass**
  Repeat Step 2 and add `src/App.test.tsx`; expect PASS.
- [ ] **Step 5: Commit**
  `git add` the Task 3 files and commit `feat: add summary utilization and point selection`.

### Task 4: Assumptions and Stale Results

**Files:**
- Create: `web/src/layout/Assumptions.tsx`
- Create: `web/src/layout/Assumptions.test.tsx`
- Modify: `web/src/layout/ResultsPanel.tsx`
- Modify: `web/src/layout/ResultsPanel.test.tsx`
- Modify: `web/src/workspace/editor.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1 catalog assumptions and Task 2 submitted documents/manifest.
- Produces: `Assumptions({ catalog, model, manifest })`; exported structural `documentValuesEqual` reused by dirty-state and stale-result checks.

- [ ] **Step 1: Write failing assumption and stale-state tests**
  Assert global assumptions, only block/connection types used by the submitted model, and manifest values for replications, seed, warmup, measurement, window, sketch profile, application and KSL versions. Assert edits mark both Summary and Assumptions stale, while undo back to structurally equal documents clears the mark. Assert cancelled-run explanation has no summary.
- [ ] **Step 2: Run focused tests to verify they fail**
  Run `npm test -- --run src/layout/Assumptions.test.tsx src/layout/ResultsPanel.test.tsx src/App.test.tsx` from `web`; expect missing tab/banner and failed stale restoration.
- [ ] **Step 3: Implement Assumptions and structural stale detection**
  Compare current model/experiment with the immutable submission snapshot by value. Render run conditions in milliseconds and preserve document-unit catalog text. Show the stale notice only on Summary and Assumptions; leave Problems unchanged.
- [ ] **Step 4: Run focused tests to verify they pass**
  Repeat Step 2; expect PASS.
- [ ] **Step 5: Commit**
  `git add` the Task 4 files and commit `feat: show assumptions and stale results`.

### Task 5: Panel Sizes and One-Screen Layout

**Files:**
- Modify: `web/src/layout/ResultsPanel.tsx`
- Modify: `web/src/layout/ResultsPanel.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `ResultsPanelSize = "collapsed" | "normal" | "expanded"`; App owns the current size, ResultsPanel owns the active tab. Collapsed retains tabs and job status; expanded occupies the workspace below TopBar.

- [ ] **Step 1: Write failing size-state tests**
  Assert normal/collapsed/expanded controls, hidden collapsed body, persistent tabs/status, and App grid classes. Ensure tab and size actions do not call workspace commands.
- [ ] **Step 2: Run the panel test to verify it fails**
  Run `npm test -- --run src/layout/ResultsPanel.test.tsx src/App.test.tsx` from `web`; expect missing controls/classes.
- [ ] **Step 3: Implement the three CSS-grid states**
  Normal remains 16rem; collapsed uses an auto-sized header; expanded replaces the palette/canvas/inspector rows below TopBar. Keep `html`, `body`, `#root`, and `.app` overflow hidden and panel bodies internally scrollable.
- [ ] **Step 4: Run focused tests to verify they pass**
  Repeat Step 2; expect PASS.
- [ ] **Step 5: Commit**
  `git add` the Task 5 files and commit `feat: add results panel size states`.

### Task 6: End-to-End Acceptance and Project State

**Files:**
- Modify: `web/e2e/workspace.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: all previous tasks through the real Chromium/UI/API path.

- [ ] **Step 1: Add acceptance scenarios**
  On disposable workspace copies, cover retry-storm Summary for both variants, Assumptions and manifest conditions, all three panel sizes without document overflow, and a long run cancelled from UI with cancellation status, no Summary, and Run enabled again.
- [ ] **Step 2: Run E2E and fix only issue-related failures**
  From `web`, run `E2E_BACKEND_PORT=18080 E2E_WEB_PORT=15173 npm run test:e2e`; expect all scenarios PASS. Use unique ports if another worktree is active.
- [ ] **Step 3: Update the recorded project state**
  Document the new panel states, Summary/utilization/point context, Assumptions, stale marking, and UI cancellation in `AGENTS.md`; do not change unrelated command documentation.
- [ ] **Step 4: Run final acceptance checks**
  Run `./gradlew clean build`; from `web` run `npm ci`, `npm run lint`, `npm run api:check`, `npm test -- --run`, `npm run build`, and the E2E command. Finish with `git diff --check origin/main` and a full diff review.
- [ ] **Step 5: Commit**
  `git add` the Task 6 files and commit `test: cover results panel acceptance`.
