import { fireEvent, render, screen, within } from "@testing-library/react";
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
    fireEvent.doubleClick(worker);
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("worker");
  });

  it("opens details without inserting and closes them with a repeated click, Escape or outside pointer", () => {
    const onAdd = vi.fn();
    render(<Palette catalog={catalog} editable onAdd={onAdd} />);
    const service = screen.getByRole("button", { name: "Service" });
    fireEvent.click(service, { detail: 1 });
    const card = screen.getByRole("dialog", { name: "About Service" });
    expect(card.textContent).toContain(catalog.types.find(type => type.id === "service")!.description);
    expect(service.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(service, { detail: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(service, { detail: 1 });
    fireEvent.keyDown(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(service);
    fireEvent.click(service, { detail: 1 });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it.each(["en", "ru"] as const)("adds through the card and opens existing type help in %s", language => {
    setLanguage(language);
    try {
      const localized = localizeCatalog(catalog);
      const onAdd = vi.fn();
      render(<Palette catalog={localized} editable onAdd={onAdd} />);
      const service = screen.getByRole("button", { name: localized.types.find(type => type.id === "service")!.title });
      fireEvent.click(service);
      fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Add" : "Добавить" }));
      expect(onAdd).toHaveBeenCalledExactlyOnceWith("service");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(service);
      const help = screen.getByRole("button", { name: language === "en" ? "Type help" : "Справка о типе" });
      fireEvent.click(help);
      const dialog = screen.getByRole("dialog", { name: localized.types.find(type => type.id === "service")!.title });
      expect(within(dialog).getByRole("table")).toBeTruthy();
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
      expect(document.activeElement).toBe(help);
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    } finally { setLanguage("en"); localStorage.removeItem("resilience-lab.language"); }
  });

  it("inserts once for the browser double-click sequence or one Enter keypress", () => {
    const onAdd = vi.fn();
    render(<Palette catalog={catalog} editable onAdd={onAdd} />);
    const service = screen.getByRole("button", { name: "Service" });
    fireEvent.click(service, { detail: 1 });
    fireEvent.click(service, { detail: 2 });
    fireEvent.doubleClick(service, { detail: 2 });
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("service");
    expect(screen.queryByRole("dialog")).toBeNull();
    onAdd.mockClear();
    fireEvent.keyDown(service, { key: "Enter" });
    fireEvent.keyDown(service, { key: "Enter", repeat: true });
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("service");
  });

  it("keeps details and help available while insertion is unavailable", () => {
    const onAdd = vi.fn();
    render(<Palette catalog={catalog} onAdd={onAdd} />);
    const service = screen.getByRole("button", { name: "Service" });
    expect((service as HTMLButtonElement).disabled).toBe(false);
    expect(service.draggable).toBe(false);
    fireEvent.click(service);
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.doubleClick(service);
    fireEvent.keyDown(service, { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Type help" }));
    expect(screen.getByRole("dialog", { name: "Service" })).toBeTruthy();
  });
});
