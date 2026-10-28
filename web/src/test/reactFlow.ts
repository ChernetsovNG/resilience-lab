/** jsdom lacks layout; React Flow needs sizes, SVG text boxes, ResizeObserver and DOMMatrixReadOnly to render. */
export function mockReactFlowDom(): void {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect,
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 180, height: 80, top: 0, left: 0, right: 180, bottom: 80, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 180 },
    offsetHeight: { configurable: true, get: () => 80 },
  });
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    value: class DOMMatrixReadOnly {
      m22: number;

      constructor(transform: string) {
        this.m22 = Number(transform.match(/scale\(([\d.]+)\)/)?.[1] ?? 1);
      }
    },
  });
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      queueMicrotask(() => {
        this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this);
      });
    }

    unobserve() {}

    disconnect() {}
  };
}
