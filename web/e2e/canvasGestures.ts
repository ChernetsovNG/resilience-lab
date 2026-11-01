import type { Locator } from "@playwright/test";

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Position = Point | ((source: Rect, target: Rect) => Point);
type DragOptions = {
  sourcePosition?: Position;
  targetPosition?: Position;
  button?: "left" | "middle";
  /** Explicit release surface for a negative connection test whose port stops receiving events during the drag. */
  releaseTarget?: Locator;
  beforeDrop?: (source: Rect, target: Rect) => Promise<void>;
};

/** Waits for both source and target rectangles to remain unchanged for two consecutive animation frames. */
export async function waitForStableRects(source: Locator, target = source): Promise<[Rect, Rect]> {
  await source.waitFor({ state: "visible" });
  await target.waitFor({ state: "visible" });
  const elements = [await source.elementHandle(), await target.elementHandle()];
  try {
    return await source.page().evaluate(async elements => {
      const rectangles = () => elements.map(element => {
        if (!element?.isConnected) throw new Error("Canvas gesture element detached while waiting for stable rectangles.");
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width === 0 || height === 0) throw new Error("Canvas gesture element became invisible.");
        return { x, y, width, height };
      }) as [Rect, Rect];
      let previous = rectangles();
      let stableFrames = 0;
      const deadline = performance.now() + 10_000;
      while (stableFrames < 2) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const current = rectangles();
        stableFrames = current.every((rect, index) =>
          rect.x === previous[index].x && rect.y === previous[index].y &&
          rect.width === previous[index].width && rect.height === previous[index].height)
          ? stableFrames + 1 : 0;
        previous = current;
        if (performance.now() >= deadline) throw new Error("Canvas gesture rectangles did not stabilize within 10 seconds.");
      }
      return previous;
    }, elements);
  } finally {
    await Promise.all(elements.map(element => element?.dispose()));
  }
}

/** Checks the actual cursor point, including again when the browser dispatches the input event. */
async function guardHit(locator: Locator, point: Point, role: "source" | "target", rectangle: Rect, releaseTarget?: Locator) {
  const releaseElement = await releaseTarget?.elementHandle();
  try {
    return await locator.evaluateHandle((element, { point, role, rectangle, releaseElement }) => {
      const moved = () => {
        const current = element.getBoundingClientRect();
        return !element.isConnected || current.x !== rectangle.x || current.y !== rectangle.y ||
          current.width !== rectangle.width || current.height !== rectangle.height;
      };
      const errorAt = (x: number, y: number, expected = element): string | null => {
        const hit = document.elementFromPoint(x, y);
        const describe = (node: Element) => `<${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${
          [...node.classList].map(name => `.${name}`).join("")}${
          node.getAttribute("data-testid") ? ` data-testid="${node.getAttribute("data-testid")}"` : ""}>`;
        if (hit === null) return `Canvas gesture ${role} is outside the viewport at (${x}, ${y}).`;
        // A canvas contains its controls too. They are obstructions, not valid drop surfaces.
        const overlay = expected.matches(".react-flow") && hit.closest(".react-flow__panel, .canvas-notice, .canvas-edge-label");
        const receivesEvent = expected.matches(".react-flow__pane") ? hit === expected : expected.contains(hit);
        return receivesEvent && !overlay ? null
          : `Canvas gesture ${role} is covered by ${describe(hit)} at (${x}, ${y}); expected ${describe(expected)}.`;
      };
      const state = { moved: moved(), error: null as string | null };
      if (!state.moved) state.error = errorAt(point.x, point.y);
      if (state.error) throw new Error(state.error);
      const events = ["pointerdown", "mousedown", "click", ...(role === "target" ? ["pointerup", "mouseup", "drop"] : [])];
      const guard = (event: Event) => {
        const { clientX, clientY } = event as MouseEvent;
        const pressing = event.type === "pointerdown" || event.type === "mousedown";
        if (pressing && moved()) state.moved = true;
        // Chromium can still dispatch click after a cancelled pointerdown; do not let that retry select or activate anything.
        const error = event.type === "click" ? state.error
          : state.moved || (role === "target" && pressing) ? null : errorAt(clientX, clientY, releaseElement ?? element);
        if (state.moved || error !== null) {
          state.error = error;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      events.forEach(name => window.addEventListener(name, guard, true));
      return {
        state,
        check: () => {
          const error = state.error ?? errorAt(point.x, point.y, releaseElement ?? element);
          if (error) throw new Error(error);
        },
        dispose: () => events.forEach(name => window.removeEventListener(name, guard, true)),
      };
    }, { point, role, rectangle, releaseElement });
  } finally {
    await releaseElement?.dispose();
  }
}

async function stableDragPoints(source: Locator, target: Locator, options: DragOptions) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [from, to] = await waitForStableRects(source, target);
    const startPosition = typeof options.sourcePosition === "function" ? options.sourcePosition(from, to)
      : options.sourcePosition ?? { x: from.width / 2, y: from.height / 2 };
    const endPosition = typeof options.targetPosition === "function" ? options.targetPosition(from, to)
      : options.targetPosition ?? { x: to.width / 2, y: to.height / 2 };
    const start = { x: from.x + startPosition.x, y: from.y + startPosition.y };
    const end = { x: to.x + endPosition.x, y: to.y + endPosition.y };
    await source.page().mouse.move(start.x, start.y);
    // Hover can change layout. Retry preparation only, before pressing or modifying the model.
    const current = await waitForStableRects(source, target);
    if (JSON.stringify(current) === JSON.stringify([from, to])) return { from, to, start, end };
  }
  throw new Error("Canvas gesture rectangles kept moving while positioning the cursor.");
}

/** Resolves positions only after scrolling and stabilization; never forces input through an obstruction. */
export async function dragCanvas(source: Locator, target: Locator, options: DragOptions = {}): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { from, to, start, end } = await stableDragPoints(source, target, options);
    const mouse = source.page().mouse;
    const guards: Awaited<ReturnType<typeof guardHit>>[] = [];
    let pressed = false;
    try {
      // Resolve the hit target at mousedown: automatic fitting can invalidate sampled screen coordinates.
      guards.push(await guardHit(source, start, "source", from));
      guards.push(await guardHit(target, end, "target", to, options.releaseTarget));
      if ((await Promise.all(guards.map(guard => guard.evaluate(guard => guard.state.moved)))).some(Boolean)) continue;
      pressed = true;
      await mouse.down({ button: options.button });
      const press = await Promise.all(guards.map(guard => guard.evaluate(guard => guard.state)));
      // A late layout change cancels the press in the capture listener, so preparing again cannot duplicate a gesture.
      if (press.some(state => state.moved)) continue;
      const pressError = press.find(state => state.error)?.error;
      if (pressError) throw new Error(pressError);
      await mouse.move(end.x, end.y, { steps: 12 });
      // A second move delivers dragover after Chromium starts native HTML drag-and-drop.
      await mouse.move(end.x, end.y);
      await options.beforeDrop?.(from, to);
      await waitForStableRects(target);
      await guards[1].evaluate(guard => guard.check());
      await mouse.up({ button: options.button });
      pressed = false;
      const releaseError = await guards[1].evaluate(guard => guard.state.error);
      if (releaseError) throw new Error(releaseError);
      return;
    } finally {
      try {
        if (pressed) await mouse.up({ button: options.button });
      } finally {
        await Promise.all(guards.map(async guard => {
          await guard.evaluate(guard => guard.dispose());
          await guard.dispose();
        }));
      }
    }
  }
  throw new Error("Canvas gesture rectangles kept moving before pressing.");
}

export async function dragConnection(source: Locator, target: Locator, options: DragOptions = {}): Promise<void> {
  await dragCanvas(source, target, options);
}

/** Moves from the stable header center by a screen-pixel delta (or a delta derived from stable rectangles). */
export async function dragNode(node: Locator, delta: Point | ((header: Rect, canvas: Rect) => Point)): Promise<void> {
  await dragCanvas(node.locator(".block-node > strong"), node.page().locator(".react-flow"), {
    targetPosition: (header, canvas) => {
      const offset = typeof delta === "function" ? delta(header, canvas) : delta;
      return { x: header.x + header.width / 2 + offset.x - canvas.x,
        y: header.y + header.height / 2 + offset.y - canvas.y };
    },
  });
}

/** Drops a palette block at a position relative to the stable canvas; beforeDrop runs with the mouse held. */
export async function dragPaletteBlock(
  source: Locator, canvas: Locator, position: (canvas: Rect) => Point,
  beforeDrop?: (source: Rect, canvas: Rect) => Promise<void>,
): Promise<void> {
  await dragCanvas(source, canvas, { targetPosition: (_, canvas) => position(canvas), beforeDrop });
}
