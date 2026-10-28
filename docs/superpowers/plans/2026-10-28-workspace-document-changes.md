# Workspace Document Deletion and Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add version-guarded document deletion and a bounded workspace change feed for API and external file mutations.

**Architecture:** `FileWorkspace` owns deletion and an in-memory change journal under the existing workspace mutation monitor. A lazily started daemon uses `WatchService` plus one-second full scans; the server exposes typed REST views and regenerates OpenAPI and TypeScript contracts.

**Tech Stack:** Kotlin/JDK 25, Java NIO `WatchService`, Spring Boot 4.1.2, kotlinx.serialization, springdoc, AssertJ/JUnit.

**Spec:** `docs/superpowers/plans/2026-10-28-stage-1-track-t2-server-cli.md`, T2.4; `docs/superpowers/specs/2026-10-27-stage-1-design.md`, §5.1–5.2.

## Global Constraints

- No new dependencies and no web reaction to changes; only generated web API types change.
- Paths remain confined to the workspace, including symbolic links.
- Only `*.model.json`, `*.layout.json`, and `*.experiment.json` outside hidden directories enter the feed.
- External changes become visible within 5 seconds; API mutations enter the same feed.
- API responses contain every property; deleted documents have `version: null`.
- New API failures use `ApiProblem`; malformed cursors use 400 `CURSOR_INVALID`, missing delete `If-Match` uses 428 `VERSION_REQUIRED`.

## Review Focus

- A rapid external create/edit/delete sequence must not leave stale observed versions; tested by polling each state in core.
- API writes racing a scan must not restore an old observed version; scanning and mutation recording share the workspace monitor.
- Existing files at server startup are baseline state, not creation events; tested by an initially empty feed.
- Server restart cursors and bounded-history cursors require a reset; future and evicted cursors are tested.
- Watchers must not keep test JVMs or Spring shutdown alive; the worker is lazy, daemon, and closed with `FileWorkspace`.

---

### Task 1: Version-guarded deletion

**Files:**
- Modify: `core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt`
- Test: `core/src/test/kotlin/resiliencelab/core/workspace/FileWorkspaceTest.kt`

**Interfaces:**
- Produces: `Workspace.delete(path: String, expectedVersion: String)`, which deletes only the exact current SHA-256 version under `.workspace.lock`.

- [x] Write tests for successful deletion, stale-version preservation, and missing documents.
- [x] Run `./gradlew :core:test --tests 'resiliencelab.core.workspace.FileWorkspaceTest'` and confirm failure because `delete` is absent.
- [x] Implement `delete` through the same locked mutation path as writes.
- [x] Re-run the focused core test and confirm PASS.

### Task 2: Bounded workspace change journal

**Files:**
- Create: `core/src/main/kotlin/resiliencelab/core/workspace/WorkspaceChanges.kt`
- Modify: `core/src/main/kotlin/resiliencelab/core/workspace/Workspace.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/ApiTypes.kt` to use the shared core `DocumentKind`.
- Modify: server files importing `DocumentKind`.
- Test: `core/src/test/kotlin/resiliencelab/core/workspace/FileWorkspaceTest.kt`

**Interfaces:**
- Produces: `DocumentKind.of(path)`, `Workspace.changes(since: WorkspaceCursor?): WorkspaceChangeBatch`, and `FileWorkspace.close()`.
- `WorkspaceChangeBatch(cursor: WorkspaceCursor, reset: Boolean, changes: List<WorkspaceChange>)`; each change has `path`, `kind`, and nullable `version`. A cursor combines a process UUID and a sequence, so pre-restart cursors always reset.
- `FileWorkspace(root, scanInterval: Duration = Duration.ofSeconds(1), historyLimit: Int = 1000)` supports short test intervals and bounded-history tests.

- [x] Write tests for empty baseline, API create/write/delete events, cursor polling, history eviction reset, future-cursor reset, and filtering hidden/non-document files.
- [x] Write a real filesystem test for external creation, modification, and deletion with a 5-second deadline per state.
- [x] Run the focused core test and confirm failure because the change API is absent.
- [x] Implement the synchronized bounded journal, lazy watcher, fallback scanning, deduplication, and close lifecycle.
- [x] Re-run focused core tests and confirm PASS.

### Task 3: REST contract and generated artifacts

**Files:**
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/DocumentController.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/LabExceptionHandler.kt`
- Modify: `apps/server/src/main/kotlin/resiliencelab/server/lab/ApiTypes.kt`
- Modify: `apps/server/src/test/kotlin/resiliencelab/server/lab/WorkspaceApiTest.kt`
- Generate: `apps/server/openapi.json`
- Generate: `web/src/api/schema.d.ts`
- Modify: `AGENTS.md` and this plan's checkboxes.

**Interfaces:**
- `DELETE /api/v1/workspace/document?path=` requires `If-Match`; success is 204.
- `GET /api/v1/workspace/changes?since=` returns `{ cursor: String, reset: Boolean, changes: [{ path, kind, version }] }`; omitted `since` returns the current cursor and no changes.

- [x] Write MockMvc tests for delete 428/404/409/204, API and external feed entries, malformed cursors, and OpenAPI response conformance.
- [x] Run `./gradlew :apps:server:test --tests 'resiliencelab.server.lab.WorkspaceApiTest'` and confirm the new tests fail before implementation.
- [x] Implement controller mappings, nullable change versions, and 428 error mapping.
- [x] Re-run the focused server test and confirm PASS.
- [x] Run `UPDATE_OPENAPI=1 ./gradlew :apps:server:test --tests 'resiliencelab.server.lab.OpenApiSpecTest' --rerun`, then `npm run api:types` from `web`.
- [x] Update `AGENTS.md` with the implemented API and journal behavior.

### Task 4: Final verification and delivery

- [x] Run `./gradlew clean build` from the repository root; expect `BUILD SUCCESSFUL`.
- [x] From `web`, run `npm ci`, `npm run lint`, `npm run api:check`, `npm test -- --run`, `npm run build`, and `npm run test:e2e`; expect all to pass.
- [x] Run `git diff --check origin/main` and inspect the complete diff for scope.
- [x] Fetch and rebase onto `origin/main`; repeat affected checks if the rebase changes the result.
- [x] Commit with Conventional Commits, push the branch, and open a PR containing `Closes #90` and exact verification results.
