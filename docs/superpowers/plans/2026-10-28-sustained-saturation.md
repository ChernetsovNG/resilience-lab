# Sustained saturation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Implement issue #117: reject transient saturation and order simultaneous onsets downstream first.

**Architecture:** Reuse persisted window metrics and the existing streaming artifact reader. Confirm backlog lasting at least 100 ms with handler utilization at least 0.95 and mean queue greater than 0.5. Independently confirm consecutive overflow observations whose window starts span at least 100 ms; never credit the last rejection window with unobserved persistence. Backdate onset to the first qualifying window. Pass the validated call-chain order into summary reconstruction, including resume.

**Tech Stack:** Kotlin/JDK 25, existing serialization/OpenAPI generators, TypeScript/React fixtures.

**Spec:** [Issue #117](https://github.com/ChernetsovNG/resilience-lab/issues/117), [stage 1 §4.4](../specs/2026-10-27-stage-1-design.md#44-вывод-v1).

## Global Constraints

- No new dependencies, series metrics, or UI insight text.
- Record all numeric rule parameters; artifact schema version becomes 6.
- Keep fresh and resumed artifacts byte-identical.
- Follow [AGENTS.md](../../../AGENTS.md) for repository workflow.

## Review Focus

- Isolated overflow must not bypass the duration threshold.
- Cold/missing windows break a streak; partial final windows contribute only their actual duration.
- Binary64 boundaries must not change an exactly qualifying duration.
- Topology, rather than lexical or input order, resolves equal onsets.
- Rebuilding summaries and resume must receive the same topology and rule.

### Task 1: Sustained detection

**Files:** `core/src/main/kotlin/resiliencelab/core/results/Saturation.kt`, `core/src/test/kotlin/resiliencelab/core/results/SaturationTest.kt`.

- [x] Write synthetic tests for short/long pressure, isolated/sustained overflow, independent signals, cold/gapped/partial windows, and different window widths.
- [x] Run `./gradlew :core:test --tests '*SaturationTest'`; observe the transient/overflow assertions fail.
- [x] Replace the window counter with elapsed contiguous time. Set `minimumDurationMs=100.0`, `handlerUtilizationThreshold=0.95`, `meanQueueLengthThreshold=0.5`, `queueRejectionsThreshold=0`.
- [x] Run the targeted tests; expect zero failures.

### Task 2: Topology and artifact contract

**Files:** `Saturation.kt`, `SaturationArtifactReader.kt`, `RunArtifact.kt`, `Lab.kt` and their existing result tests; generated OpenAPI/types and `web/src/test/fixtures.ts`.

- [x] Test simultaneous callers/callees with names that oppose call order; test deterministic fallback for unrelated nodes.
- [x] Add `callChain: List<String>` to detection/reader/summary inputs. Derive it from the compiled chain using its entry and call targets, shared by all parameter-only variants/points.
- [x] Sort by onset, descending call-chain position, then node id. Keep aggregate frequency ordering unchanged.
- [x] Extend artifact-reader coverage across split parts; update summary-rebuild assertions and bump `Versions.ARTIFACT_SCHEMA` to 6.
- [x] Regenerate `apps/server/openapi.json` and `web/src/api/schema.d.ts`; update affected fixtures/assertions.
- [x] Run result tests and OpenAPI conformance; expect zero failures.

### Task 3: Evidence and delivery

**Files:** design §4.4, `docs/results-format.md`, affected `AGENTS.md` statements.

- [x] Document the rule, topology tie-break, version change, and finite window resolution.
- [x] Run 20 replications of both retry-storm variants at 10/50 ms and matching no-fault controls on temporary copies. Require dependency first at 200–300 ms in all 80 fault cases, no control saturation, and per-replication onset differences no greater than 50 ms.
- [x] Record burst distributions and acceptance results in the PR; preserve raw evidence outside tracked files.
- [x] Run `./gradlew clean build`, web lint/unit/build/API checks, and E2E on isolated ports.
Delivery: fetch/rebase onto `origin/main`, inspect the scoped diff, run `git diff --check origin/main`, and open a PR closing #117. Independent review found one overflow issue; its regression tests and fix passed before delivery. Do not merge.

## Review ruling

A single rejection in a 100/200 ms window still passed the first duration implementation. The independent review reproduced it. Split backlog and overflow confirmation: backlog credits its measured full-window utilization/queue integral; overflow credits only elapsed time through the last qualifying window start. This prevents one rejection sample from establishing sustained pressure. Short independent signals cannot be joined into a confirming interval. The cost is one additional observation for overflow and no overflow confirmation when a run contains only one series window; the design states this resolution limit.
