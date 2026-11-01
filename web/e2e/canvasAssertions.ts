import { expect, type Locator } from "./fixtures";

/** User-visible focus: the whole element is readable, unobscured and near the drawable area's center. */
export async function expectReadableFocus(element: Locator): Promise<void> {
  await expect(element).toBeInViewport({ ratio: 0.99 });
  await expect.poll(() => element.evaluate(target => {
    const root = target.closest(".model-canvas")!;
    const canvas = root.querySelector(".react-flow")!.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const visibleRect = (selector: string) => {
      const element = root.querySelector<HTMLElement>(selector);
      return element !== null && element.getClientRects().length > 0 ? element.getBoundingClientRect() : null;
    };
    const banner = visibleRect(".variant-banner");
    const course = root.parentElement?.parentElement?.querySelector<HTMLElement>(".course-expanded");
    const courseRect = course?.getClientRects().length ? course.getBoundingClientRect() : null;
    const top = Math.max(canvas.top, banner?.bottom ?? canvas.top);
    const bottom = Math.min(canvas.bottom, courseRect?.top ?? canvas.bottom);
    const obstacles = [".model-results-hint", ".model-info-trigger", ".canvas-navigation", ".variant-banner"]
      .flatMap(selector => { const rect = visibleRect(selector); return rect === null ? [] : [rect]; });
    return {
      insideCanvas: rect.left >= canvas.left - 1 && rect.right <= canvas.right + 1
        && rect.top >= canvas.top - 1 && rect.bottom <= canvas.bottom + 1,
      unobscured: obstacles.every(obstacle => rect.right <= obstacle.left || rect.left >= obstacle.right
        || rect.bottom <= obstacle.top || rect.top >= obstacle.bottom),
      centered: Math.abs(rect.x + rect.width / 2 - canvas.x - canvas.width / 2) <= 8
        && Math.abs(rect.y + rect.height / 2 - (top + bottom) / 2) <= 8,
      readable: new DOMMatrixReadOnly(getComputedStyle(root.querySelector(".react-flow__viewport")!).transform).a >= 0.7,
    };
  })).toEqual({ insideCanvas: true, unobscured: true, centered: true, readable: true });
}
