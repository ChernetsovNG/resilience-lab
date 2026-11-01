import { useRef } from "react";

/** Accessible boundary for the panel to its right or below; values are CSS pixels. */
export function PanelSeparator({ orientation, value, minimum, maximum, onChange, onReset, onOverflow, label, valueText, controls, className, hidden }: {
  orientation: "horizontal" | "vertical";
  value: number;
  minimum: number;
  maximum: number;
  onChange: (value: number) => void;
  onReset: () => void;
  onOverflow?: () => void;
  label: string;
  valueText: string;
  controls: string;
  className: string;
  hidden?: boolean;
}) {
  const drag = useRef<{ pointer: number; coordinate: number; value: number } | null>(null);
  const horizontal = orientation === "horizontal";
  const change = (next: number) => {
    if (next > maximum && onOverflow !== undefined) {
      drag.current = null;
      onOverflow();
    }
    else onChange(Math.max(minimum, Math.min(maximum, next)));
  };
  return <div className={`panel-divider panel-divider--${orientation} ${className}`} role="separator" tabIndex={0} hidden={hidden}
    aria-label={label} aria-orientation={orientation} aria-controls={controls}
    aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(value)} aria-valuetext={valueText}
    onDoubleClick={onReset}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, coordinate: horizontal ? event.clientY : event.clientX, value };
    }}
    onPointerMove={event => {
      if (drag.current !== null && drag.current.pointer === event.pointerId) {
        change(drag.current.value + drag.current.coordinate - (horizontal ? event.clientY : event.clientX));
      }
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onKeyDown={event => {
      const next = event.key === (horizontal ? "ArrowUp" : "ArrowLeft") ? value + 16
        : event.key === (horizontal ? "ArrowDown" : "ArrowRight") ? value - 16
          : event.key === "Home" ? minimum : event.key === "End" ? maximum : null;
      if (next === null) return;
      event.preventDefault();
      change(next);
    }} />;
}
