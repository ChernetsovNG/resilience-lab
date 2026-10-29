import { t } from "./index";

/** Retains a web message's key and arguments across async state and worker boundaries. */
export class MessageError extends Error {
  constructor(readonly key: string, readonly params: Record<string, string | number> = {}) {
    super();
    this.name = "MessageError";
    Object.defineProperty(this, "message", { get: () => t(key, params) });
  }
}
