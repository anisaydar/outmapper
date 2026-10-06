import { fireEvent, render, screen } from "@testing-library/react";
import { AuthoringDialog } from "./AuthoringDialog.js";

it("closes on a press outside its box but not on a press inside it", () => {
  const onClose = vi.fn();
  render(<AuthoringDialog title="Projects" onClose={onClose}><button type="button">Inside</button></AuthoringDialog>);
  const dialog = screen.getByRole("dialog", { hidden: true });
  dialog.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 300, width: 200, height: 200, x: 100, y: 100, toJSON: () => ({}) });

  fireEvent.mouseDown(screen.getByRole("button", { name: "Inside", hidden: true }));
  fireEvent.mouseDown(dialog, { clientX: 150, clientY: 150 });
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.mouseDown(dialog, { clientX: 20, clientY: 150 });
  expect(onClose).toHaveBeenCalledTimes(1);
});
