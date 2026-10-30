import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setLanguage } from "../i18n";
import { ViewMenu } from "./ViewMenu";
import { setConfidenceLevel } from "./confidenceLevel";
import { setViewSettings } from "./viewSettings";

afterEach(() => {
  act(() => {
    setLanguage("en");
    setConfidenceLevel(95);
    setViewSettings({ gridStep: 20, snapToGrid: true, showGrid: true, textScale: 100 });
  });
  localStorage.clear();
});

it("offers grid and text settings in both interface languages", () => {
  render(<ViewMenu />);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  expect(screen.queryByLabelText("Confidence level")).toBeNull();
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
  expect(screen.queryByLabelText("Уровень доверия")).toBeNull();
});

it("applies every select and checkbox without closing View", () => {
  render(<ViewMenu />);
  const button = screen.getByRole("button", { name: "View" });
  fireEvent.click(button);
  const expectOpen = () => {
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("combobox", { hidden: true })).toHaveLength(3);
    expect(screen.getAllByRole("checkbox", { hidden: true })).toHaveLength(2);
  };

  fireEvent.change(screen.getByLabelText("Grid step"), { target: { value: "40" } });
  expect(JSON.parse(localStorage.getItem("resilience-lab.viewSettings")!).gridStep).toBe(40);
  expectOpen();
  fireEvent.click(screen.getByLabelText("Snap to grid"));
  expect(JSON.parse(localStorage.getItem("resilience-lab.viewSettings")!).snapToGrid).toBe(false);
  expectOpen();
  fireEvent.click(screen.getByLabelText("Show grid"));
  expect(JSON.parse(localStorage.getItem("resilience-lab.viewSettings")!).showGrid).toBe(false);
  expectOpen();
  fireEvent.change(screen.getByLabelText("Interface text size"), { target: { value: "125" } });
  expect(document.documentElement.style.fontSize).toBe("125%");
  expect(JSON.parse(localStorage.getItem("resilience-lab.viewSettings")!).textScale).toBe(125);
  expectOpen();
  fireEvent.change(screen.getByLabelText("Language"), { target: { value: "ru" } });
  expect(document.documentElement.lang).toBe("ru");
  expect(localStorage.getItem("resilience-lab.language")).toBe("ru");
  expectOpen();
});

it.each(["Escape", "outside click", "View button"])("closes on %s and returns focus to View", (action) => {
  render(<><ViewMenu /><button type="button">Outside</button></>);
  const button = screen.getByRole("button", { name: "View" });
  fireEvent.click(button);
  screen.getByLabelText("Grid step").focus();
  if (action === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  else if (action === "outside click") {
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    fireEvent.click(outside);
  } else fireEvent.click(button);
  expect(screen.queryByLabelText("Grid step")).toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(button);
});

it("consumes Escape only while open and removes its handlers on unmount", () => {
  const { unmount } = render(<ViewMenu />);
  const escape = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  const closedEvent = escape();
  fireEvent(document, closedEvent);
  expect(closedEvent.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  const openEvent = escape();
  fireEvent(document, openEvent);
  expect(openEvent.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  unmount();
  const unmountedEvent = escape();
  fireEvent(document, unmountedEvent);
  expect(unmountedEvent.defaultPrevented).toBe(false);
});
