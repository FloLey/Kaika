// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import ConfirmDialog from "../ui/ConfirmDialog";

// The app's replacement for window.confirm on destructive actions (delete a project,
// overwrite a segment's animation): portaled, escapable, and autofocused on confirm.
describe("ConfirmDialog (jsdom)", () => {
  const setup = (open = true) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open={open}
        message="Delete this?"
        confirmLabel="Delete"
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    return { onConfirm, onCancel };
  };

  it("renders nothing when closed", () => {
    setup(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the message and fires onConfirm from the confirm button", () => {
    const { onConfirm, onCancel } = setup();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete this?");
    fireEvent.click(dialog.querySelector("button.btn.on")!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels from the cancel button, the scrim, and Escape", () => {
    const { onCancel, onConfirm } = setup();
    fireEvent.click(document.querySelectorAll('[role="dialog"] button')[0]); // Cancel
    fireEvent.pointerDown(document.querySelector(".anim-modal-scrim")!);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("autofocuses the confirm button so Enter accepts", () => {
    setup();
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"] button.btn.on'));
  });
});
