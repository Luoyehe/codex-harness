import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { composing } from '../lib/types';
const Availability = createContext(true);
export function DialogScope({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(Availability);
  return <Availability.Provider value={parentActive && active}>{children}</Availability.Provider>;
}
let nextOrder = 0;
const layers: { dialog: HTMLDialogElement; order: number }[] = [];
const visible = (element: HTMLElement) =>
  !element.closest('[hidden],dialog:not([open])') && element.getClientRects().length > 0;
const controls =
  'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]';
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const active = useContext(Availability),
    available = useRef(active);
  available.current = active;
  const ref = useRef<HTMLDialogElement>(null);
  const [order] = useState(() => nextOrder++);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    layers.push({ dialog, order });
    layers.sort((a, b) => a.order - b.order);
    // React mounts child layout effects first. Restore native stacking in owner
    // order so a retained inner dialog stays above its parent after renewal.
    const above = layers.slice(layers.findIndex((layer) => layer.dialog === dialog) + 1);
    dialog.showModal();
    for (const layer of above) {
      layer.dialog.close();
      layer.dialog.showModal();
    }
    if (previous && above.some((layer) => layer.dialog.contains(previous)) && visible(previous))
      previous.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (layers.at(-1)?.dialog !== dialog || !dialog.open || composing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const candidates = Array.from(dialog.querySelectorAll<HTMLElement>(controls)).filter(
        (el) => el.closest('dialog') === dialog && visible(el),
      );
      const first = candidates[0],
        last = candidates.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (
        (event.shiftKey &&
          (document.activeElement === first || !dialog.contains(document.activeElement))) ||
        (!event.shiftKey &&
          (document.activeElement === last || !dialog.contains(document.activeElement)))
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('keydown', keyboard, true);
      const wasTop = layers.at(-1)?.dialog === dialog;
      layers.splice(
        layers.findIndex((layer) => layer.dialog === dialog),
        1,
      );
      dialog.close();
      // Suspending modal ownership must neither invoke business onClose nor
      // steal focus from the login page or another active dialog.
      if (!available.current || !wasTop) return;
      const remaining = layers.at(-1)?.dialog;
      if (
        previous?.isConnected &&
        visible(previous) &&
        (!remaining || remaining.contains(previous))
      )
        previous.focus();
      else if (remaining) remaining.focus();
      else
        Array.from(
          document.querySelectorAll<HTMLElement>('.mobile-menu,.sidebar-account,#message-input'),
        )
          .find(visible)
          ?.focus();
    };
  }, [active, order]);
  return (
    <dialog
      ref={ref}
      hidden={!active}
      className={wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="关闭对话框" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
