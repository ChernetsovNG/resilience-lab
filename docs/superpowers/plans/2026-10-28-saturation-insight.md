# Saturation Insight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic per-replication saturation paths and per-point replication aggregates to run summaries.

**Architecture:** A pure analyzer consumes event-time `NodeWindow` rows and retains only one detector state per node. An artifact reader streams each persisted gzip part into that analyzer; `ArtifactWriter.summarize` uses only stored task files, including during resume. `PointSummary` carries the rule, every replication path, first-node counts, and median/min/max onset times.

**Tech Stack:** Kotlin/JVM 25, kotlinx.serialization, existing JSON+gzip artifacts, JUnit 5, AssertJ.

**Spec:** `docs/superpowers/plans/2026-10-28-stage-1-track-t1-core.md`, section T1.5; `docs/superpowers/specs/2026-10-27-stage-1-design.md`, section 4.4.

## Global Constraints

- Saturation is the earlier of the first queue rejection or the first of 3 consecutive windows with handler utilization >= 0.95 and mean queue length > 0.
- Equal onset times sort by node id; first-node aggregates sort by descending replication count, then node id.
- Summary inputs are persisted task files only; worker count and block order cannot change bytes.
- No new dependencies. Public result models use `@Serializable` and KDoc.
- Adding the summary field raises manifest and summary `schemaVersion` from 4 to 5; internal task-file versions stay unchanged.
- UI text and graph markers are excluded (T4). Generated API contracts and fixtures are updated only to keep existing clients building.

## Review Focus

- Split gzip parts and node groups: every node still sees windows in chronological order; Task 2 adds a multi-part reader test.
- Even replication counts: median is the mean of the two central sorted onset times; Task 1 adds an aggregation test.
- Simultaneous node onset and equal first-node counts: stable node-id tie-breaking; Tasks 1 and 2 add assertions.
- Replications without saturation: empty paths and a separate count, never mixed into onset timing; Task 1 adds an aggregation test.
- A short final window: utilization and queue mean use its actual `durationMs`; Task 1 adds a boundary test.

---

### Task 1: Pure saturation rule and replication aggregation

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/results/Saturation.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/SaturationTest.kt`

**Interfaces:**
- Consumes: existing `NodeWindow` and `WindowMetrics`.
- Produces: `SaturationRule`, `SaturatedNode`, `ReplicationSaturation`, `FirstNodeSaturation`, `SaturationSummary`; `SaturationAnalyzer.detect(replication: Int, windows: Sequence<NodeWindow>, rule: SaturationRule = SaturationRule()): ReplicationSaturation`; `SaturationAnalyzer.aggregate(replications: List<ReplicationSaturation>, rule: SaturationRule = SaturationRule()): SaturationSummary`.

- [ ] **Step 1: Write failing synthetic-series tests**

Cover the contract cases with exact assertions: three hot windows start at the first window; a gap resets the streak; an earlier queue rejection wins; simultaneous nodes sort by time then id; no hot node gives an empty path. Add a short final window and an even-count aggregate whose median is `(20 + 40) / 2 = 30`, whose min/max are `20`/`40`, and whose no-saturation count excludes empty paths from timing.

- [ ] **Step 2: Run the tests and verify RED**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.SaturationTest'`
Expected: compilation fails because saturation models and analyzer do not exist.

- [ ] **Step 3: Implement the models and analyzer**

Keep one streak/onset state per node. A window that completes a streak and contains a rejection uses the earlier streak start. Aggregation computes timing only for replications where that node was first; first-node order is count descending then id.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.SaturationTest'`
Expected: `BUILD SUCCESSFUL`.

### Task 2: Build point insights from persisted series

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/results/SaturationArtifactReader.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/results/RunArtifact.kt`
- Modify: `core/src/test/kotlin/resiliencelab/core/results/ArtifactPipelineTest.kt`
- Modify: `core/src/test/kotlin/resiliencelab/core/results/RunArtifactTest.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/results/SaturationArtifactReaderTest.kt`

**Interfaces:**
- Consumes: Task 1 analyzer; existing `Workspace`, `SeriesIndex`, `SeriesPart`.
- Produces: `SaturationArtifactReader.read(directory: String, replication: Int): ReplicationSaturation`; required `PointSummary.saturation: SaturationSummary`.

- [ ] **Step 1: Write failing artifact tests**

Write synthetic series through `SeriesWriter` with a budget forcing multiple parts and split node groups; assert the reader returns the same path as the pure rule. Extend the retry-storm pipeline assertion to require a saturation field, thresholds, two replication paths per point, and a total of saturated plus unsaturated replications equal to two. Assert schema version 5.

- [ ] **Step 2: Run the tests and verify RED**

Run: `./gradlew :core:test --tests 'resiliencelab.core.results.SaturationArtifactReaderTest' --tests 'resiliencelab.core.results.ArtifactPipelineTest'`
Expected: compilation fails because the reader and `PointSummary.saturation` are absent.

- [ ] **Step 3: Implement streaming artifact integration**

Read `index.json`, then each listed gzip part in index order. Yield each node window directly to Task 1 without accumulating the replication series. In `ArtifactWriter.summarize`, load each replication's totals and saturation from its task directory, aggregate both, and bump `Versions.ARTIFACT_SCHEMA` to 5.

- [ ] **Step 4: Run core tests and verify GREEN**

Run: `./gradlew :core:test`
Expected: `BUILD SUCCESSFUL`, including deterministic rebuild and resume tests.

### Task 3: Contracts, documentation, and end-to-end acceptance

**Files:**
- Modify: `docs/results-format.md`
- Modify: `docs/superpowers/specs/2026-10-27-stage-1-design.md`
- Modify: `AGENTS.md`
- Modify: `apps/server/openapi.json` (generated)
- Modify: `web/src/api/schema.d.ts` (generated)
- Modify: `web/src/test/fixtures.ts`
- Modify: `web/src/layout/SummaryTable.test.tsx`

- [ ] **Step 1: Regenerate API contracts and update fixtures**

Run `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`, then `npm run api:types` in `web`. Give fixture points an explicit no-saturation value and schema version 5; do not add UI presentation.

- [ ] **Step 2: Document the version-5 summary contract**

Document all saturation fields, empty-path semantics, deterministic ordering, median/min/max timing, and the fact that insights are rebuilt from persisted series parts as well as replication totals.

- [ ] **Step 3: Run retry-storm acceptance**

Run: `./gradlew :apps:cli:run --args="run examples/retry-storm/retry-storm.experiment.json"`
Expected: `BUILD SUCCESSFUL`; inspect the printed run's `summary.json` and record each point's first node/onset or explicit absence of saturation.

- [ ] **Step 4: Run final verification**

Run `./gradlew clean build`; in `web`, run `npm ci`, `npm run lint`, `npm test -- --run`, `npm run build`, and `npm run test:e2e`. Run `git diff --check origin/main` and inspect the complete diff. Expected: all commands succeed and only Task 1–3 files change.
