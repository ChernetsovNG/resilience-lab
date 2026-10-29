# Summary and estimate polish implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Complete [issue #130](https://github.com/ChernetsovNG/resilience-lab/issues/130) at a 1440 px viewport.

**Architecture:** Keep the existing Summary table and API. Move service metrics into native disclosures spanning the table width; wrap aggregate metrics. Put the dismissible estimate in a dedicated grid row under the toolbar. Distinguish failed estimates from invalidated responses before offering Run confirmation.

**Tech Stack:** Existing React, CSS, Vitest and Playwright; no new dependencies.

**Spec:** Issue #130 and [T4 invariants 1–8](2026-10-28-stage-1-track-t4-web-results.md#общие-инварианты).

## Global constraints

- Preserve every metric, unit, Student 95% CI and pooled utilization calculation.
- Viewing and closing estimates must not edit documents or history.
- Preserve validation gating and successful-estimate budget confirmation.
- Keep screenshots in `pr-assets`, outside the task branch.

## Review focus

- Late successful or failed estimates after document edits must never start a job.
- A rejected confirmation must leave Run available and create no job.
- Zero service capacity and missing metrics must remain `n/a`.
- Grid coordinates and service IDs must wrap without forcing horizontal scroll.
- Closed estimates must reopen through Estimate or Run, including after a failure.

## Tasks

1. Summary: `web/src/layout/SummaryTable.tsx`, its test and `web/src/styles.css`.
   - [x] Test disclosure metrics, confidence intervals and missing/zero capacity; watch the new assertion fail.
   - [x] Keep eight overview columns; add per-row service disclosures and wrapping.
   - [x] Run the focused unit tests and check actual widths in Chromium.
2. Estimate: `web/src/App.tsx`, `web/src/run/CostEstimate.tsx`, `web/src/run/useEstimate.ts`, tests and styles.
   - [x] Test size boundaries, closing/reopening, both failure decisions and late responses; watch failures.
   - [x] Add binary units, a dedicated dismissible grid row and an explicit confirmation only for a current failed estimate.
   - [x] Run focused and full unit tests.
3. Acceptance: `web/e2e/workspace.spec.ts` and `web/e2e/summary-estimate.spec.ts`.
   - [x] Check 1440 px overflow and estimate/canvas geometry, unchanged documents and failed-network confirmation.
   - [x] Update the stage 1 design; run lint, api:check, tests, build and the full E2E suite.
   - [x] Capture before/after images, review the diff and prepare the PR description.
