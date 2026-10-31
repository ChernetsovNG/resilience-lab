import { t } from "../i18n";
import { MAX_LISTED_FAULT_REPLICAS, type FaultTarget } from "../workspace/faults";
import { ParamField } from "./ParamField";

/** Address any instance without creating an unbounded native option list. An empty number selects the whole group. */
export function ReplicaTargetField({ target, value, path, editable, onTarget, onValidity }: {
  target?: FaultTarget;
  value: string;
  path: string;
  editable: boolean;
  onTarget: (target: string) => void;
  onValidity: (path: string, valid: boolean) => void;
}) {
  if (target === undefined || target.replicas <= MAX_LISTED_FAULT_REPLICAS) return null;
  return <ParamField descriptor={{ name: "replica", title: t("editor.fault.replicaNumber"), kind: "INTEGER", required: false,
    minimum: 1, maximum: target.replicas, options: [], fields: [], sweepable: false, units: [],
    description: t("editor.fault.replicaNumber.description", { count: MAX_LISTED_FAULT_REPLICAS }),
  }} value={value === target.elementId ? undefined : Number(value.slice(target.elementId.length + 1))}
    path={path} editable={editable} isOverridden={() => false} onValidity={onValidity}
    onCommit={number => onTarget(number === undefined ? target.elementId : `${target.elementId}#${number}`)} />;
}
