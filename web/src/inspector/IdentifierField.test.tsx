import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { model } from "../test/fixtures";
import { setLanguage } from "../i18n";
import { IdentifierField } from "./IdentifierField";

afterEach(() => setLanguage("en"));

it.each([
  ["en", "References will also be updated in: checkout-grid"],
  ["ru", "Ссылки обновятся также в: checkout-grid"],
] as const)("names other affected experiments under Identifier in %s", (language, text) => {
  setLanguage(language);
  render(<IdentifierField model={model} identifier="gateway" editable onRename={vi.fn()} onValidity={vi.fn()} references={["checkout-grid"]} />);
  const hint = screen.getByText(text);
  expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toContain(hint.id);
});

it("omits the reference hint when no other question uses the element", () => {
  render(<IdentifierField model={model} identifier="gateway" editable onRename={vi.fn()} onValidity={vi.fn()} references={[]} />);
  expect(screen.queryByText(/References will also be updated/)).toBeNull();
  expect(screen.getByRole("textbox").getAttribute("aria-describedby")).toBeNull();
});
