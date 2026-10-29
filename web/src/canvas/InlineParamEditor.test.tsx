import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog } from "../test/fixtures";
import { setLanguage } from "../i18n";
import { localizeCatalog } from "../i18n/catalog";
import { InlineParamEditor } from "./InlineParamEditor";

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
