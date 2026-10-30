import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { ViewMenu } from "./ViewMenu";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it("offers grid and text settings in both interface languages", () => {
  render(<ViewMenu />);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  const step = screen.getByLabelText<HTMLSelectElement>("Grid step");
  expect([...step.options].map(option => option.value)).toEqual(["10", "20", "40"]);
  expect(step.value).toBe("20");
  const scale = screen.getByLabelText<HTMLSelectElement>("Interface text size");
  expect([...scale.options].map(option => option.value)).toEqual(["90", "100", "110", "125"]);
  expect(scale.value).toBe("100");
  for (const name of ["Snap to grid", "Show grid"]) {
    expect(screen.getByLabelText<HTMLInputElement>(name).checked).toBe(true);
  }
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "ru" } });
  expect(screen.getByLabelText("Шаг сетки")).toBeTruthy();
  expect(screen.getByLabelText("Размер текста интерфейса")).toBeTruthy();
  expect(screen.getByLabelText("Привязка к сетке")).toBeTruthy();
  expect(screen.getByLabelText("Показывать сетку")).toBeTruthy();
});
