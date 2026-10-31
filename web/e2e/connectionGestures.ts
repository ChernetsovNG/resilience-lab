import type { Locator } from "@playwright/test";

/** Waits for both port rectangles to remain unchanged for two consecutive animation frames. */
export async function waitForStablePorts(source: Locator, target?: Locator): Promise<void> {
  await source.waitFor({ state: "visible" });
  if (target !== undefined) await target.waitFor({ state: "visible" });
  await (target === undefined ? source : source.or(target)).evaluateAll(async (ports, expectedCount) => {
    if (ports.length !== expectedCount) throw new Error("Connection ports changed while waiting for stable rectangles.");
    const rectangles = () => ports.map(port => {
      const { x, y, width, height } = port.getBoundingClientRect();
      return [x, y, width, height];
    });
    let previous = rectangles();
    let stableFrames = 0;
    const deadline = performance.now() + 10_000;
    while (stableFrames < 2) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (ports.some(port => !port.isConnected)) throw new Error("Connection port detached while waiting for stable rectangles.");
      const current = rectangles();
      stableFrames = current.every((rect, index) => rect.every((value, coordinate) => value === previous[index][coordinate]))
        ? stableFrames + 1 : 0;
      previous = current;
      if (performance.now() >= deadline) throw new Error("Connection port rectangles did not stabilize within 10 seconds.");
    }
  }, target === undefined ? 1 : 2);
}

export async function dragConnection(source: Locator, target: Locator): Promise<void> {
  await waitForStablePorts(source, target);
  await source.dragTo(target);
}
