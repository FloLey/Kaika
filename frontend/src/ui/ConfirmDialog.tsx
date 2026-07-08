import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../lib/portalTarget";

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Styles the confirm button as destructive (delete, overwrite).
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// The app's confirmation prompt for destructive actions, replacing `window.confirm`
// (which blocks the main thread, can't be styled, and is awkward to test). Portals into
// `portalTarget()` so it stays visible while the Studio is fullscreen — the same reason
// NodeSettingsModal does. Escape or a scrim click cancels; the confirm button autofocuses,
// so Enter accepts and Tab reaches Cancel.
export default function ConfirmDialog({
  open,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="anim-modal-scrim" onPointerDown={onCancel} onWheel={(e) => e.stopPropagation()}>
      <div
        className="anim-modal confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={message}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <p className="confirm-dialog-msg">{message}</p>
        <div className="confirm-dialog-actions">
          <button className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={"btn on" + (danger ? " danger" : "")}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    portalTarget()
  );
}
