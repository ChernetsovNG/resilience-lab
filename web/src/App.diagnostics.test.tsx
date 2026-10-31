import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";
import { experimentPath, manifest, modelPath } from "./test/fixtures";
import { setupAppTests, completed, deferred, server, open, selectGateway, editHandlers, button } from "./test/app";

setupAppTests();


it("reveals launch diagnostics and navigates to their element", async () => {
  server((url) => url === "/api/v1/jobs" ? { status: 400, body: { code: "INVALID_MODEL", message: "Run rejected", diagnostics: [
    { code: "PARAM_RANGE", severity: "ERROR", message: "Launch handler error", document: modelPath,
      pointer: "/blocks/gateway/params/handlers", path: "gateway" },
  ] } } : undefined);
  await open();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(button("Run"));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  const row = within(screen.getByRole("tabpanel")).getByRole("button", { name: /Launch handler error/ });
  fireEvent.click(row);
  expect(screen.getByRole("heading", { name: "gateway" })).toBeTruthy();
  expect(button("Errors: 1 · Warnings: 0")).toBeTruthy();
});

it("counts the same validation and job warning once", async () => {
  const warning = { code: "LINT", severity: "WARNING", message: "Budget warning", document: modelPath, pointer: null, path: "gateway" };
  server((url) => {
    if (url === "/api/v1/validate") return { body: { experiment: experimentPath, valid: true, diagnostics: [warning] } };
    if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, diagnostics: [warning] } };
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByText("COMPLETED", { exact: true });
  expect(button("Errors: 0 · Warnings: 1")).toBeTruthy();
});

it("preserves the chosen tab when a repeated launch reveals the panel and returns the same error", async () => {
  const gate = deferred();
  let submissions = 0;
  server(async (url) => {
    if (url !== "/api/v1/jobs") return undefined;
    if (++submissions === 2) await gate.promise;
    return { status: 400, body: { code: "SUBMIT_FAILED", message: "Try again", diagnostics: [] } };
  });
  await open();
  fireEvent.click(button("Run"));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  fireEvent.click(screen.getByRole("tab", { name: "Answer" }));
  fireEvent.click(button("Collapse results"));
  fireEvent.click(button("Run"));
  await waitFor(() => expect(submissions).toBe(2));
  expect(screen.getByRole("tabpanel")).toBeTruthy();
  await act(async () => gate.release());
  await waitFor(() => expect(button("Run").disabled).toBe(false));
  expect(screen.getByRole("tab", { name: "Answer" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel")).toBeTruthy();
});

it("expires launch findings after document edits and reveals the same error in a new validation response", async () => {
  const finding = { code: "PARAM_RANGE", severity: "ERROR" as const, message: "Handler error", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway" };
  let findings: typeof finding[] = [];
  let checks = 0;
  server((url) => {
    if (url === "/api/v1/jobs") return { status: 400, body: { code: "INVALID_MODEL", message: "Run rejected", diagnostics: [finding] } };
    if (url === "/api/v1/validate") {
      checks++;
      return { body: { experiment: experimentPath, valid: findings.length === 0, diagnostics: findings } };
    }
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("button", { name: "Errors: 1 · Warnings: 0" });
  await selectGateway(); editHandlers("5");
  await waitFor(() => expect(checks).toBe(2));
  expect(button("Errors: 0 · Warnings: 0")).toBeTruthy();
  expect(within(screen.getByRole("tabpanel")).queryByRole("button", { name: /Handler error/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Answer" }));
  fireEvent.click(button("Collapse results"));
  findings = [finding];
  editHandlers("6");
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel")).toBeTruthy();
});

it("reveals a resume refusal against the edited documents while the original run remains stale", async () => {
  server((url) => {
    if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
    if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
    if (url === "/api/v1/runs/run-1/resume") return { status: 400, body: { code: "EXPERIMENT_INVALID", message: "Experiment has errors", diagnostics: [
      { code: "RUN_DOCUMENT_CHANGED", severity: "ERROR", message: "Model changed", document: modelPath, pointer: null, path: null },
    ] } };
    return undefined;
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("button", { name: "Resume" });
  await selectGateway(); editHandlers("5");
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Resume").disabled).toBe(false));
  fireEvent.click(screen.getByRole("tab", { name: "Assumptions" }));
  fireEvent.click(button("Collapse results"));
  fireEvent.click(button("Resume"));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toContain("RUN_DOCUMENT_CHANGED");
  expect(button("Errors: 1 · Warnings: 0")).toBeTruthy();
  expect(screen.getByText("Results outdated")).toBeTruthy();
});

it("shows variant warnings on Model, filters Problems by badge and links fields to their variant", async () => {
  const warning = { code: "LINT_TIMEOUT_BUDGET", severity: "WARNING", message: "Baseline timeout budget",
    document: modelPath, pointer: "/connections/1/params/timeout", path: "gateway-to-middle", variant: "baseline" };
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: true, diagnostics: [
    warning,
    { ...warning, message: "No retries timeout budget", document: experimentPath,
      pointer: "/variants/1/overrides/gateway-to-middle.timeout", variant: undefined },
    { ...warning, message: "Baseline backoff budget", pointer: "/connections/1/params/backoff/base" },
    { ...warning, code: "LINT_DEADLINE_BUDGET", message: "Client deadline budget", pointer: "/blocks/client/params/deadline", path: "client" },
    { ...warning, message: "Model handler warning", pointer: "/blocks/gateway/params/handlers", path: "gateway", variant: null },
  ] } } : undefined);
  await open();
  const client = within(screen.getByTestId("rf__node-client"));
  expect((await client.findByRole("button", { name: "Warnings in variants: Baseline" })).classList.contains("diagnostic-badge--variants")).toBe(true);
  const edge = within(screen.getByTestId("canvas-edge-label-gateway-to-middle"));
  const badge = await edge.findByRole("button", { name: "Warnings in variants: Baseline, No retries" });
  expect(badge.title).toBe("Warnings in variants: Baseline, No retries");
  expect(badge.textContent).toContain("3");
  expect(within(screen.getByTestId("rf__node-gateway")).getByRole("img", { name: "1 problems: warning" })
    .classList.contains("diagnostic-badge--variants")).toBe(false);
  expect(screen.queryByRole("tabpanel")).toBeNull();
  fireEvent.click(badge);
  expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tab", { name: "Problems" }).getAttribute("aria-selected")).toBe("true");
  const problems = within(screen.getByRole("tabpanel"));
  expect(problems.getAllByRole("listitem")).toHaveLength(3);
  expect(problems.queryByText("Client deadline budget")).toBeNull();
  const timeout = screen.getByLabelText("Timeout").closest(".param-field")!;
  const links = within(timeout as HTMLElement);
  expect(links.queryByText("Baseline timeout budget")).toBeNull();
  fireEvent.click(links.getByRole("button", { name: "More about: Warnings in variants: Baseline, No retries" }));
  const link = links.getByRole("link", { name: "In variants: Baseline — 1 warning" });
  expect(link.getAttribute("href")).toBe("#variant-baseline");
  expect(links.getByRole("link", { name: "In variants: No retries — 1 warning" })).toBeTruthy();
  const backoff = within(screen.getByLabelText("Base delay").closest(".param-field") as HTMLElement);
  fireEvent.click(backoff.getByRole("button", { name: "More about: Warnings in variants: Baseline" }));
  expect(backoff.getByRole("link", { name: "In variants: Baseline — 1 warning" })).toBeTruthy();
  fireEvent.click(link);
  expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(screen.getByLabelText("Timeout"));
  const inspector = within(screen.getByRole("complementary", { name: "Inspector" }));
  expect(inspector.getByText("Baseline timeout budget")).toBeTruthy();
  expect(within(inspector.getByText("Baseline timeout budget").closest("li")!).getByText("LINT_TIMEOUT_BUDGET")).toBeTruthy();
  expect(inspector.queryByText("No retries timeout budget")).toBeNull();
  expect(edge.getByRole("img", { name: "2 problems: warning" }).classList.contains("diagnostic-badge--variants")).toBe(false);
  expect(edge.queryByRole("button", { name: /in variants/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "No retries" }));
  expect(edge.getByRole("img", { name: "1 problems: warning" })).toBeTruthy();
  fireEvent.click(button("Errors: 0 · Warnings: 5"));
  expect(within(screen.getByRole("tabpanel")).getAllByRole("button")).toHaveLength(5);
});

it("keeps model diagnostics ordinary beside muted variant errors and counts severities accurately", async () => {
  const error = { code: "PARAM_RANGE", severity: "ERROR", message: "Baseline handler error", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway", variant: "baseline" };
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: false, diagnostics: [
    error, { ...error, severity: "WARNING", message: "Baseline handler warning" },
    { ...error, message: "No retries handler error", variant: "no-retries" },
    { ...error, message: "Model handler error", variant: null },
  ] } } : undefined);
  render(<App />);
  const node = within(await screen.findByTestId("rf__node-gateway"));
  const badge = await node.findByRole("button", { name: "Errors in variants: Baseline, No retries" });
  expect(badge.classList.contains("diagnostic--error")).toBe(true);
  expect(badge.classList.contains("diagnostic-badge--variants")).toBe(true);
  expect(node.getByRole("img", { name: "1 problems: error" }).classList.contains("diagnostic-badge--variants")).toBe(false);
  await selectGateway();
  const handlers = within(screen.getByLabelText("Handlers").closest(".param-field") as HTMLElement);
  expect(handlers.getByText("Model handler error")).toBeTruthy();
  expect(handlers.getByText("PARAM_RANGE")).toBeTruthy();
  fireEvent.click(handlers.getByRole("button", { name: "More about: Errors in variants: Baseline, No retries" }));
  expect(handlers.getByRole("link", { name: "In variants: Baseline — 1 error, 1 warning" })).toBeTruthy();
  expect(handlers.getByRole("link", { name: "In variants: No retries — 1 error" })).toBeTruthy();
  expect(button("Run").disabled).toBe(true);
});

it("does not navigate away from an invalid draft through variant diagnostic links or badges", async () => {
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath, valid: true, diagnostics: [
    { code: "LINT", severity: "WARNING", message: "Variant warning", document: modelPath,
      pointer: "/blocks/gateway/params/handlers", path: "gateway", variant: "baseline" },
  ] } } : undefined);
  await open(); await selectGateway();
  fireEvent.click(await screen.findByRole("button", { name: "More about: Warnings in variants: Baseline" }));
  await screen.findByRole("link", { name: "In variants: Baseline — 1 warning" });
  const handlers = screen.getByLabelText("Handlers") as HTMLInputElement;
  fireEvent.change(handlers, { target: { value: "unparseable" } });
  fireEvent.click(screen.getByRole("link", { name: "In variants: Baseline — 1 warning" }));
  expect(screen.getByRole("tab", { name: "Model" }).getAttribute("aria-selected")).toBe("true");
  expect(handlers.value).toBe("unparseable");
  await waitFor(() => expect((within(screen.getByTestId("rf__node-gateway")).getByRole("button", { name: "Warnings in variants: Baseline" }) as HTMLButtonElement).disabled).toBe(true));
});

it("reveals a new error outside the element filter opened by a variant badge", async () => {
  const warning = { code: "LINT", severity: "WARNING", message: "Gateway budget", document: modelPath,
    pointer: "/blocks/gateway/params/handlers", path: "gateway", variant: "baseline" };
  let findings = [warning];
  server((url) => url === "/api/v1/validate" ? { body: { experiment: experimentPath,
    valid: !findings.some(finding => finding.severity === "ERROR"), diagnostics: findings } } : undefined);
  await open();
  fireEvent.click(await within(screen.getByTestId("rf__node-gateway")).findByRole("button", { name: "Warnings in variants: Baseline" }));
  expect(within(screen.getByRole("tabpanel")).getByText("Problems for gateway")).toBeTruthy();
  findings = [warning, { ...warning, code: "PARAM_RANGE", severity: "ERROR", message: "Dependency handler error",
    pointer: "/blocks/dependency/params/handlers", path: "dependency", variant: "baseline" }];
  editHandlers("5");
  await waitFor(() => expect(within(screen.getByRole("tabpanel")).getByText("Dependency handler error")).toBeTruthy());
  expect(within(screen.getByRole("tabpanel")).getAllByRole("listitem")).toHaveLength(2);
});
