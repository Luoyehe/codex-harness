import { createContext, useContext, useEffect, useRef, useState } from 'react';

// Keep only predicates in the dialog owner; never copy credentials into a cache.
export const SettingsDrafts = createContext<Set<() => boolean> | null>(null);
export const hasSettingsDrafts = (registry: Set<() => boolean>) => [...registry].some(check => check());
export function useSettingsDraft(isDirty: boolean | (() => boolean)) {
  const registry = useContext(SettingsDrafts), current = useRef(isDirty);
  current.current = isDirty;
  useEffect(() => {
    const check = () => typeof current.current === 'function' ? current.current() : current.current;
    registry?.add(check);
    return () => { registry?.delete(check); };
  }, [registry]);
}

/** One pending destination, bound to its current account/project/view owner. */
export function useSettingsNavigation(registry: Set<() => boolean>, owner: object) {
  type Intent = { owner: object; proceed: () => void; label: string; detail: string };
  const currentOwner = useRef(owner), pending = useRef<Intent | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  currentOwner.current = owner;
  if (pending.current?.owner !== owner) pending.current = null;
  useEffect(() => () => { pending.current = null; }, [owner]);
  const cancel = () => { pending.current = null; setIntent(null); };
  return {
    intent: intent?.owner === owner ? intent : null,
    request(proceed: () => void, label: string, detail = '继续后，未保存的编辑将丢失；新填写的密钥与授权确认也会清除。') {
      if (currentOwner.current !== owner || pending.current) return;
      if (!hasSettingsDrafts(registry)) { proceed(); return; }
      const next = { owner, proceed, label, detail };
      pending.current = next; setIntent(next);
    },
    cancel,
    confirm() {
      const next = pending.current;
      if (!next || next.owner !== currentOwner.current) return;
      cancel(); next.proceed();
    },
  };
}
