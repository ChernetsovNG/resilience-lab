import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { catalog, model } from "../test/fixtures";
import fullCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { VariantChanges } from "./VariantChanges";

afterEach(() => { setLanguage("en"); localStorage.clear(); });

it("labels and navigates a field applicable only in the variant", () => {
  const onSelect = vi.fn();
  render(<VariantChanges model={model} catalog={fullCatalog as Catalog} onSelect={onSelect} overrides={{
    "gateway-to-middle.network.kind": "lognormal", "gateway-to-middle.network.stdDev": "1ms",
  }} />);
  const field = screen.getByRole<HTMLButtonElement>("button", { name: "gateway → middle (gateway-to-middle) · Network delay · Standard deviation: Not set → 1ms" });
  expect(field.disabled).toBe(false);
  fireEvent.click(field);
  expect(onSelect).toHaveBeenCalledWith("gateway-to-middle", "network.stdDev");
});

it("shows effective defaults for omitted and null fields of whole-object overrides", () => {
  const snapshot = structuredClone(model);
  snapshot.connections.find(connection => connection.id === "gateway-to-middle")!.params.pool = { size: 1 };
  render(<VariantChanges model={snapshot} catalog={fullCatalog as Catalog} overrides={{
    "gateway-to-middle.pool": { size: 2, acquireTimeout: null },
  }} />);
  const row = screen.getByRole("button");
  expect(row.textContent).toContain("Acquisition timeout: 30s");
  expect(row.textContent).not.toContain("Not set");
  expect(row.textContent?.match(/30s/g)).toHaveLength(2);
});

it("keeps enough numeric precision to distinguish parameter overrides", () => {
  const snapshot = structuredClone(model);
  const connection = snapshot.connections.find(connection => connection.id === "gateway-to-middle")!;
  connection.params.backoff = { kind: "fixed", multiplier: 1.001 };
  render(<VariantChanges model={snapshot} catalog={catalog} overrides={{ "gateway-to-middle.backoff.multiplier": 1.002 }} />);
  expect(screen.getByRole("button", { name: "gateway → middle (gateway-to-middle) · Backoff · Multiplier: 1.001 → 1.002" })).toBeTruthy();
});

it("resolves defaults within absent objects and formats whole objects with catalog labels", () => {
  const snapshot = structuredClone(model);
  delete snapshot.connections.find(connection => connection.id === "gateway-to-middle")!.params.backoff;
  render(<VariantChanges model={snapshot} catalog={catalog} onSelect={vi.fn()} overrides={{
    "gateway-to-middle.backoff.base": "3ms", "gateway.processing": { kind: "fixed", mean: "5ms" },
  }} />);
  expect(screen.getByRole("button", { name: "gateway → middle (gateway-to-middle) · Backoff · Base delay: 0ms → 3ms" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "gateway · Processing time: Distribution: Fixed · Mean: 1ms → Distribution: Fixed · Mean: 5ms" })).toBeTruthy();
});

it("uses the current language for parameter labels, numbers and empty variants", () => {
  setLanguage("ru");
  const { rerender } = render(<VariantChanges model={model} catalog={localizeCatalog(catalog)} overrides={{ "gateway.handlers": 1234 }} />);
  expect(screen.getByRole("button", { name: "gateway · Обработчики: 4 → 1 234" })).toBeTruthy();
  rerender(<VariantChanges model={model} catalog={localizeCatalog(catalog)} overrides={{}} />);
  expect(screen.getByText("Как в модели")).toBeTruthy();
});

it("keeps invalid override paths visible and disables navigation while a draft is invalid", () => {
  render(<VariantChanges model={model} catalog={catalog} disabled overrides={{
    "gateway.handlers": 5, "gateway.unknown": 8,
  }} />);
  expect((screen.getByRole("button", { name: "gateway · Handlers: 4 → 5" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: /gateway · unknown:/ }) as HTMLButtonElement).disabled).toBe(true);
});
