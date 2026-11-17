import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

// Cache successful modules, never a rejected import. An unavailable optional
// panel must remain local to its own loading surface, preserving chat drafts.
export function deferPanel<P extends object>(load: () => Promise<ComponentType<P>>) {
  let ready: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  return function DeferredPanel(props: P & { loadingFallback: (failed: boolean, retry: () => void) => ReactNode }) {
    const [result, setResult] = useState<{ component?: ComponentType<P>; failed: boolean }>(() => ({ component: ready, failed: false }));
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (ready) { setResult({ component: ready, failed: false }); return; }
      let mounted = true;
      setResult({ failed: false });
      pending ??= Promise.resolve().then(load);
      void pending.then(component => {
        ready = component; pending = undefined;
        if (mounted) setResult({ component, failed: false });
      }, () => {
        pending = undefined;
        if (mounted) setResult({ failed: true });
      });
      return () => { mounted = false; };
    }, [attempt]);
    const Loaded = result.component;
    return Loaded ? <Loaded {...props} /> : props.loadingFallback(result.failed, () => setAttempt(value => value + 1));
  };
}

export const SettingsOnDemand = deferPanel(() => import('./Settings').then(module => module.Settings));
export const TerminalOnDemand = deferPanel(() => import('./TerminalPanel').then(module => module.TerminalPanel));
