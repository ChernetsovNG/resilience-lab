import { t } from "../i18n";
import { formatNumber } from "../i18n/format";
import type { CourseFault } from "./course";

/** Faults are separate from validation findings and open their shared experiment settings. */
export function FaultBadge({ faults = [], onOpen, disabled = false }: {
  faults?: readonly CourseFault[]; onOpen?: (index: number) => void; disabled?: boolean;
}) {
  if (faults.length === 0) return null;
  const label = faults.map(fault => fault.label).join("\n");
  return <button type="button" className="fault-badge nodrag nopan nokey" title={label}
    aria-label={t("course.openFault", { fault: label })} disabled={disabled}
    onClick={event => { event.stopPropagation(); onOpen?.(faults[0].index); }}>
    {t("course.badge", { count: formatNumber(faults.length) })}
  </button>;
}
