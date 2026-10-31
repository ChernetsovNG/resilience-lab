import { fireEvent, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { documentViews, modelPath } from "./test/fixtures";
import { replicaFixture } from "./test/replicaResults";
import { button, open, server, setupAppTests } from "./test/app";
import { seriesLoader } from "./results/series";

setupAppTests();

it("opens a saturated replica from Findings, selects its group and keeps result navigation out of Undo", async () => {
  const { run, runModel } = replicaFixture();
  vi.spyOn(seriesLoader, "load").mockResolvedValue([]);
  vi.spyOn(seriesLoader, "loadConnections").mockResolvedValue([]);
  const requests = server(url => {
    if (url.endsWith("/summary")) return { body: run };
    if (url.includes("/workspace/document?") && new URL(url, "http://localhost").searchParams.get("path") === modelPath)
      return { body: { ...documentViews[modelPath], content: { model: runModel } } };
  });
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Findings" });
  fireEvent.click(screen.getByRole("button", { name: /gateway#2 first/ }));
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  expect(await within(inspector).findByRole("heading", { name: "gateway#2" })).toBeTruthy();
  expect((within(inspector).getByRole("combobox", { name: "Fault target" }) as HTMLSelectElement).value).toBe("gateway#2");
  const node = screen.getByTestId("rf__node-gateway");
  expect(node.classList.contains("selected")).toBe(true);
  expect(within(node).getByRole("status").textContent).toContain("Replica #2 selected");
  const differences = inspector.querySelector(".inspector-replicaOverrides")!;
  fireEvent.click(differences.querySelector("summary")!);
  const mean = within(differences as HTMLElement).getByRole("textbox", { name: "Mean" }) as HTMLInputElement;
  expect(mean.value).toBe("99ms");
  expect(mean.readOnly).toBe(true);
  fireEvent.click(button("Analysis"));
  expect(within(inspector).getByRole("textbox", { name: "Mean" })).toBe(mean);
  fireEvent.click(button("Analysis"));
  expect(within(inspector).queryByRole("textbox", { name: "Handlers" })).toBeNull();
  expect(button("Undo").disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
  expect(requests.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  fireEvent.click(node);
  expect(await within(inspector).findByRole("heading", { name: "gateway" })).toBeTruthy();
  expect(within(node).queryByText("Replica #2 selected")).toBeNull();
  expect((within(inspector).getByRole("combobox", { name: "Fault target" }) as HTMLSelectElement).value).toBe("gateway");
});
