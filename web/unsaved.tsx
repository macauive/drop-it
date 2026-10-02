import { useEffect, useRef, useState } from "react";

// Draft contents stay in component memory. Only the browser's standard warning
// is used on navigation; private draft text is never persisted to web storage.
export function useUnsavedChanges(dirty: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!pending) return;
    const trigger = document.activeElement;
    dialog.current?.showModal();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, [pending]);
  const guard = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
  };
  const confirmation = pending ? (
    <dialog
      ref={dialog}
      className="discard-dialog"
      aria-labelledby="discard-title"
      onCancel={(event) => {
        event.preventDefault();
        setPending(null);
      }}
    >
      <h2 id="discard-title">Discard unsaved changes?</h2>
      <p>Your changes have not been saved. Keep editing to preserve them.</p>
      <div className="actions">
        <button autoFocus onClick={() => setPending(null)}>
          Keep editing
        </button>
        <button
          className="danger"
          onClick={() => {
            const action = pending;
            setPending(null);
            action();
          }}
        >
          Discard changes
        </button>
      </div>
    </dialog>
  ) : null;
  return { guard, confirmation };
}
