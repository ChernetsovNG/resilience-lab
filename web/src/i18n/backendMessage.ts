import { messages, t } from "./index";
import { formatNumber } from "./format";

interface BackendMessage {
  code?: string | null;
  message: string;
  args?: Record<string, string | number> | null;
  requiresNewRun?: boolean;
}

/** Translate structured API text at display time; older or unknown messages retain the server fallback. */
export function backendMessage(value: BackendMessage): string {
  const message = translate(value);
  return value.requiresNewRun ? t("app.run.restart", { message }) : message;
}

function translate({ code, message, args }: BackendMessage): string {
  if (code == null || args == null) return message;
  const key = `messages.${code}${args?.reason == null ? "" : `.${args.reason}`}`;
  const template = messages[key];
  if (typeof template !== "string") return message;
  const params: Record<string, string> = {};
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    const value = args?.[name];
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) return message;
    params[name] = typeof value === "number" ? formatNumber(value)
      : name === "amplification" && /^\d+$/.test(value) ? formatNumber(BigInt(value))
      : name === "storageSource" ? messages[`messages.storageSource.${value}`] ?? value
      : name === "unit" ? messages[`messages.unit.${value}`] ?? value : value;
  }
  const base = t(key, params);
  const translated = typeof args.replica === "number" && typeof args.service === "string"
    ? t("messages.replica", { message: base, service: args.service, replica: args.replica }) : base;
  const contextual = typeof args.variant === "string" && typeof args.point === "string" &&
    typeof args.replication === "number" && Number.isFinite(args.replication)
    ? t("messages.executionTask", { message: translated, variant: args.variant, point: args.point, replication: formatNumber(args.replication) })
    : translated;
  return typeof args?.points === "string" ? t("messages.points", { message: contextual, points: args.points }) : contextual;
}
