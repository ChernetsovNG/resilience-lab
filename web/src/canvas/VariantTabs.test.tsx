import { Suspense, use, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VariantTabs } from "./VariantTabs";
import { deferred } from "../test/app";
import type { Variant } from "../api/apiTypes";
import { setLanguage } from "../i18n";

afterEach(() => setLanguage("en"));

it.each(["en", "ru"] as const)("names unlabeled variants without exposing generated IDs in %s", locale => {
  setLanguage(locale);
  render(<VariantTabs variants={[
    { id: "baseline", overrides: {} }, { id: "variant-2", label: "  ", overrides: {} },
    { id: "custom", label: "My experiment", overrides: {} },
  ]} active="variant-2" onSelect={vi.fn()} onInspect={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole("tab", { name: locale === "en" ? "Baseline" : "Базовый" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: locale === "en" ? "Variant 2" : "Вариант 2" }).title).not.toContain("variant-2");
  expect(screen.getByRole("tab", { name: "My experiment" })).toBeTruthy();
  expect(screen.getByRole("tablist").textContent).not.toContain("variant-2");
});

it("keeps Add disabled with immediate feedback until the new variant can render", async () => {
  const gate = deferred();
  function PendingVariant() { use(gate.promise); return null; }
  function Editor() {
    const [variants, setVariants] = useState<Variant[]>([{ id: "baseline", label: "Baseline", overrides: {} }]);
    const [active, setActive] = useState<string | null>(null);
    return <>
      <VariantTabs variants={variants} active={active} onSelect={setActive} onInspect={setActive}
        onCommand={() => setVariants([...variants, { id: "variant-1", label: "Variant 1", overrides: {} }])} />
      {variants.length > 1 ? <PendingVariant /> : null}
    </>;
  }
  render(<Suspense fallback={<p>Loading</p>}><Editor /></Suspense>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add variant" })); });
  const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add variant" });
  expect(add.disabled).toBe(true);
  expect(add.getAttribute("aria-busy")).toBe("true");
  expect(add.textContent).toBe("Creating variant…");
  fireEvent.click(add);
  await act(async () => gate.release());
  expect((await screen.findByRole("tab", { name: "Variant 1" })).getAttribute("aria-selected")).toBe("true");
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(add.disabled).toBe(false);
});

it("includes a variant description in its tab hint", () => {
  render(<VariantTabs variants={[{ id: "baseline", label: "Baseline", description: "  Explain why this case exists  ", overrides: {} }]}
    active={null} onSelect={vi.fn()} onInspect={vi.fn()} onCommand={vi.fn()} />);
  expect(screen.getByRole("tab", { name: "Baseline" }).title).toContain("  Explain why this case exists  ");
});
