import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { open, server, setupAppTests } from "./test/app";
import catalog from "./test/catalog.json";
import en from "./i18n/en.json";
import ru from "./i18n/ru.json";

setupAppTests();

it("shows the summed initial client load and type count without an inline intensity editor", async () => {
  server(url => url === "/api/v1/catalog" ? { body: catalog } : undefined);
  await open();
  const node = screen.getByTestId("rf__node-client");
  fireEvent.click(node);
  fireEvent.click(screen.getByRole("radio", { name: "Several request types" }));
  fireEvent.click(screen.getByRole("button", { name: "Add request type" }));
  await waitFor(() => expect(node.textContent).toContain("240 RPS · request types: 2"));
  expect(node.querySelectorAll(".inline-param")).toHaveLength(1);
});

it("uses request type terminology throughout both message catalogs", () => {
  for (const [language, messages] of [["en", en], ["ru", ru]] as const) {
    const entries = Object.entries(messages).filter(([key]) => key.startsWith("messages.CLASS_")
      || key === "messages.ROUTER_CLASS" || key === "messages.GRID_PATH.classes" || key.startsWith("catalog.types.client.params.classes"));
    expect(entries.length).toBeGreaterThan(10);
    for (const [, value] of entries) expect(value).not.toMatch(language === "en" ? /\bclass(?:es)?\b/i : /класс/i);
  }
});
