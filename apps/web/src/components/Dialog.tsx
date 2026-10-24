import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isComposingKey } from "../utils/keyboard";

const dialogs: HTMLDivElement[] = [];
const focusable = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Shared dialog behavior: keyboard containment, Escape and focus restoration. */
export function Dialog({ label, onClose, busy = false, className = "", children }: {
  label: string; onClose: () => void; busy?: boolean; className?: string; children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const state = useRef({ onClose, busy });
  state.current = { onClose, busy };
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogs.push(node);
    const candidates = () => Array.from(node.querySelectorAll<HTMLElement>(focusable))
      .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    if (!node.contains(document.activeElement)) (candidates()[0] ?? node).focus();
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== node || isComposingKey(event)) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!state.current.busy) state.current.onClose();
      }
      if (event.key === "Tab") {
        const elements = candidates();
        const first = elements[0] ?? node;
        const last = elements.at(-1) ?? node;
        if (!node.contains(document.activeElement) || document.activeElement === node ||
          event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (dialogs.at(-1) === node && !node.contains(event.target as Node)) (candidates()[0] ?? node).focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", containFocus);
      const top = dialogs.at(-1) === node;
      const index = dialogs.indexOf(node);
      if (index >= 0) dialogs.splice(index, 1);
      if (top && previous?.isConnected) previous.focus();
    };
  }, []);
  const content = <div className="modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <div ref={root} className={`modal${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true"
      aria-label={label} aria-busy={busy || undefined} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  </div>;
  // A navigation breakpoint may hide the component that opened the dialog.
  // Keep its visible surface outside that ancestor while the focus trap lives.
  return typeof document !== "undefined" && document.body ? createPortal(content, document.body) : content;
}
