import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GridMap } from "../results/GridMap";
import { ParamField } from "../inspector/ParamField";
import { catalog, summary } from "../test/fixtures";
import { setLanguage } from "./index";
import { localizeCatalog } from "./catalog";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it("refreshes already mounted Map metric labels in both directions", () => {
  const view = <GridMap summary={summary} activeVariantId="baseline" pointId="point-0" />;
  const { rerender } = render(view);
  expect(screen.getByRole("option", { name: "Success rate" })).toBeDefined();
  setLanguage("ru");
  rerender(<GridMap summary={summary} activeVariantId="baseline" pointId="point-0" />);
  expect(screen.getByRole("option", { name: "Доля успешных" })).toBeDefined();
  setLanguage("en");
  rerender(<GridMap summary={summary} activeVariantId="baseline" pointId="point-0" />);
  expect(screen.getByRole("option", { name: "Success rate" })).toBeDefined();
});

it("translates catalog choice labels while committing the original option value", () => {
  setLanguage("ru");
  const descriptor = localizeCatalog(catalog).types[1].params[2].fields[0];
  const onCommit = vi.fn();
  render(<ParamField descriptor={descriptor} value="fixed" path="processing.kind" editable
    isOverridden={() => false} onCommit={onCommit} onValidity={vi.fn()} />);
  expect((screen.getByRole("option", { name: "Фиксированное значение" }) as HTMLOptionElement).selected).toBe(true);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "exponential" } });
  expect(onCommit).toHaveBeenCalledWith("exponential");
});
