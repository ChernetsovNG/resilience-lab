import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {  } from "./test/fixtures";
import { setupAppTests, server, open, selectGateway, editHandlers, button, editField } from "./test/app";

setupAppTests();


it("exposes undo and redo buttons without putting selection or variant navigation in history", async () => {
  server();
  await open();
  expect(button("Undo").disabled).toBe(true);
  expect(button("Redo").disabled).toBe(true);
  await selectGateway(); editHandlers("5");
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.click(button("Undo"));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("4");
  expect(screen.getByRole("tab", { name: "Baseline" }).getAttribute("aria-selected")).toBe("true");
  expect(button("Save").disabled).toBe(true);
  fireEvent.click(button("Redo"));
  expect((screen.getByLabelText("Handlers") as HTMLInputElement).value).toBe("5");
  expect(button("Save").disabled).toBe(false);
});

it("supports Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y outside form fields", async () => {
  server();
  await open(); await selectGateway(); editHandlers("5");
  const handlers = () => (screen.getByLabelText("Handlers") as HTMLInputElement).value;
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(handlers()).toBe("4");
  fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
  expect(handlers()).toBe("5");
  fireEvent.keyDown(document.body, { key: "z", metaKey: true });
  expect(handlers()).toBe("4");
  fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
  expect(handlers()).toBe("5");
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
  expect(handlers()).toBe("5");
});

it("leaves field undo native and prevents history actions from discarding invalid drafts", async () => {
  server();
  await open(); await selectGateway(); editHandlers("5");
  const input = screen.getByLabelText("Handlers") as HTMLInputElement;
  const nativeUndo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
  fireEvent(input, nativeUndo);
  expect(nativeUndo.defaultPrevented).toBe(false);
  expect(input.value).toBe("5");
  fireEvent.change(input, { target: { value: "invalid" } });
  expect(button("Undo").disabled).toBe(true);
  expect(button("Redo").disabled).toBe(true);
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(input.value).toBe("invalid");
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(input.value).toBe("4");
});

it("renames a block with cascading document writes and restores all documents with undo", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByTestId("rf__node-dependency"));
  const identifier = screen.getByLabelText("Identifier");
  fireEvent.change(identifier, { target: { value: "middle" } });
  expect(button("Save").disabled).toBe(true);
  expect(screen.getByText("This identifier is already used.")).toBeTruthy();
  fireEvent.keyDown(identifier, { key: "Escape" });
  expect((identifier as HTMLInputElement).value).toBe("dependency");
  fireEvent.change(identifier, { target: { value: "storage" } });
  fireEvent.keyDown(identifier, { key: "Enter" });
  await screen.findByTestId("rf__node-storage");
  expect(screen.queryByTestId("rf__node-dependency")).toBeNull();
  expect(screen.getByRole("heading", { name: "storage" })).toBeTruthy();
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const contents = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)));
  expect(contents.map((content) => Object.keys(content)[0])).toEqual(["layout", "model", "experiment"]);
  expect(contents[0].layout.positions.storage).toEqual({ x: 780, y: 100 });
  expect(contents[1].model.connections[2].to).toBe("storage");
  expect(contents[2].experiment.faults[0].target).toBe("storage");
  fireEvent.click(button("Undo"));
  await screen.findByTestId("rf__node-dependency");
  expect(screen.queryByTestId("rf__node-storage")).toBeNull();
  expect(button("Save").disabled).toBe(false);
});

it("deletes a selection with its edges and overrides in one undo step, leaving form deletion native", async () => {
  const fetchMock = server();
  await open();
  fireEvent.click(screen.getByTestId("rf__node-middle"));
  const input = screen.getByLabelText("Handlers");
  const native = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
  fireEvent(input, native);
  expect(native.defaultPrevented).toBe(false);
  expect(screen.getAllByTestId("block-node")).toHaveLength(4);
  fireEvent.keyDown(document.body, { key: "Delete" });
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(3));
  expect(screen.queryByTestId("rf__edge-gateway-to-middle")).toBeNull();
  expect(screen.queryByTestId("rf__edge-middle-to-dependency")).toBeNull();
  fireEvent.click(button("Save"));
  await waitFor(() => expect(button("Save").disabled).toBe(true));
  const saved = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init?.body)));
  expect(saved.find((body) => body.experiment).experiment.variants[1].overrides).toEqual({});
  fireEvent.click(button("Undo"));
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  expect(screen.getByTestId("rf__edge-gateway-to-middle")).toBeTruthy();
});

it("copies multi-selected blocks and internal connections; variant pages reject structural shortcuts", async () => {
  server();
  await open();
  await selectGateway();
  fireEvent.click(screen.getByTestId("rf__node-middle"), { ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "c", metaKey: true });
  fireEvent.keyDown(document.body, { key: "v", metaKey: true });
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(6));
  expect(screen.getByTestId("rf__edge-service-1-to-service-2")).toBeTruthy();
  fireEvent.click(button("Undo"));
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "Delete" });
  expect(screen.getAllByTestId("block-node")).toHaveLength(4);
  expect(button("Save").disabled).toBe(true);
  expect((within(screen.getByRole("complementary", { name: "Palette" })).getByRole("button", { name: "Service" }) as HTMLButtonElement).disabled).toBe(true);
});

it("creates an empty-parameter block by dropping a catalog type and undoes model and layout together", async () => {
  server();
  const { container } = await open();
  fireEvent.drop(container.querySelector(".react-flow")!, {
    clientX: 80, clientY: 40, dataTransfer: { getData: () => "service" },
  });
  await screen.findByTestId("rf__node-service-1");
  expect(screen.getAllByTestId("block-node")).toHaveLength(5);
  fireEvent.click(screen.getByTestId("rf__node-service-1"));
  expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
  // Missing document values are validation issues; only an invalid typed draft blocks navigation.
  expect(button("Undo").disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "oops" } });
  expect(button("Undo").disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Handlers"), { target: { value: "" } });
  fireEvent.click(button("Undo"));
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  expect(button("Save").disabled).toBe(true);
});

it("persists a keyboard move as a layout command and restores it with undo", async () => {
  server();
  await open(); await selectGateway();
  const node = screen.getByTestId("rf__node-gateway");
  fireEvent.keyDown(node, { key: "ArrowRight", code: "ArrowRight" });
  expect(node.style.transform).toBe("translate(280px,100px)");
  expect(button("Save").disabled).toBe(false);
  fireEvent.click(button("Undo"));
  expect(node.style.transform).toBe("translate(260px,100px)");
  expect(button("Save").disabled).toBe(true);
});

it("targets the pasted fragment with subsequent arrow and delete actions", async () => {
  server();
  await open(); await selectGateway();
  fireEvent.click(screen.getByTestId("rf__node-middle"), { ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
  fireEvent.keyDown(document.body, { key: "v", ctrlKey: true });
  const copy = await screen.findByTestId("rf__node-service-1");
  expect(copy.classList.contains("selected")).toBe(true);
  expect(screen.getByTestId("rf__node-gateway").classList.contains("selected")).toBe(false);
  fireEvent.keyDown(copy, { key: "ArrowRight", code: "ArrowRight" });
  expect(copy.style.transform).toBe("translate(320px,140px)");
  expect(screen.getByTestId("rf__node-gateway").style.transform).toBe("translate(260px,100px)");
  fireEvent.keyDown(document.body, { key: "Delete" });
  await waitFor(() => expect(screen.getAllByTestId("block-node")).toHaveLength(4));
  expect(screen.getByTestId("rf__node-gateway")).toBeTruthy();
  expect(screen.getByTestId("rf__node-middle")).toBeTruthy();
  expect(screen.queryByTestId("rf__node-service-1")).toBeNull();
  expect(button("Save").disabled).toBe(true);
});

it.each(["model", "experiment", "random seed"] as const)("marks results stale after %s edits and clears the mark after undo", async (kind) => {
  server();
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Answer" });
  if (kind === "model") {
    await selectGateway();
    editHandlers("5");
  } else if (kind === "experiment") {
    editField("Seed", "43");
  } else {
    const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
      (array as Uint32Array).set([0, 43]);
      return array;
    });
    fireEvent.click(button("Random seed"));
    random.mockRestore();
  }
  const stale = "Results belong to a previous document version.";
  await screen.findByText(stale);

  fireEvent.click(screen.getByRole("tab", { name: "Assumptions" }));
  expect(screen.getByText(stale)).toBeTruthy();
  expect(screen.getByText("Shared assumptions")).toBeTruthy();
  fireEvent.click(button("Undo"));
  expect(screen.queryByText(stale)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Answer" }));
  expect(screen.queryByText(stale)).toBeNull();
});

it("keeps reused diagram element IDs separate through clipboard replacement and undo", async () => {
  server();
  await open();
  fireEvent.click(button("Run"));
  await screen.findByRole("table", { name: "Answer" });
  await selectGateway();
  fireEvent.keyDown(window, { key: "c", ctrlKey: true });
  fireEvent.keyDown(window, { key: "Delete" });
  expect(screen.queryByTestId("rf__node-gateway")).toBeNull();
  fireEvent.keyDown(window, { key: "v", ctrlKey: true });
  const identifier = screen.getByLabelText("Identifier");
  fireEvent.change(identifier, { target: { value: "gateway" } });
  fireEvent.blur(identifier);
  expect(screen.getByTestId("rf__node-gateway")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Baseline" }));
  expect(screen.queryByTestId("canvas-results-gateway")).toBeNull();
  for (let count = 0; count < 3; count++) fireEvent.click(button("Undo"));
  expect(screen.getByTestId("canvas-results-gateway").textContent).toContain("Utilization 50%");
  for (let count = 0; count < 3; count++) fireEvent.click(button("Redo"));
  expect(screen.queryByTestId("canvas-results-gateway")).toBeNull();
});
