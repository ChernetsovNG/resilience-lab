import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { catalog, experiment, manifest, model, summary } from "../../test/fixtures";
import { Timeline } from "./Timeline";

it("does not substitute another variant when the selected variant is absent from the run", () => {
  render(<Timeline runId="run-1" summary={summary} manifest={manifest} model={model} experiment={experiment}
    catalog={catalog} activeVariantId="new-variant" pointId="p0" replication={0} cursorWindow={null} selectedNodes={[]} />);
  expect(screen.getByText("The selected variant is not available in this run.")).toBeTruthy();
  expect(screen.queryByText("Baseline (baseline)")).toBeNull();
});
