import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ApiError } from "../api/apiClient";
import { ProblemList } from "../layout/ProblemList";
import { CostEstimate } from "../run/CostEstimate";
import { costEstimate } from "../test/fixtures";
import { DiagnosticBadge, DiagnosticMessages } from "../validation/DiagnosticDisplay";
import { problemDiagnostics } from "../validation/diagnostics";
import { messages } from "./index";

const catalog = messages as Record<string, string>;
afterEach(() => { delete catalog["messages.TEST_MESSAGE"]; });

it("translates the same diagnostic in a field, canvas badge, API error and estimate", () => {
  catalog["messages.TEST_MESSAGE"] = "Translated value {value}";
  const diagnostic = { code: "TEST_MESSAGE", message: "Server fallback", args: { value: 1.5 }, severity: "ERROR" as const };
  const problem = { code: "TEST_MESSAGE", message: "Server fallback", args: { value: 2.5 }, diagnostics: [diagnostic] };
  render(<>
    <DiagnosticBadge diagnostics={[diagnostic]} />
    <DiagnosticMessages diagnostics={[diagnostic]} />
    <ProblemList problem={problem} />
    <CostEstimate estimate={{ ...costEstimate, warnings: [diagnostic] }} />
  </>);
  expect(screen.getByRole("img").title).toBe("Translated value 1.5");
  expect(screen.getAllByText(/Translated value 1.5/)).toHaveLength(3);
  expect(screen.getByText("Translated value 2.5")).toBeDefined();
  expect(new ApiError(400, problem).message).toBe("Translated value 2.5");
});

it("keeps scalar arguments when an API error becomes a Problems diagnostic", () => {
  const findings = problemDiagnostics({ code: "TEST_MESSAGE", message: "fallback", args: { value: 0 }, diagnostics: [] });
  expect(findings[0]).toMatchObject({ code: "TEST_MESSAGE", args: { value: 0 } });
});
