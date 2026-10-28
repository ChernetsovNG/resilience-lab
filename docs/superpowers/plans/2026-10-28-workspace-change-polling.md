# Workspace Change Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show external changes to open documents within 5 seconds, refresh the experiment list, and reload only with the same data-loss protections as the existing editor.

**Architecture:** Extend `useWorkspace`, which already owns document versions, loading and saving, with one sequential polling loop. Initialize the journal cursor before the first document read, defer journal entries for a path while its `PUT` is pending, and reconcile `reset` responses through `GET /workspace/documents`.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright, existing generated OpenAPI types.

**Spec:** Issue #113; `docs/superpowers/specs/2026-10-27-stage-1-design.md` §2, §5.1 and §6.2; `docs/superpowers/plans/2026-10-28-stage-1-track-t3-web-editor.md` invariants 1, 5 and 6.

## Global Constraints

- Use Node.js `26.12.1` from `web/.nvmrc`; add no dependencies and no server changes.
- Poll with the existing `GET /api/v1/workspace/changes?since=` contract; do not add SSE.
- Do not discard or reload unsaved edits without explicit confirmation.
- Own saves must not produce a banner, including when the journal response wins the race with `PUT`.
- An external-change notice must not block a subsequent save; its stale `If-Match` must still produce the existing 409 conflict.
- Keep the diff within `web/` and documentation.

## Review Focus

- Journal-before-`PUT`: defer only the affected path and classify it against the version returned by `PUT` (Task 1 race tests).
- `reset` during an edit or save: compare current open paths and defer pending saves without losing unsaved content (Task 1 reset and race tests).
- Deletion (`version: null`): retain the editor, show deletion, and never issue a reload for the missing document (Tasks 1 and 2 deletion tests).
- Failed poll or document-list refresh: retain the cursor, show no false notice, and retry (Task 1 failure test).
- Multiple documents changed together: retain one notice per changed path instead of clearing another document's notice (Task 1 batching test).

---

### Task 1: Journal API and Workspace Tracking

**Files:**
- Modify: `web/src/api/apiClient.ts`
- Modify: `web/src/api/apiTypes.ts`
- Modify: `web/src/workspace/useWorkspace.ts`
- Modify: `web/src/api/apiClient.test.ts`
- Create: `web/src/workspace/useWorkspaceChanges.test.ts`

**Interfaces:**
- Consumes: generated `WorkspaceChangeView` and `WorkspaceChangesView`; existing `LoadedExperiment`, `dirtyDocuments`, `api.documents()`, and `api.saveDocument()`.
- Produces: `api.changes(since?: string): Promise<WorkspaceChangesView>`; `Workspace.externalChange: { path: string; deleted: boolean } | null`; existing `reload()` remains the sole reread operation.

- [ ] **Step 1: Write failing API and hook tests**

Cover these exact behaviors:
- `api.changes("gen:12")` requests `/api/v1/workspace/changes?since=gen%3A12`; without a cursor it omits `since`.
- A changed open model shows `{ path: modelPath, deleted: false }`; an unrelated document does not.
- Latest entries are kept per path, so a same-version final entry clears only that path's notice.
- A journal entry with the new own-save version arriving before a gated `PUT` response produces no notice before or after the response; the same applies when it arrives after `PUT`.
- A batch containing own version `v-model-2` followed by external `v-model-3` shows the external notice after `PUT` finishes.
- `reset: true` refreshes experiment paths and detects changed and missing open documents from `DocumentEntry.version`.
- Experiment creation and deletion in ordinary journal responses refresh `experiments`.
- A rejected poll is silent and the following successful poll still works.
- `version: null` shows `{ deleted: true }`; `reload()` issues no document reads for that state.
- An external notice alone leaves `conflict === false`; saving still sends `PUT`, and a 409 sets the existing conflict.
- Reloading an externally changed generated layout uses the existing recovery path even when `layoutRef` is absent.

Use fake timers around the default 1000 ms polling interval and immediate/deferred HTTP stubs; assert no state changes while a save path is deferred.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test -- --run src/api/apiClient.test.ts src/workspace/useWorkspaceChanges.test.ts`
Expected: FAIL because `api.changes`, `Workspace.externalChange`, and polling do not exist.

- [ ] **Step 3: Add the typed journal client**

In `apiTypes.ts`, export `WorkspaceChangeView` and `WorkspaceChangesView`. In `apiClient.ts`, add `changes(since?: string)` with `encodeURIComponent` for the optional cursor.

- [ ] **Step 4: Implement polling and race-safe classification in `useWorkspace`**

Initialize `api.changes()` before the initial catalog/document reads. Then poll sequentially every 1000 ms, advancing the cursor only after all required document-list reads and classifications succeed.

Keep authoritative loaded versions and pending-save paths in refs. Buffer only entries for paths currently in `PUT`; flush each path after its response using the returned version. Keep notices in a path-keyed record so independent documents do not erase each other. On `reset`, refresh the list and synthesize comparisons for every open model/layout/experiment path, including a missing generated layout. On experiment journal entries, refresh the sorted experiment list.

Return the first open-document notice as `externalChange`. Clear notices only after a successful open/reload. Include an externally changed layout in `recoveryLayoutPath`. Make `reload()` a no-op for a deletion notice. Poll failures remain silent and schedule the next attempt.

- [ ] **Step 5: Run Task 1 tests and the existing workspace tests**

Run: `npm test -- --run src/api/apiClient.test.ts src/workspace/useWorkspaceChanges.test.ts src/workspace/useWorkspace.test.ts`
Expected: PASS with no new unhandled errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/apiClient.ts web/src/api/apiTypes.ts web/src/api/apiClient.test.ts web/src/workspace/useWorkspace.ts web/src/workspace/useWorkspaceChanges.test.ts docs/superpowers/plans/2026-10-28-workspace-change-polling.md
git commit -m "feat: track workspace document changes"
```

### Task 2: Banner, Confirmation and Browser Acceptance

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/e2e/editor.spec.ts`

**Interfaces:**
- Consumes: `Workspace.externalChange`, `Workspace.dirty`, `Workspace.conflict`, `Workspace.conflictPath`, and `Workspace.reload()` from Task 1.
- Produces: the existing banner area distinguishes external modification, deletion and save conflict; deleted documents have no Reload button.

- [ ] **Step 1: Write failing component and E2E tests**

Component cases:
- An external modification shows its path; with unsaved edits it says Reload discards them. A dismissed confirmation preserves the exact field draft and issues no reads; acceptance reloads and clears undo/redo.
- A deletion says the document was deleted, keeps the current editor value, and renders no Reload button.
- An external notice without unsaved edits reloads without confirmation.

E2E cases on the disposable workspace:
- Write gateway `handlers: 9` to the model file; within 5000 ms show the model path; Reload shows `9` in Inspector.
- Repeat with an unsaved `6`; dismiss once and verify `6` remains, then accept and verify `9`.
- Save a UI edit and wait for its own journal entry; no external-change banner appears.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- --run src/App.test.tsx`
Expected: FAIL because the external-change banner and confirmation are absent.

Run: `npx playwright test e2e/editor.spec.ts --grep "external|own save"`
Expected: FAIL because no external-change banner appears.

- [ ] **Step 3: Implement banner behavior in `App.tsx`**

Prefer `externalChange` over the existing 409 conflict notice. For modification, retain the text `The document changed on disk` and the path. For deletion, state that the document was deleted and omit Reload. For an external modification with any unsaved edits, state that Reload discards them and require `window.confirm("Reload and discard unsaved changes to the documents?")` before clearing selection and calling `reload()`.

Do not pass external notices to `TopBar` as conflicts: Save must remain available until an actual 409.

- [ ] **Step 4: Run focused unit and E2E tests**

Run: `npm test -- --run src/App.test.tsx src/workspace/useWorkspaceChanges.test.ts`
Expected: PASS.

Run: `npx playwright test e2e/editor.spec.ts --grep "external|own save"`
Expected: PASS, including the 5000 ms visibility assertion.

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/e2e/editor.spec.ts
git commit -m "feat: warn about external document edits"
```

### Task 3: Documentation and Final Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-27-stage-1-design.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: final behavior from Tasks 1 and 2.
- Produces: current design and agent guidance; no API or toolchain changes.

- [ ] **Step 1: Update behavior documentation**

Document the 1000 ms poll, reset reconciliation, experiment-list refresh, own-save race handling, deletion behavior, and confirmation before discarding drafts. Update the design §6.2 and the web behavior section of `AGENTS.md`; do not change server contracts.

- [ ] **Step 2: Run all issue checks**

From `web` with Node.js `26.12.1`:

```bash
npm ci
npm run lint
npm run api:check
npm test -- --run
npm run build
npm run test:e2e
```

Expected: every command exits 0; all unit and E2E tests pass.

- [ ] **Step 3: Rebase and inspect the delivered diff**

Run: `git fetch origin && git rebase origin/main`
Run: `git diff --check origin/main`
Expected: no whitespace errors; diff is limited to the planned web and documentation files. Repeat Step 2 if rebase changes the result or encounters conflicts.

- [ ] **Step 4: Commit documentation, push and open the PR**

```bash
git add AGENTS.md docs/superpowers/specs/2026-10-27-stage-1-design.md
git commit -m "docs: describe external document tracking"
git push -u origin HEAD
gh pr create --base main
```

The PR includes `Closes #113`, verification results, and any unrelated findings without fixing them here.
