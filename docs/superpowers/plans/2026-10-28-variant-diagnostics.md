# Variant diagnostics implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep variant-specific diagnostics on their variant's editor page and navigate there from Problems.

**Architecture:** Extend the shared diagnostic with a nullable variant ID. Retain explicit override locations in the compiled variant, reuse the compiler's existing override provenance, and resolve linter locations before deduplicating findings. The web resolves the explicit variant first and keeps pointer-based resolution for diagnostics without that metadata.

**Tech Stack:** Kotlin/JVM 25, kotlinx.serialization, Spring Boot, React, Vitest, Playwright. No new dependencies.

**Spec:** [Issue #85](https://github.com/ChernetsovNG/resilience-lab/issues/85), [stage 1 design](../specs/2026-10-27-stage-1-design.md), [AGENTS.md](../../../AGENTS.md).

## Global constraints

- Work only in the issue's separate worktree and branch.
- Preserve shared model diagnostics, warning-only validity, and existing validation behavior.
- Generate OpenAPI and TypeScript from their owning sources; regenerate document schemas only if affected.
- Keep identical diagnostics for inherited model values, including their source location, once with `variant = null`; override locations remain variant-specific, including in a single-variant experiment.

## Review focus

- Several affected variants must get separate findings, without variant IDs embedded in messages.
- A warning shared by all variants must retain `variant = null`.
- Override values must point to the experiment, while inherited values retain model pointers.
- Compiler errors about override values, invalid override paths and variant IDs must carry the variant ID.
- A finding from the only variant's override must retain that variant and navigate there from Problems.
- Model and sibling variant pages must not show another variant's badges or field messages; Problems must retain and navigate all findings.

### Task 1: Core and API

**Files:** `core/src/main/kotlin/resiliencelab/core/compiler/{Diagnostic,ModelCompiler,ModelLinter,ParamReader}.kt`, their compiler tests, `apps/cli/src/main/kotlin/resiliencelab/cli/Main.kt` and `CliTest.kt`, `apps/server/src/test/kotlin/resiliencelab/server/lab/ExperimentApiTest.kt`, generated `apps/server/openapi.json`.

**Interfaces:** `Diagnostic.variant: String? = null`; compiled variants retain override parameter origins. `ModelLinter.lint` and `ModelCompiler.compile` keep their signatures.

- [x] Update linter tests to expect one finding per affected variant, three differing deadline findings, and one common finding with a null variant. Test all four linter rules against override locations and assert variant IDs in serialized diagnostics.
- [x] Extend compiler and API tests for variant IDs on invalid overrides, and observe failures before implementation.
- [x] Add the optional field, preserve override provenance, resolve linter source locations, and group the resulting diagnostics. Retain the variant ID in CLI diagnostic locations when removing it from the message.
- [x] Run compiler/linter tests, regenerate OpenAPI, and verify the real validation response against it.

### Task 2: Web and browser scenario

**Files:** `web/src/validation/diagnostics.ts`, its tests and diagnostic fixtures, `web/src/layout/ResultsPanel.test.tsx`, generated `web/src/api/schema.d.ts`, `web/e2e/workspace.spec.ts`.

**Interfaces:** `diagnosticTarget` prefers `Diagnostic.variant`; `locationOf` includes a non-null variant ID. Existing App filtering and navigation consume the resolved target.

- [x] Add failing unit tests for a variant-specific model pointer, metadata precedence, and the variant ID in Problems.
- [x] Add a real-backend E2E: baseline warnings appear on Baseline, stay in Problems with `baseline`, disappear from Model and No retries, and clicking a warning opens Baseline and its field.
- [x] Implement the mapping and location changes, regenerate TypeScript, and run the focused unit and browser tests.

### Task 3: Documentation and delivery

**Files:** `AGENTS.md`, stage 1 design, T1/T3 plan contracts, issue branch and PR.

- [x] Update existing diagnostic contracts to describe the variant ID and override locations.
- [x] Run `./gradlew clean build`; from `web`, run `npm ci`, `npm run lint`, `npm run api:check`, `npm test -- --run`, `npm run build`, and `npm run test:e2e`.
- [x] Review the final diff, fetch/rebase onto `origin/main`, repeat affected checks if needed, and run `git diff --check origin/main`.

Publish the issue PR following [AGENTS.md](../../../AGENTS.md#работа-по-issue), with `Closes #85`.
