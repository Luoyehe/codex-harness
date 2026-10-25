import { uuid } from '../lib/ids';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { draftChanged, emptyDraft, readDraft, writeDraft, type Draft, type DraftAttachment } from '../lib/drafts';
import { message, type Options } from '../lib/types';
import type { ContextNote, DraftReference } from '../lib/input-context';
export function useDraft(key: string) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(key)), [error, setError] = useState('');
  const current = useRef(draft), mounted = useRef(false);
  // Returning to the same key starts a new visit; old callbacks never regain ownership.
  const visit = useMemo(() => ({ active: false }), [key]);
  useLayoutEffect(() => { mounted.current = true; visit.active = true; return () => { visit.active = false; mounted.current = false; }; }, [visit]);
  const load = useCallback(() => { if (!visit.active) return; try { const next = readDraft(key); current.current = next; setDraft(next); setError(''); } catch (e) { current.current = emptyDraft(key); setDraft(current.current); setError(`草稿恢复失败：${message(e)}`); } }, [key, visit]);
  useEffect(load, [load]);
  useEffect(() => { const changed = (event: Event) => { if (!(event instanceof CustomEvent) || event.detail?.key === key) load(); }; window.addEventListener('harness-drafts', changed); return () => window.removeEventListener('harness-drafts', changed); }, [key, load]);
  const update = (patch: Partial<Draft>) => {
    if (!visit.active || current.current.key !== key) return false;
    const previous = current.current;
    const next = { ...previous, ...patch, key, revision: uuid(), updatedAt: Date.now() }; current.current = next; setDraft(next);
    try { writeDraft(next); setError(''); } catch (e) { setError(`草稿保存失败：${message(e)} 当前输入仍留在页面，请保留页面并复制备份。`); }
    return true;
  };
  // Removal belongs to its original draft, including a later visit in this mounted instance.
  const removeAttachment = (attachmentId: string) => {
    try {
      const visible = mounted.current && current.current.key === key;
      const previous = visible ? current.current : readDraft(key);
      if (!previous.attachments.some(attachment => attachment.attachmentId === attachmentId)) return;
      const next = { ...previous, revision: uuid(), updatedAt: Date.now(), attachments: previous.attachments.filter(attachment => attachment.attachmentId !== attachmentId) };
      if (visible) { current.current = next; setDraft(next); }
      writeDraft(next); draftChanged(key);
    }
    catch (e) { if (mounted.current) setError(`附件已移除，但原草稿保存失败：${message(e)} 请保留页面并复制备份。`); }
  };
  const insertTextIfEmpty = (text: string) => {
    const latest = current.current;
    if (latest.key !== key || latest.text || latest.attachments.length || latest.references.length || latest.extraContext.length) return false;
    return update({ text });
  };
  return { ...(draft.key === key ? draft : emptyDraft(key)), error, setText: (text: string) => update({ text }), setOptions: (options: Options) => update({ options }), setAttachments: (attachments: DraftAttachment[]) => update({ attachments }), setReferences: (references: DraftReference[]) => update({ references }), setExtraContext: (extraContext: ContextNote[]) => update({ extraContext }), setOutputSchema: (outputSchema: string) => update({ outputSchema }), removeAttachment, insertTextIfEmpty };
}
