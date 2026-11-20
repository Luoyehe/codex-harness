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
// The platform can emit both Escape and cancel for one close request.
let skipNativeCancel = false;
let cancelTimer: ReturnType<typeof setTimeout> | undefined;
function consumeNativeCancelThisTurn() {
  skipNativeCancel = true;
  clearTimeout(cancelTimer);
  cancelTimer = setTimeout(() => { skipNativeCancel = false; }, 0);
}
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
  const compositionActive = useRef(false);
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
    // Native close() restores the previously focused control before React can
    // choose its reading target. Clear a text entry owner before opening a
    // passive dialog so native restoration cannot briefly summon its keyboard.
    if (previous?.matches('textarea,input:not([type=button]):not([type=checkbox]):not([type=radio]),[contenteditable=true]'))
      previous.blur();
    dialog.showModal();
    if (!above.length) dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    for (const layer of above) {
      layer.dialog.close();
      layer.dialog.showModal();
    }
    if (previous && !previous.matches('textarea,input:not([type=button]):not([type=checkbox]):not([type=radio]),[contenteditable=true]') && above.some((layer) => layer.dialog.contains(previous)) && visible(previous))
      previous.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (layers.at(-1)?.dialog !== dialog || !dialog.open) return;
      if (event.key === 'Escape') consumeNativeCancelThisTurn();
      if (compositionActive.current || composing(event) || event.defaultPrevented) return;
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
    document.addEventListener('keydown', keyboard);
    return () => {
      compositionActive.current = false;
      document.removeEventListener('keydown', keyboard);
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
        !previous.matches(':disabled,[aria-disabled="true"],textarea,input:not([type=button]):not([type=checkbox]):not([type=radio]),[contenteditable=true]') &&
        visible(previous) &&
        (!remaining || remaining.contains(previous))
      )
        previous.focus();
      else if (remaining) remaining.focus();
      else
        Array.from(
          document.querySelectorAll<HTMLElement>('.mobile-menu,.sidebar-settings'),
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
      onCompositionStart={() => { compositionActive.current = true; }}
      onCompositionEnd={() => { compositionActive.current = false; consumeNativeCancelThisTurn(); }}
      onCancel={(e) => {
        const alreadyConsumed = e.defaultPrevented;
        e.preventDefault();
        if (!alreadyConsumed && !skipNativeCancel && !compositionActive.current && e.target === ref.current &&
            active && ref.current?.open && layers.at(-1)?.dialog === ref.current) close.current();
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
