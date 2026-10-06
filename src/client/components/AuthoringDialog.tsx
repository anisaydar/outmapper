import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { closeOnBackdropPress } from "./dialog-backdrop.js";

export function AuthoringDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    return () => {
      if (typeof element?.close === "function") element.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className={`authoring-dialog transfer-dialog${wide ? " authoring-dialog--wide" : ""}`} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onCloseRef.current(); }} onMouseDown={(event) => closeOnBackdropPress(event, () => onCloseRef.current())}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>, document.body);
}
