import { useEffect, useId, useRef } from "react";

export interface ConfirmationOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function ConfirmationDialog({ title, message, confirmLabel, cancelLabel, onDecision }: ConfirmationOptions & {
  onDecision: (accepted: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const current = dialog.current;
    if (current?.showModal) current.showModal();
    else current?.setAttribute("open", "");
    cancel.current?.focus();
    return () => {
      current?.close?.();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className="file-dialog confirmation-dialog" aria-labelledby={titleId}
    aria-describedby={message === undefined ? undefined : messageId}
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); onDecision(false); }}>
    <form onSubmit={event => { event.preventDefault(); onDecision(true); }}>
      <h2 id={titleId}>{title}</h2>
      {message === undefined ? null : <p id={messageId} className="confirmation-message">{message}</p>}
      <div className="file-dialog-actions">
        <button ref={cancel} type="button" onClick={() => onDecision(false)}>{cancelLabel}</button>
        <button type="submit">{confirmLabel}</button>
      </div>
    </form>
  </dialog>;
}
