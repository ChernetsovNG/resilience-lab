import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { manifest, modelPath } from "./test/fixtures";
import { setupAppTests, completed, server, open, button } from "./test/app";

setupAppTests();

describe("cost estimate and resume", () => {

  it.each(["CANCELLED", "FAILED"] as const)("resumes an incomplete %s run and makes Findings available", async (status) => {
    let resumed = false;
    server((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status, error: status === "FAILED" ? "Execution stopped" : null } };
      if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: resumed } };
      if (url === "/api/v1/runs/run-1/resume") {
        resumed = true;
        return { status: 202, body: { ...completed, id: "resume-1", status: "RUNNING" } };
      }
      if (url === "/api/v1/jobs/resume-1") return { body: { ...completed, id: "resume-1" } };
    });
    await open(); fireEvent.click(button("Run"));
    const resume = await screen.findByRole("button", { name: "Resume" });
    fireEvent.click(resume);
    await screen.findByRole("table", { name: "Findings" });
    expect(screen.getByTestId("job-status").textContent).toBe("COMPLETED");
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it.each([
    [409, "RUN_COMPLETE", []],
    [400, "EXPERIMENT_INVALID", [{ code: "RUN_DOCUMENT_CHANGED", severity: "ERROR", message: "Model changed", document: modelPath, pointer: null, path: null, variant: null }]],
  ] as const)("shows resume refusal %s with diagnostics and a new-run suggestion", async (status, code, diagnostics) => {
    server((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
      if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
      if (url === "/api/v1/runs/run-1/resume") return { status, body: { code, message: "Cannot resume this run", diagnostics } };
    });
    await open(); fireEvent.click(button("Run"));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cannot resume this run");
    expect(alert.textContent).toContain("Start a new run");
    if (status === 400) expect(screen.getByRole("tabpanel").textContent).toContain("RUN_DOCUMENT_CHANGED");
    expect(button("Run").disabled).toBe(false);
    expect(screen.queryByRole("table", { name: "Findings" })).toBeNull();
  });

  it("does not offer Resume when cancellation created no artifact", async () => {
    server((url) => {
      if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
      if (url === "/api/v1/runs/run-1/manifest") return { status: 404, body: { code: "RUN_NOT_FOUND", message: "No artifact", diagnostics: [] } };
    });
    await open(); fireEvent.click(button("Run"));
    await screen.findByText("Run cancelled; the run is incomplete and has no summary.");
    await waitFor(() => expect(button("Run").disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

});

it.each(["Assumptions", "Problems", "Timeline", "collapsed"])("shows resume refusal from %s", async (view) => {
  server((url) => {
    if (url === "/api/v1/jobs") return { status: 202, body: { ...completed, status: "CANCELLED" } };
    if (url === "/api/v1/runs/run-1/manifest") return { body: { ...manifest, complete: false } };
    if (url === "/api/v1/runs/run-1/resume") return {
      status: 409, body: { code: "RUN_COMPLETE", message: "Cannot resume this run", diagnostics: [] },
    };
  });
  await open(); fireEvent.click(button("Run"));
  const resume = await screen.findByRole("button", { name: "Resume" });
  if (view === "collapsed") fireEvent.click(button("Collapse results"));
  else fireEvent.click(screen.getByRole("tab", { name: view }));
  fireEvent.click(resume);
  expect((await screen.findByRole("alert")).textContent).toContain("Start a new run");
});
