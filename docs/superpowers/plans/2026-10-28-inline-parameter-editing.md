# Inline Parameter Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit connection timeout/attempts and service handlers/queue/processing mean directly on the canvas, with the same parsing, commands, undo and variant overrides as the inspector.

**Architecture:** Share the inspector's scalar parser with a focused canvas editor. Render service values inside the existing node and call values through React Flow's `EdgeLabelRenderer`; route every commit through `setModelParam` or `setVariantParam` without adding state or dependencies.

**Tech Stack:** React 19.3.1, React Flow 12.12.0, TypeScript, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/plans/2026-10-28-stage-1-track-t3-web-editor.md`, section T3.5.

## Global Constraints

- A double-click opens the value editor; Enter commits, Escape cancels, and malformed text remains visible with an error.
- Parsing, units and ranges come from the catalog and match the inspector. Parseable range errors still reach draft validation, as in the inspector.
- One edit creates one existing editor command. Model pages change the model; variant pages change precise overrides.
- Structural editing remains disabled on variant pages, while parameter editing remains available.
- Do not add dependencies or enumerate catalog units in web code.

## Review Focus

- Malformed inline text must block loss-prone navigation until corrected or cancelled; test the validity callback and Escape.
- Nested `processing.mean` edits must preserve sibling fields; test the model command and variant override.
- Missing queue/attempt values must show catalog defaults; retain existing canvas tests.
- Edge labels must remain selectable and diagnostic severity visible after moving to HTML; test labels, diagnostics and selection.
- A variant edit must change only the experiment document; test the saved request in App and the stored document in E2E.

---

### Task 1: Shared Parsing And Nested Model Commands

**Files:**
- Create: `web/src/workspace/paramParsing.ts`
- Modify: `web/src/inspector/ParamField.tsx`
- Modify: `web/src/workspace/params.ts`
- Modify: `web/src/workspace/params.test.ts`
- Modify: `web/src/inspector/Inspector.test.tsx`

**Interfaces:**
- Produces: `parseParam(descriptor: ParamDescriptor, draft: string, checkRange?: boolean): ParsedParam`.
- Produces: dotted paths in `withParam(model, id, path, value)` and therefore `setModelParam`, preserving existing top-level behavior.

- [ ] **Step 1: Write failing tests**

Add a `withParam` test that changes `processing.mean` and preserves `processing.kind` and all other documents' values. Keep the existing inspector tests for malformed input, units and parseable range errors unchanged as the compatibility contract.

- [ ] **Step 2: Run tests to verify the nested-path test fails**

Run: `npm test -- --run src/workspace/params.test.ts`
Expected: the new dotted-path assertion fails.

- [ ] **Step 3: Implement shared parsing and dotted-path updates**

Move `parse` and `inRange` from `ParamField.tsx` to `paramParsing.ts`, renaming only the exported entry point. Extend `withParam` to update or delete a nested leaf immutably when its `name` argument contains dots.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- --run src/workspace/params.test.ts src/inspector/Inspector.test.tsx`
Expected: all tests pass, including range and unit behavior.

- [ ] **Step 5: Commit**

```bash
git add web/src/workspace/paramParsing.ts web/src/inspector/ParamField.tsx web/src/workspace/params.ts web/src/workspace/params.test.ts
git commit -m "refactor: share parameter parsing with canvas"
```

### Task 2: Inline Node And Edge Editors

**Files:**
- Create: `web/src/canvas/InlineParamEditor.tsx`
- Create: `web/src/canvas/CallEdge.tsx`
- Modify: `web/src/canvas/BlockNode.tsx`
- Modify: `web/src/canvas/Canvas.tsx`
- Modify: `web/src/canvas/Canvas.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `parseParam` from Task 1.
- Produces: `InlineParamEditor` with descriptor/value editing, validity reporting, Enter commit and Escape cancellation.
- Produces: Canvas callbacks `onParam(id, path, value)` and `onValidity(key, valid)` plus `parametersEditable`, independent of structural `editable`.

- [ ] **Step 1: Write failing canvas tests**

Cover service handlers, queue and processing mean; call timeout and attempts; Enter commit; malformed text preservation; Escape cancellation; validity reporting; catalog defaults; edge diagnostics and selection.

- [ ] **Step 2: Run tests to verify the new behavior fails**

Run: `npm test -- --run src/canvas/Canvas.test.tsx`
Expected: inline value locators do not find editable controls and commits do not occur.

- [ ] **Step 3: Implement inline controls and the HTML call label**

Build `InlineParamEditor` around the shared parser and catalog descriptors. Use `BaseEdge`, `getBezierPath` and `EdgeLabelRenderer` for call labels. Add `nodrag nopan` and pointer events only to interactive labels; keep request edges and structural editing behavior unchanged.

- [ ] **Step 4: Run canvas and inspector tests**

Run: `npm test -- --run src/canvas/Canvas.test.tsx src/inspector/Inspector.test.tsx`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/canvas web/src/styles.css
git commit -m "feat: add inline parameter editors to canvas"
```

### Task 3: Variant Wiring And End-To-End Acceptance

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/e2e/editor.spec.ts`
- Modify: `AGENTS.md` only if the recorded current-state description requires it.

**Interfaces:**
- Consumes: Canvas `onParam`, `onValidity`, `parametersEditable` from Task 2.
- Consumes: existing `setVariantParam` and `setModelParam` commands.

- [ ] **Step 1: Write failing App and E2E tests**

Unit: edit a call timeout on the No retries page from its canvas label, save, and assert that only the experiment PUT contains `gateway-to-middle.timeout`; add undo coverage. E2E: edit timeout on the Model page and undo, then edit it on No retries, save and verify the model is unchanged and the experiment has the override.

- [ ] **Step 2: Run the App test to verify it fails**

Run: `npm test -- --run src/App.test.tsx`
Expected: no canvas parameter editor is wired to workspace commands.

- [ ] **Step 3: Wire canvas edits to existing commands**

On model pages call `workspace.setParam(id, path, value)`. On variant pages execute `setVariantParam(variant.id, id, path, value ?? null, catalog)`. Pass the existing invalid-field registrar and keep parameter editing independent of structural edit permission.

- [ ] **Step 4: Run focused and complete web checks**

Run: `npm test -- --run src/App.test.tsx src/canvas/Canvas.test.tsx`
Expected: all tests pass.

Run from `web` with Node.js 26.12.1: `npm run lint && npm run api:check && npm test -- --run && npm run build && npm run test:e2e`.
Expected: every command and the new E2E scenario pass.

- [ ] **Step 5: Review and commit**

Run `git diff --check origin/main`, inspect the final diff, and verify that no generated reports or workspace files are included.

```bash
git add web/src/App.tsx web/src/App.test.tsx web/e2e/editor.spec.ts
git commit -m "test: cover inline parameter editing"
```
