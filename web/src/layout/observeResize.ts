/** Coalesce resize deliveries into the next frame; disconnecting also cancels pending work. */
export function observeResize(elements: readonly Element[], update: (entries: ResizeObserverEntry[]) => void): () => void {
  let frame: number | undefined;
  const observer = new ResizeObserver(entries => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      update(entries);
    });
  });
  elements.forEach(element => observer.observe(element));
  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
