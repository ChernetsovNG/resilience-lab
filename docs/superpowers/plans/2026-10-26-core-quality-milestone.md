# Resilience Lab Core Quality Milestone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Применить семь core-замечаний без изменения поведения: package `resiliencelab`, AssertJ, KDoc, понятные seed bounds, KtLint, JaCoCo, совместимый Gradle и CI.

**Architecture:** Небольшие последовательные коммиты на `feat/first-prototype`; backend WIP сохраняется в stash. Общие test/quality-настройки применяются через root `subprojects`, а production-контракты и random streams остаются неизменными.

**Tech Stack:** JDK 25, Kotlin 2.4.21, AssertJ 3.27.7, KtLint Gradle plugin 14.2.0, JaCoCo, Gradle 9.8.2 (target), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-26-core-quality-design.md`

## Global Constraints

- Не менять симуляционную семантику, JSON schema/version, результаты или random sequences.
- Только JDK 25; новый package root — `resiliencelab`; KSL packages не изменять.
- AssertJ `3.27.7`, KtLint `14.2.0`; JUnit Platform и исходные expected values/test intent сохраняются.
- Seed использует именованные m1/m2 exclusive limits и две группы по три значения в исходном порядке.
- Backend WIP сохраняется в `backend-task1-wip` stash и не входит в коммиты milestone.
- Не пушить `main`; публиковать только проверенные core-коммиты в `origin/feat/first-prototype`.
- Внешний `C:\Users\ncher\.gradle\init.gradle` не изменять; секреты и production data не добавлять.
- Каждая задача заканчивается focused checks и отдельным коммитом; поведение и новые тесты — через TDD, структурные изменения — через regression verification.

## Review Focus

- Package/launcher regression: после переименования installed CLI запускает `resiliencelab.cli.MainKt` (Tasks 1, 9).
- Seed sequence drift: `seedVector(42L)` остаётся `[4147796393, 31527095, 9131797, 3597812889, 2509752446, 1083150052]` (Task 3).
- Assertion migration не должна потерять edge cases, точные paths/tolerances или test count (Task 2).
- KtLint/JaCoCo не должны пропускать модуль или silently skip checks (Tasks 5, 6, 8).
- Backend WIP не должен исчезнуть или попасть в core-коммиты (Tasks 1, 9).

---

### Task 1: Preserve backend WIP and rename project packages

**Files:**
- Modify: `core/src/main/kotlin/**`, `core/src/test/kotlin/**`, `apps/cli/src/**` — physical roots become `resiliencelab`.
- Modify: `apps/cli/build.gradle.kts` — `mainClass = "resiliencelab.cli.MainKt"`.
- Modify: `docs/superpowers/plans/*.md` — only stale project-package references.

**Interfaces:**
- Produces: `resiliencelab.core.*`, `resiliencelab.cli.*`, unchanged scenario/result JSON and CLI behavior.

- [ ] **Step 1: Preserve backend and rename source roots**

Run `git stash push -u -m "backend-task1-wip"`; verify the stash and clean HEAD `fa65074`. Use `git mv` to move core/CLI main/test roots to `resiliencelab`. Update package/import/MainKt and current plan references. Do not change KSL packages.

- [ ] **Step 2: Verify package migration**

Run `./gradlew test` and search source/build/docs for `io.github.chernetsovng.resiliencelab`.
Expected: 151 tests PASS; zero stale references.

- [ ] **Step 3: Commit**

```bash
git add core apps/cli docs/superpowers/plans
git commit -m "refactor: simplify project package names"
```

### Task 2: Migrate all core/CLI assertions to AssertJ

**Files:**
- Modify: `build.gradle.kts` — shared test dependency convention.
- Modify: every core/CLI test Kotlin file using `kotlin.test` assertions.

**Interfaces:**
- Consumes: JUnit Platform and all existing behavioral tests.
- Produces: `org.assertj:assertj-core:3.27.7` for JVM test modules; no `kotlin.test.assert*` assertions.

- [ ] **Step 1: Add dependency and migrate assertions**

Add AssertJ through root `subprojects`. Convert every assertion to its type-appropriate AssertJ equivalent, preserving literals, exact paths, array/list content, nullability, exception types/messages and tolerances. Keep JUnit annotations/lifecycle and test count.

- [ ] **Step 2: Verify no regression**

Run `./gradlew test`; search for `kotlin.test.assert`.
Expected: 151 tests PASS, zero old assertion usages, no lost edge cases.

- [ ] **Step 3: Commit**

```bash
git add build.gradle.kts core/src/test apps/cli/src/test
git commit -m "test: migrate assertions to AssertJ"
```

### Task 3: Name KSL seed bounds and groups

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/simulation/SeedFactory.kt`.
- Test: `core/src/test/kotlin/resiliencelab/core/simulation/SeedFactoryTest.kt`.

**Interfaces:**
- Produces: named `KSL_M1_EXCLUSIVE_LIMIT`, `KSL_M2_EXCLUSIVE_LIMIT` and named group size; unchanged `seedVector(seed: Long): LongArray`.

- [ ] **Step 1: Refactor without changing draw order**

Replace index/magic logic with two three-component groups using the named exclusive limits. Preserve `Random(seed)` and `nextLong(1L, upperBound)` order exactly.

- [ ] **Step 2: Verify the exact vector and suite**

Run `./gradlew :core:test --tests "*SeedFactoryTest"`, then `./gradlew test`.
Expected: seed 42 remains `[4147796393, 31527095, 9131797, 3597812889, 2509752446, 1083150052]`; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add core/src/main/kotlin/resiliencelab/core/simulation/SeedFactory.kt core/src/test/kotlin/resiliencelab/core/simulation/SeedFactoryTest.kt
git commit -m "refactor: name KSL seed bounds"
```

### Task 4: Document main domain classes and public APIs

**Files:**
- Modify: main Kotlin files under `core/src/main/kotlin/resiliencelab/core/scenario/`, `simulation/`, `experiment/`.
- Modify: `apps/cli/src/main/kotlin/resiliencelab/cli/Main.kt`.

**Interfaces:**
- Produces: concise KDoc for scenario/result models, `ScenarioCodec`, `ScenarioValidator`, `ReliabilityModel`, `ServiceRuntime`, `CallAttempt`, bounded/FIFO resource types, arrivals/monitor, `ExperimentRunner`, `SweepExpander`, `MetricsAggregator`, `TimeWeightedSeries`, `ReplicationResultStore` and CLI command entry points.

- [ ] **Step 1: Add responsibility/contract KDoc**

Document non-obvious lifecycle, cohort, timeout/orphan, deadline, measurement and aggregation contracts. Do not add property-by-property boilerplate or alter code behavior.

- [ ] **Step 2: Verify compilation and behavior**

Run `./gradlew test`.
Expected: all tests PASS; only documentation changed.

- [ ] **Step 3: Commit**

```bash
git add core/src/main/kotlin apps/cli/src/main/kotlin
git commit -m "docs: document core simulation contracts"
```

### Task 5: Enforce KtLint locally

**Files:**
- Modify: `build.gradle.kts`.
- Modify only if violations require: Kotlin sources reported by KtLint.

**Interfaces:**
- Produces: `org.jlleitschuh.gradle.ktlint:14.2.0` on JVM subprojects and `check -> ktlintCheck`.

- [ ] **Step 1: Configure and run KtLint**

Register plugin version `14.2.0` with `apply false`, apply to JVM subprojects and wire `check` to `ktlintCheck`.
Run `./gradlew ktlintCheck`; fix actual violations deliberately, without blanket reformatting.

- [ ] **Step 2: Verify lint and tests**

Run `./gradlew ktlintCheck` and `./gradlew test`.
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add build.gradle.kts core apps/cli
git commit -m "build: enforce Kotlin lint checks"
```

### Task 6: Add JaCoCo reporting and a measured coverage gate

**Files:**
- Modify: `build.gradle.kts`.
- Create only if minimum coverage requires behavior-focused tests: targeted existing test files, never production exclusions.

**Interfaces:**
- Produces: per-module HTML/XML reports and `jacocoTestCoverageVerification`; `check` runs report and verification.

- [ ] **Step 1: Generate initial reports**

Apply `jacoco` to JVM subprojects, enable HTML/XML and run `./gradlew test jacocoTestReport`. Record actual core/CLI line/branch percentages in the quality ledger.

- [ ] **Step 2: Configure the measured baseline**

Set each module's line/branch floor to the measured value rounded down to the nearest 5%, minimum line 70% / branch 60%. If below minimum, add behavior-focused tests by strict TDD until satisfied; never exclude production classes. Wire `check` to report and verification.

- [ ] **Step 3: Verify reports and gate**

Run `./gradlew clean build`; verify `core/build/reports/jacoco/test/` and `apps/cli/build/reports/jacoco/test/` contain HTML/XML and verification passes.
Expected: tests, lint and coverage gate PASS.

- [ ] **Step 4: Commit**

```bash
git add build.gradle.kts core/src/test apps/cli/src/test
git commit -m "build: measure JVM test coverage"
```

### Task 7: Upgrade and verify the Gradle wrapper

**Files:**
- Modify: `gradle/wrapper/*`, `gradlew`, `gradlew.bat` only as generated by the wrapper task.

**Interfaces:**
- Produces: target Gradle `9.8.2` distribution and wrapper-compatible quality checks.

- [ ] **Step 1: Upgrade wrapper**

Run `gradle wrapper --gradle-version 9.8.2`, inspect files and run `./gradlew --version`.
Expected: actual distribution 9.8.2 on JDK 25. Revert to 9.3.1 only after a reproduced/documented incompatibility.

- [ ] **Step 2: Verify build and installed CLI**

Run `./gradlew clean build`, `./gradlew ktlintCheck`, and the installed retry-storm launcher. Parse complete stdout and require baseline/candidate plus successRate, pooled p95Ms/p99Ms and amplification.
Expected: all checks PASS.

- [ ] **Step 3: Commit**

```bash
git add gradle gradlew gradlew.bat
git commit -m "build: upgrade Gradle to 9.8.2"
```

### Task 8: Add GitHub Actions CI and update guidance

**Files:**
- Create: `.github/workflows/ci.yml`.
- Modify: `AGENTS.md`.

**Interfaces:**
- Produces: CI with read-only contents permission, Microsoft JDK 25, `./gradlew --no-daemon clean build` and JaCoCo artifacts.

- [ ] **Step 1: Add workflow**

Use `actions/checkout@v4`, `actions/setup-java@v4` (`distribution: microsoft`, `java-version: '25'`) and `actions/upload-artifact@v4` with `if-no-files-found: error`. Trigger on push, pull request and manual dispatch. Upload core/CLI JaCoCo report directories. No secrets.

- [ ] **Step 2: Update AGENTS.md**

Record package `resiliencelab`, AssertJ/KDoc expectations, exact KtLint/JaCoCo commands, workflow path and actual wrapper version. Preserve backend/web pending status and roadmap.

- [ ] **Step 3: Verify final docs/workflow state**

Run `git diff --check` and `./gradlew clean build`.
Expected: no whitespace errors; full gate PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml AGENTS.md
git commit -m "ci: verify JVM quality on GitHub Actions"
```

### Task 9: Final acceptance, publish core commits and restore backend

**Files:**
- Modify only for factual verification status if needed: `AGENTS.md`.
- No backend source changes belong to this milestone.

**Interfaces:**
- Consumes: every previous task and its public APIs.

- [ ] **Step 1: Run final acceptance**

Require zero old-package references and zero `kotlin.test.assert` usages. Run `./gradlew clean build`, verify JaCoCo artifacts and installed retry-storm JSON. Check `git diff --check`, `git status --short` and commit inventory for no backend/generated files.

- [ ] **Step 2: Publish only reviewed core commits**

Run `git push origin feat/first-prototype` (never `main`). Inspect the initial GitHub Actions run if available and record actual URL/status; do not claim CI passed before completion.

- [ ] **Step 3: Restore backend WIP**

Run `git stash pop`; verify backend files are restored. Record required package/AssertJ/`spring-boot-webmvc-test` alignment for Backend Task 1, but do not commit restoration changes in this milestone. Resume Backend Task 1 separately with ruling B4.

## Self-review

- Every user comment maps to Tasks 1–7; CI and final verification map to Tasks 8–9.
- Package/MainKt, AssertJ types, seed bounds, Gradle/KtLint versions and module report paths are explicit and consistent.
- No task permits semantic changes, test deletion, coverage exclusion, backend loss or push to `main`.
