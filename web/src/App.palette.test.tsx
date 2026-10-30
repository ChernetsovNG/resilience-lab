import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { documentViews, model, modelPath } from "./test/fixtures";
import { setupAppTests, otherPath, server, open, selectGateway, editHandlers, button, experimentSelect } from "./test/app";

setupAppTests();

describe("palette insertion", () => {

  it.each([1, 0])("adds and selects a centered block as one undo command (click detail %s)", async (detail) => {
    server((url, init) => url.includes(encodeURIComponent(modelPath)) && init?.method !== "PUT" ? {
      body: { ...documentViews[modelPath], content: { model: { ...model, blocks: {}, connections: [] } } },
    } : undefined);
    render(<App />);
    await screen.findByRole("heading", { name: "Run settings" });
    await waitFor(() => expect(button("Service").disabled).toBe(false));
    // Native Enter activation emits a click with detail=0; the browser E2E exercises the key itself.
    fireEvent.click(button("Service"), { detail });
    const node = await screen.findByTestId("rf__node-service-1");
    await waitFor(() => expect(node.classList.contains("selected")).toBe(true));
    expect(node.style.transform).toBe("translate(100px,40px)");
    expect(screen.getByRole("heading", { name: "service-1" })).toBeTruthy();
    fireEvent.click(button("Undo"));
    expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
    expect(button("Undo").disabled).toBe(true);
    fireEvent.click(button("Redo"));
    expect(await screen.findByTestId("rf__node-service-1")).toBeTruthy();
  });

  it("explains blocked insertion on a variant page and disables insertion while an input draft is invalid", async () => {
    server();
    await open();
    fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
    expect(button("Service").disabled).toBe(false);
    fireEvent.click(button("Service"));
    expect(screen.getByRole("alert").textContent).toContain("Structure is edited on the Model page");
    expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    await selectGateway();
    editHandlers("invalid");
    expect(button("Service").disabled).toBe(true);
    expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
  });

});

it("keeps successive palette activations as separate undoable insertions while measuring", async () => {
  server();
  await open();
  fireEvent.click(button("Service"));
  fireEvent.click(button("Service"));
  const second = await screen.findByTestId("rf__node-service-2");
  await waitFor(() => expect(second.classList.contains("selected")).toBe(true));
  expect(screen.getAllByTestId("block-node")).toHaveLength(6);
  fireEvent.click(button("Undo"));
  expect(screen.queryByTestId("rf__node-service-2")).toBeNull();
  expect(screen.getByTestId("rf__node-service-1")).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
  expect(button("Undo").disabled).toBe(true);
});

it("cancels a measured palette insertion when switching experiments before its command", async () => {
  server();
  await open();
  fireEvent.click(button("Service"));
  const preview = await screen.findByTestId("rf__node-service-1");
  expect(preview.classList.contains("selected")).toBe(false);
  fireEvent.change(experimentSelect(), { target: { value: otherPath } });
  await waitFor(() => expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("99"));
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
  expect(button("Undo").disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
});
