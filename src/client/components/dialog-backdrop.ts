import type { MouseEvent } from "react";

/**
 * A press on a modal dialog's backdrop targets the dialog element itself, outside its box. Dialogs call this from
 * onMouseDown so they close on an outside press, like the other scrims.
 */
export function closeOnBackdropPress(event: MouseEvent<HTMLDialogElement>, close: () => void): void {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
}
