import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { expect, it } from "vitest";
import { BlockShape } from "./BlockShape";

it("uses React Flow's measured size and keeps the head round when content makes the Person taller", () => {
  const props = { id: "client", type: "client", width: 180, height: 183, ports: [{ id: "out", direction: "OUT" as const }], editable: true, fill: "#ffeecc" };
  const { container, rerender } = render(<ReactFlowProvider>
    <BlockShape {...props}><strong>client</strong></BlockShape>
  </ReactFlowProvider>);
  const node = screen.getByTestId("block-node").parentElement!;
  const head = () => container.querySelector(".block-shape-outline path")!.getAttribute("d");
  const before = head();
  const port = container.querySelector<HTMLElement>(".react-flow__handle")!;
  expect(port.style.left).toBe("178px");
  expect(port.style.top).toBe("132.8px");
  expect(node.style.paddingTop).toBe("100.6px");
  expect(node.style.getPropertyValue("--node-fill")).toBe("#ffeecc");
  expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 180 183");
  rerender(<ReactFlowProvider>
    <BlockShape {...props} height={251}><strong>client</strong><span>Additional content</span></BlockShape>
  </ReactFlowProvider>);
  expect(container.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 180 251");
  expect(head()).toBe(before);
  expect(port.style.top).toBe("166.8px");
});

it("keeps the lower head arc covered by the body when the client has an override", () => {
  const { container } = render(<ReactFlowProvider>
    <BlockShape id="client" type="client" width={180} height={183} ports={[]} editable overridden><strong>client</strong></BlockShape>
  </ReactFlowProvider>);
  const paths = [...container.querySelectorAll(".block-shape-svg path")];
  const filled = [...container.querySelectorAll(".block-shape-outline path")].filter(path => !path.closest(".block-shape-override"));
  const head = filled[0];
  const body = filled[1];
  const headLayers = paths.filter(path => path.getAttribute("d") === head.getAttribute("d"));
  expect(headLayers).toHaveLength(2);
  for (const layer of headLayers) expect(paths.indexOf(layer)).toBeLessThan(paths.indexOf(body));
});

it("sizes the router from independent content dimensions, not its previous measured footprint", () => {
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollWidth");
  let contentHeight = 50;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true,
    get() { return this.classList.contains("block-node--router") ? 140 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true,
    get() { return this.classList.contains("block-node--router") ? contentHeight : 0; } });
  Object.defineProperty(Element.prototype, "scrollWidth", { configurable: true,
    get() { return this.classList.contains("block-node--router") ? 140 : 0; } });
  try {
    const props = { id: "router", type: "router", ports: [], editable: true };
    const { rerender } = render(<ReactFlowProvider><BlockShape {...props}>Policy and help</BlockShape></ReactFlowProvider>);
    const shape = screen.getByTestId("block-node").parentElement!;
    expect(shape.style.minWidth).toBe("156px");
    expect(shape.style.minHeight).toBe("156px");
    expect(shape.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 156 156");
    // A late observer delivery must not feed a formerly wrapped footprint back into the minimum.
    rerender(<ReactFlowProvider><BlockShape {...props} width={260} height={260}>Policy and help</BlockShape></ReactFlowProvider>);
    expect(shape.style.width).toBe("156px");
    expect(shape.style.height).toBe("156px");
    rerender(<ReactFlowProvider><BlockShape {...props} width={156} height={156} authoredSize>Policy and help</BlockShape></ReactFlowProvider>);
    expect(shape.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 156 156");
    contentHeight = 100;
    rerender(<ReactFlowProvider><BlockShape {...props} width={300} height={300} authoredSize>Translated policy and help</BlockShape></ReactFlowProvider>);
    expect(shape.style.minHeight).toBe("179px");
    expect(shape.style.width).toBe("300px");
  } finally {
    if (originalWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth);
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollWidth", originalScroll);
  }
});
