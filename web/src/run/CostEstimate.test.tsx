import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { costEstimate } from "../test/fixtures";
import { CostEstimate } from "./CostEstimate";
import { setLanguage } from "../i18n";

afterEach(() => setLanguage("en"));

it.each([
  [0, "0 KiB"], [512, "0.5 KiB"], [1024, "1 KiB"],
  [819200, "800 KiB"], [1048576, "1 MiB"], [1572864, "1.5 MiB"],
])("formats %s bytes in binary size units", (bytes, expected) => {
  render(<CostEstimate estimate={{ ...costEstimate, estimatedUncompressedBytes: bytes, estimatedArtifactBytes: bytes }} />);
  expect(screen.getByLabelText("Uncompressed size").textContent).toBe(expected);
  expect(screen.getByLabelText("Artifact size").textContent).toBe(expected);
});

it("uses shared precision for counts, seconds and artifact sizes", () => {
  render(<CostEstimate estimate={{ ...costEstimate, expectedEvents: 1234567.891,
    estimatedSeconds: 1.23456, estimatedArtifactBytes: 1280 }} />);

  expect(screen.getByLabelText("Expected events").textContent).toBe("1,234,567.89");
  expect(screen.getByLabelText("Estimated time").textContent).toBe("1.235 s");
  expect(screen.getByLabelText("Artifact size").textContent).toBe("1.25 KiB");
});

it.each([
  ["en", "replica instances"],
  ["ru", "экземпляры реплик"],
] as const)("names the largest storage contributor in %s", (language, source) => {
  setLanguage(language);
  render(<CostEstimate estimate={{ ...costEstimate, warnings: [{ code: "ESTIMATE_UI_CACHE", message: "server fallback",
    args: { cacheMiB: 64, storageSource: "replicaInstances", sourceRows: 12000 } }] }} />);
  expect(screen.getByRole("list").textContent).toContain(source);
  expect(screen.queryByText("server fallback")).toBeNull();
});
