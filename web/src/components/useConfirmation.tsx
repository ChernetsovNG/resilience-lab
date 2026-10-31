import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmationDialog, type ConfirmationOptions } from "./ConfirmationDialog";

/** Await the user's explicit action; render confirmationDialog beside the invoking UI. */
export function useConfirmation() {
  const [request, setRequest] = useState<ConfirmationOptions | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const confirm = useCallback((options: ConfirmationOptions): Promise<boolean> => {
    if (pending.current !== null) return Promise.resolve(false);
    return new Promise(resolve => {
      pending.current = resolve;
      setRequest(options);
    });
  }, []);
  const finish = useCallback((accepted: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(accepted);
  }, []);
  useEffect(() => () => { pending.current?.(false); pending.current = null; }, []);
  return { confirm, confirmationDialog: request === null ? null : <ConfirmationDialog {...request} onDecision={finish} /> };
}
