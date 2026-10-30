import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { array, object, type Item, type Turn } from '../lib/types';
import { Icon } from './Icon';

/** Only public assistant answers qualify. Never copy a mixed synchronization buffer. */
function finalAnswer(turn: Turn): string {
  if (turn.status !== 'completed' || turn.error) return '';
  const messages = turn.items.filter(item => item.type === 'agentMessage');
  const finals = messages.filter(item => item.phase === 'final_answer');
  const last = messages.at(-1);
  const candidates = finals.length ? finals : last && last.phase == null ? [last] : [];
  if (candidates.some(item => item.historySync)) return '';
  const text = (item: Item) => typeof item.text === 'string' ? item.text : array<unknown>(item.content)
    .map(object).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
  return candidates.map(text).filter(value => value.trim()).join('\n\n');
}

export function TurnFooter({ turn, onAction, actionsDisabled = false, active = false }: {
  turn: Turn;
  onAction?: (turn: Turn, action: 'fork' | 'edit' | 'revert') => void;
  actionsDisabled?: boolean;
  active?: boolean;
}) {
  const completed = turn.status === 'completed' && !turn.error;
  const answer = useMemo(() => finalAnswer(turn), [turn]);
  const scope = useMemo(() => ({}), [turn.id, answer]);
  const owner = useRef(scope), mounted = useRef(true), running = useRef(false);
  owner.current = scope;
  const [copying, setCopying] = useState(false);
  const [feedback, setFeedback] = useState<{ owner: object; error: boolean; text: string }>();
  const [menuOpen, setMenuOpen] = useState(false);
  const footer = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const menuContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Reveal the expanded menu only on its explicit open transition, never on
    // streaming updates or clipboard feedback. Keep it in the scroll layout.
    if (menuOpen) menuContent.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [menuOpen]);
  useEffect(() => {
    mounted.current = true;
    const outside = (event: PointerEvent) => {
      if (footer.current && event.target instanceof Node && !footer.current.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => { mounted.current = false; document.removeEventListener('pointerdown', outside); };
  }, []);
  const copy = async () => {
    if (!answer || running.current) return;
    running.current = true; setCopying(true); setFeedback(undefined); setMenuOpen(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(answer);
      if (mounted.current && owner.current === scope) setFeedback({ owner: scope, error: false, text: '已复制最终回答' });
    } catch {
      if (mounted.current && owner.current === scope) setFeedback({ owner: scope, error: true, text: '复制失败，请选择回答文字手动复制。' });
    } finally {
      running.current = false;
      if (mounted.current) setCopying(false);
    }
  };
  const action = (kind: 'fork' | 'edit' | 'revert') => {
    setMenuOpen(false);
    onAction?.(turn, kind);
  };
  if (!completed && (!onAction || turn.status === 'inProgress')) return null;
  return <div className="turn-footer" ref={footer} onKeyDown={event => {
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault(); event.stopPropagation(); setMenuOpen(false); menuButton.current?.focus();
    }
  }}>
    {completed && <span className="turn-completed"><Icon name="check" size={15} />已完成</span>}
    {answer && <button className="button subtle small turn-copy" aria-label="复制最终回答" title="复制最终回答"
      disabled={copying} onClick={() => void copy()}><Icon name="copy" size={15} /><span>{copying ? '复制中…' : '复制'}</span></button>}
    {onAction && turn.status !== 'inProgress' && <button className="icon-button turn-actions" ref={menuButton}
      aria-label="回合操作" title="回合操作" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}><Icon name="more" size={18} /></button>}
    {menuOpen && onAction && turn.status !== 'inProgress' && <div className="turn-menu-row" ref={menuContent}>
      <div className="turn-action-menu" role="group" aria-label="回合操作选项">
        <button className="button small" disabled={actionsDisabled} onClick={() => action('fork')}>从此处分支</button>
        <button className="button small" disabled={actionsDisabled || !turn.items.some(item => item.type === 'userMessage')}
          onClick={() => action('edit')}>从此前编辑消息</button>
        <button className="button danger small" disabled={actionsDisabled || active} onClick={() => action('revert')}>回退至此前</button>
      </div>
    </div>}
    {feedback?.owner === scope && <span className={'small ' + (feedback.error ? 'error' : 'muted')}
      role={feedback.error ? 'alert' : 'status'}>{feedback.text}</span>}
  </div>;
}
