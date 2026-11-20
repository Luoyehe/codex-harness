import { useEffect, useState } from 'react';

/** Mount with a key identifying the reviewed resource and its revision. */
export function ConfirmAction({ label, confirmation, disabled, onConfirm, className = 'button danger' }:
  { label: string; confirmation: string; disabled: boolean; onConfirm: () => void; className?: string }) {
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => { if (disabled) setReviewing(false); }, [disabled]);
  if (!reviewing) return <button className={className} disabled={disabled} onClick={() => setReviewing(true)}>{label}</button>;
  return <span className="inline wrap" role="group" aria-label={label}>
    <button className="button small" onClick={() => setReviewing(false)}>取消</button>
    <button className={className} disabled={disabled} onClick={() => { setReviewing(false); onConfirm(); }}>{confirmation}</button>
  </span>;
}
