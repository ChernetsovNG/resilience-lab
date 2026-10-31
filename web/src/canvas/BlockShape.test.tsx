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
