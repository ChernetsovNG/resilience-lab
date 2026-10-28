# Parameter grid implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan with TDD and a final independent review.

**Goal:** Implement issue #17 and T1.6: one or two parameter axes, execution and persisted results per point, with working CLI and web summaries.

**Architecture:** Reuse catalog parameter patching and validation for grid values. Compile a chain per variant and point; keep streams independent of the point. Persist and aggregate each point separately using the existing replication and series writers.

**Tech Stack:** Existing Kotlin/JDK 25, KSL, kotlinx.serialization, Spring Boot and React/TypeScript dependencies.

**Spec:** [T1.6 plan-contract](2026-10-28-stage-1-track-t1-core.md#t16-сетка-параметров), [stage 1 design](../specs/2026-10-27-stage-1-design.md).

## Global constraints

- Follow `AGENTS.md`; add no dependencies.
- Model values, then variant overrides, then grid values.
- First axis is outermost; point ids start at `p0`; absent grid gives one point with empty coordinates.
- Point identity never enters random stream addressing.
- Aggregate only persisted replication totals; bump the artifact schema version.
- Map and point selection remain T4.

## Review focus

- Empty axes, more than two axes and overlapping paths must produce useful diagnostics.
- Invalid values must retain `/grid/<axis>/values/<index>` origins even for nested object parameters.
- Grid values must supersede variant overrides, including overrides of nested fields.
- No-grid output must keep working through API, CLI and web.
- Worker count, task completion order and document ordering must not change artifact bytes.

### Task 1: Document and compiler

**Files:** `Documents.kt`, `ModelCompiler.kt`, `ModelLinter.kt`, `DocumentSchemas.kt`, generated experiment schema; compiler/schema tests.

**Interfaces:** Produce compiled variants containing ordered points with id, coordinates and `ChainIr`.

- [x] Write and run failing acceptance/validation tests for raw grid documents.
- [x] Reuse parameter patching, track origins, compile every point and lint every chain.
- [x] Check 2×3 ordering, override precedence, invalid paths/values and no-grid `p0`.
- [x] Regenerate schemas; run core tests.

### Task 2: Execution and artifacts

**Files:** `ExperimentExecutor.kt`, `Lab.kt`, `RunArtifact.kt`; execution and artifact tests.

**Interfaces:** Consume compiled points; produce per-point results and point-aware callbacks, manifest coordinates and summaries.

- [x] Write and run failing grid execution/artifact tests.
- [x] Schedule variant × point × replication, persist separate point directories, aggregate from disk.
- [x] Verify baseline-equivalent point, common arrivals, exact task progress, cancellation and byte determinism.
- [x] Run JVM tests.

### Task 3: Consumers and delivery

**Files:** CLI output/tests, Summary table/tests and fixtures, generated OpenAPI/types, API/E2E tests, format documentation and `AGENTS.md`.

**Interfaces:** Summary variants expose points with coordinates and aggregate metrics.

- [x] Write and run failing CLI/web summary tests.
- [x] Render a row/line per point and preserve coordinate values with units.
- [x] Regenerate OpenAPI and TypeScript types through existing generators.
- [x] Run `./gradlew clean build`; web install, lint, API check, tests, build and E2E.
- [ ] Independent review; address substantive findings with regression tests.
- [ ] Fetch/rebase, review final diff, commit with Codex trailer, push and open PR closing #17.
