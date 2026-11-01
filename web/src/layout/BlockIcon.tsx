import type { TypeDescriptor } from "../api/apiTypes";
import { t } from "../i18n";
import { Icon, type IconName } from "./Icon";

const blockIcons = new Map<string, IconName>([
  ["client", "client"], ["service", "service"], ["router", "router"], ["database", "database"], ["pooler", "pooler"],
  ["cache", "database"],
]);

/** The same catalog type icon in the palette and on a canvas node. */
export function BlockIcon({ type }: { type: Pick<TypeDescriptor, "id" | "title"> }) {
  const name = blockIcons.get(type.id);
  if (name === undefined) {
    return <span className="palette-icon" aria-hidden="true">{Array.from(type.title)[0] ?? t("editor.palette.unknownIcon")}</span>;
  }
  return <Icon name={name} className="palette-icon" />;
}
