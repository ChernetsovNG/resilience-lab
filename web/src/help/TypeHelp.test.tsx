import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Catalog, ModelFile } from "../api/apiTypes";
import { setLanguage, type Language } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import rawCatalog from "../test/catalog.json";
import { experiment, model } from "../test/fixtures";
import { Inspector } from "../inspector/Inspector";
import { TypeHelp } from "./TypeHelp";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it.each(["en", "ru"] as const)("keeps the visible text in the accessible name of a text help trigger in %s", locale => {
  setLanguage(locale);
  const catalog = localizeCatalog(rawCatalog as Catalog, locale);
  const text = locale === "en" ? "Type help" : "Справка о типе";
  render(<TypeHelp catalog={catalog} typeId="service">{text}</TypeHelp>);
  fireEvent.click(screen.getByRole("button", { name: text }));
  expect(within(screen.getByRole("dialog")).getByRole("heading", { name: locale === "en" ? "Service" : "Сервис" })).toBeTruthy();
});

function inspect(typeId: string, locale: Language = "en") {
  setLanguage(locale);
  const catalog = localizeCatalog(rawCatalog as Catalog, locale);
  const type = catalog.types.find(type => type.id === typeId);
  const example: ModelFile = { ...model, blocks: { ...model.blocks, example: { type: typeId, params: {} } } };
  render(<Inspector catalog={catalog} model={example} experiment={experiment} selected="example"
    editable={false} overrides={{}} onParam={vi.fn()} onValidity={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: locale === "en" ? "Help: " + (type?.title ?? typeId) : "Справка: " + (type?.title ?? typeId) }));
  return type;
}

it.each(["en", "ru"] as const)("builds help for every catalog type in %s", locale => {
  const counts: Record<string, number> = { client: 5, service: 8, request: 0, call: 16, router: 1, route: 1, database: 7, pooler: 7 };
  for (const [typeId, count] of Object.entries(counts)) {
    const type = inspect(typeId, locale)!;
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: type.title })).toBeTruthy();
    expect(dialog.textContent).toContain(type.description);
    for (const assumption of type.assumptions) expect(dialog.textContent).toContain(assumption);
    const parameters = within(dialog).queryByRole("table", { name: locale === "en" ? "Parameters" : "Параметры" });
    expect(parameters === null ? 0 : within(parameters).getAllByRole("row").length - 1).toBe(count);
    for (const output of type.outputs) {
      expect(dialog.textContent).toContain(output.title);
      expect(dialog.textContent).toContain(output.description);
    }
    fireEvent.click(within(dialog).getByRole("button", { name: locale === "en" ? "Close help" : "Закрыть справку" }));
    // Each selection is independent, as when moving between elements.
    cleanup();
  }
});

it("shows nested array fields and parameter bounds, without treating initial values as defaults", () => {
  inspect("client");
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("row", { name: /^Time / }).textContent).toContain("≥ 0 ms");
  expect(within(dialog).getByRole("row", { name: /^Intensity / }).textContent).toContain("≥ 0 /ms");
});

it("shows defaults, required values, exclusive bounds and output explanations", () => {
  inspect("service");
  const dialog = screen.getByRole("dialog");
  const handlers = within(dialog).getByRole("row", { name: /^Handlers / });
  expect(handlers.textContent).toContain("Required");
  expect(handlers.textContent).toContain("≥ 1");
  expect(handlers.textContent).not.toContain("Required200");
  expect(within(dialog).getByRole("row", { name: /^Failure rate / }).textContent).toContain("≤ 100 %");
  expect(dialog.textContent).toContain("Handler utilization");
});

it("explains an unknown type", () => {
  inspect("future-block");
  expect(screen.getByRole("dialog").textContent).toContain("Help is unavailable for type “future-block”.");
});

it("moves parameter descriptions behind help while preserving field accessibility", () => {
  const catalog = localizeCatalog(rawCatalog as Catalog);
  render(<Inspector catalog={catalog} model={model} experiment={experiment} selected="gateway"
    editable overrides={{}} onParam={vi.fn()} onValidity={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "Handlers" });
  expect(field.closest(".param-field")!.querySelector("p.param-description")).toBeNull();
  const button = screen.getByRole("button", { name: "More about: Handlers" });
  fireEvent.focus(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.textContent).toBe(catalog.types.find(type => type.id === "service")!.params[0].description);
  expect(field.getAttribute("aria-describedby")).toBe(tooltip.id);
});

it("keeps type help available in the results-only inspector", () => {
  render(<Inspector catalog={localizeCatalog(rawCatalog as Catalog)} model={model} experiment={experiment}
    selected="gateway" editable={false} overrides={{}} onParam={vi.fn()} onValidity={vi.fn()}
    resultsOnly variantId="baseline" results={<p>Recorded metrics</p>} />);
  fireEvent.click(screen.getByRole("button", { name: "Help: Service" }));
  expect(screen.getByRole("dialog").textContent).toContain("Handler utilization");
});
