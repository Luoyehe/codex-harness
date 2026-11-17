import { useEffect, useState } from 'react';

/** Read-only background polls pause while hidden; execution stays server-owned. */
export function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  return visible;
}
