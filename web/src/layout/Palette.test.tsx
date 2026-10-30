import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalog } from "../test/fixtures";
import { localizeCatalog } from "../i18n/catalog";
import { setLanguage } from "../i18n";
import fullCatalog from "../test/catalog.json";
import type { Catalog } from "../api/apiTypes";
import { Palette } from "./Palette";

describe("Palette", () => {
  it.each(["en", "ru"] as const)("shows a router line icon in %s", language => {
    setLanguage(language);
    try {
      const localized = localizeCatalog(fullCatalog as Catalog);
      render(<Palette catalog={localized} editable onAdd={vi.fn()} />);
      const router = screen.getByRole("button", { name: localized.types.find(type => type.id === "router")!.title });
      expect(router.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
      expect(router.textContent).toBe("");
    } finally { setLanguage("en"); localStorage.removeItem("resilience-lab.language"); }
  });

  it("shows catalog blocks as named icons and describes them on focus", () => {
    const localized = localizeCatalog(catalog);
    render(<Palette catalog={localized} editable onAdd={vi.fn()} />);
    const service = screen.getByRole("button", { name: "Service" });
    expect(service.querySelector("svg")).not.toBeNull();
    fireEvent.focus(service);
    const tooltip = document.getElementById(service.getAttribute("aria-describedby")!);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(tooltip?.textContent).toContain(localized.types.find(type => type.id === "service")!.description);
    expect(screen.queryByText("Connections")).toBeNull();
    expect(screen.queryByText("Request")).toBeNull();
    expect(screen.queryByText("Call")).toBeNull();
    const help = screen.getByRole("button", { name: "Connect blocks" });
    expect(document.getElementById(help.getAttribute("aria-describedby")!)?.textContent)
      .toContain("output port to an input port");
  });

  it("keeps an unknown catalog block available with the first letter of its title", () => {
    const custom = { ...catalog, types: [...catalog.types, { ...catalog.types[0], id: "worker", title: "Worker", category: "BLOCK" as const }] };
    const onAdd = vi.fn();
    render(<Palette catalog={custom} editable onAdd={onAdd} />);
    const worker = screen.getByRole("button", { name: "Worker" });
    expect(worker.querySelector(".palette-icon")?.textContent).toBe("W");
    fireEvent.click(worker);
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("worker");
  });
});
