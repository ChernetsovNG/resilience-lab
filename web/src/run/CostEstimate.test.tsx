import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { costEstimate } from "../test/fixtures";
import { CostEstimate } from "./CostEstimate";

it.each([
  [0, "0 KiB"], [512, "0.5 KiB"], [1024, "1 KiB"],
  [819200, "800 KiB"], [1048576, "1 MiB"], [1572864, "1.5 MiB"],
])("formats %s bytes in binary size units", (bytes, expected) => {
  render(<CostEstimate estimate={{ ...costEstimate, estimatedUncompressedBytes: bytes, estimatedArtifactBytes: bytes }} />);
  expect(screen.getByLabelText("Uncompressed size").textContent).toBe(expected);
  expect(screen.getByLabelText("Artifact size").textContent).toBe(expected);
});
