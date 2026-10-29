import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Chart columns follow their container, including inspector-independent results layouts. */
export function TimelineGrid({ children }: { children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const element = grid.current!;
    const measure = (width: number) => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setColumns(Math.max(1, Math.min(3, Math.floor((width / rem + 0.75) / 28.25))));
    };
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={grid} className="timeline-charts" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{children}</div>;
}
