import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog } from "../test/fixtures";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { InlineParamEditor } from "./InlineParamEditor";
import type { Catalog } from "../api/apiTypes";
import fullCatalog from "../test/catalog.json";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it("preserves a malformed draft for an absent required value while language changes", () => {
  const props = { elementId: "gateway", elementType: "service", params: {}, path: "handlers", editable: true,
    onCommit: vi.fn(), onValidity: vi.fn() };
  const { rerender } = render(<InlineParamEditor {...props} catalog={localizeCatalog(catalog)} />);
  fireEvent.doubleClick(screen.getByRole("button", { name: "Handlers: Required" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Handlers" }), { target: { value: "unfinished" } });
  setLanguage("ru");
  rerender(<InlineParamEditor {...props} catalog={localizeCatalog(catalog)} />);
  expect((screen.getByRole("textbox", { name: "Обработчики" }) as HTMLInputElement).value).toBe("unfinished");
  expect(screen.getByRole("alert").textContent).toBe("Введите целое число");
  expect(props.onCommit).not.toHaveBeenCalled();
});

for (const language of ["en", "ru"] as const) {
  it(`shows compact router policy values with full names for editing and help in ${language}`, () => {
    setLanguage(language);
    render(<InlineParamEditor catalog={localizeCatalog(fullCatalog as Catalog)} elementId="router" elementType="router"
      params={{ policy: "leastInFlight" }} modelParams={{ policy: "roundRobin" }} path="policy" overridden editable
      onCommit={vi.fn()} onValidity={vi.fn()} />);
    const full = language === "en" ? "Fewest active requests" : "Меньше активных запросов";
    const value = screen.getByRole("button");
    expect(value.textContent).toBe(language === "en" ? "Least in flight" : "Мин. в работе");
    expect(value.getAttribute("aria-label")).toContain(full);
    expect(screen.getByText(language === "en" ? "Round robin" : "По кругу").closest("del")?.title)
      .toContain(language === "en" ? "Round robin" : "По очереди");
    fireEvent.doubleClick(value);
    expect(screen.getByRole("option", { name: full })).toBeTruthy();
  });
}
