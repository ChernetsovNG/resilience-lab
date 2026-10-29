import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { catalog, manifest, model } from "../test/fixtures";
import { Assumptions } from "./Assumptions";

function condition(name: string): string | null | undefined {
  return screen.getByText(name, { exact: true }).nextElementSibling?.textContent;
}

it("shows shared assumptions, only used model types and manifest run conditions", () => {
  const submitted = structuredClone(model);
  submitted.blocks = { client: model.blocks.client, gateway: model.blocks.gateway };
  submitted.connections = model.connections.filter((connection) => connection.type === "request");
  render(<Assumptions catalog={catalog} model={submitted} manifest={manifest} />);

  expect(screen.getByText("Student 95% confidence intervals are not clipped.")).toBeTruthy();
  for (const title of ["Client", "Service", "Request"]) {
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  }
  expect(screen.queryByRole("heading", { name: "Call" })).toBeNull();
  expect(screen.getByText("Handlers are held during downstream calls and backoff.")).toBeTruthy();

  expect(condition("Replications")).toBe("2");
  expect(condition("Seed")).toBe("20,261,025");
  expect(condition("Warmup")).toBe("100 ms");
  expect(condition("Measurement")).toBe("1,000 ms");
  expect(condition("Series window")).toBe("10 ms");
  expect(condition("Sketch profile")).toBe("ddsketch-bitwise6-rational-v1");
  expect(condition("Application version")).toBe("test-app");
  expect(condition("KSL version")).toBe("R1.8.1");
});
