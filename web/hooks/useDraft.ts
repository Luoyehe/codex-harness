import { uuid } from '../lib/ids';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  draftChanged,
  emptyDraft,
  readDraft,
  writeDraft,
  type Draft,
  type DraftAttachment,
  type DraftChange,
} from '../lib/drafts';
import { message, type Options } from '../lib/types';
import type { ContextNote, DraftReference } from '../lib/input-context';
export function useDraft(key: string) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(key)),
    [error, setError] = useState('');
  const current = useRef(draft),
    unsaved = useRef(false),
    mounted = useRef(false);
  const acceptedClear = useRef<{ before: string; after: string } | undefined>(undefined);
  // Returning to the same key starts a new visit; old callbacks never regain ownership.
  const visit = useMemo(() => ({ active: false }), [key]);
  useLayoutEffect(() => {
    mounted.current = true;
    visit.active = true;
    return () => {
      visit.active = false;
      mounted.current = false;
    };
  }, [visit]);
  const persist = useCallback((next: Draft, failure = '草稿保存失败') => {
    acceptedClear.current = undefined;
    current.current = next;
    unsaved.current = true;
    setDraft(next);
    try {
      writeDraft(next);
      unsaved.current = false;
      setError('');
    } catch (e) {
      setError(`${failure}：${message(e)} 当前输入仍留在页面，请保留页面并复制备份。`);
    }
  }, []);
  const removeCurrentAttachment = useCallback((attachmentId: string) => {
    const previous = current.current;
    if (!previous.attachments.some((attachment) => attachment.attachmentId === attachmentId))
      return;
    persist({
      ...previous,
      revision: uuid(),
      updatedAt: Date.now(),
      attachments: previous.attachments.filter((attachment) => attachment.attachmentId !== attachmentId),
    }, '附件已移除，但原草稿保存失败');
  }, [persist]);
  const load = useCallback((clearedRevision?: string) => {
    if (!visit.active) return;
    // Also covers input committed before the initial passive load runs.
    if (current.current.key === key && unsaved.current && current.current.revision !== clearedRevision)
      return;
    try {
      const next = readDraft(key);
      acceptedClear.current = clearedRevision === current.current.revision
        ? { before: clearedRevision, after: next.revision } : undefined;
      current.current = next;
      unsaved.current = false;
      setDraft(next);
      setError('');
    } catch (e) {
      // A refresh failure cannot erase the only in-page copy. A new key has no such owner.
      if (current.current.key !== key) {
        current.current = emptyDraft(key);
        unsaved.current = false;
        setDraft(current.current);
      }
      setError(`草稿恢复失败：${message(e)}`);
    }
  }, [key, visit]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    const changed = (event: Event) => {
      if (!visit.active) return;
      const detail = event instanceof CustomEvent
        ? event.detail as { key: string; change?: DraftChange } | undefined : undefined;
      if (detail && detail.key !== key) return;
      const change = detail?.change;
      if (change?.type === 'snapshot-cleared') {
        if (current.current.key === key && current.current.revision === change.revision) load(change.revision);
      } else if (change?.type === 'attachment-removed') {
        if (current.current.key === key) removeCurrentAttachment(change.attachmentId);
      } else load();
    };
    window.addEventListener('harness-drafts', changed);
    return () => window.removeEventListener('harness-drafts', changed);
  }, [key, load, removeCurrentAttachment, visit]);
  const update = (patch: Partial<Draft>) => {
    if (!visit.active || current.current.key !== key) return false;
    const previous = current.current;
    const next = { ...previous, ...patch, key, revision: uuid(), updatedAt: Date.now() };
    persist(next);
    return true;
  };
  // Removal belongs to its original draft, including a later visit in this mounted instance.
  const removeAttachment = (attachmentId: string) => {
    try {
      const visible = mounted.current && current.current.key === key;
      if (visible) {
        removeCurrentAttachment(attachmentId);
        return;
      }
      const previous = readDraft(key);
      if (!previous.attachments.some((attachment) => attachment.attachmentId === attachmentId))
        return;
      const next = {
        ...previous,
        revision: uuid(),
        updatedAt: Date.now(),
        attachments: previous.attachments.filter(
          (attachment) => attachment.attachmentId !== attachmentId,
        ),
      };
      writeDraft(next);
    } catch {
      // A reopened owner still needs the confirmed removal if this old storage read/write failed.
    } finally {
      draftChanged(key, { type: 'attachment-removed', attachmentId });
    }
  };
  const insertTextIfEmpty = (text: string) => {
    const latest = current.current;
    if (
      latest.key !== key ||
      latest.text ||
      latest.attachments.length ||
      latest.references.length ||
      latest.extraContext.length
    )
      return false;
    return update({ text });
  };
  return {
    ...(draft.key === key ? draft : emptyDraft(key)),
    error,
    // Non-input operations do not accept this draft. They may leave only a saved,
    // unchanged snapshot; in particular, pre-existing save failures must stay put.
    canLeave: () => visit.active && !unsaved.current && current.current.key === key &&
      current.current.revision === draft.revision,
    // A successful send may clear its exact snapshot before its promise resolves.
    // Check the live owner synchronously: edits (including ABA) revoke this render's
    // handoff, while that snapshot's accepted cleanup remains safe to leave.
    canLeaveAfterAcceptance: () => visit.active && current.current.key === key && (
      current.current.revision === draft.revision ||
      (acceptedClear.current?.before === draft.revision &&
        acceptedClear.current.after === current.current.revision)
    ),
    setText: (text: string) => update({ text }),
    setOptions: (options: Options) => update({ options }),
    setAttachments: (attachments: DraftAttachment[]) => update({ attachments }),
    setReferences: (references: DraftReference[]) => update({ references }),
    setExtraContext: (extraContext: ContextNote[]) => update({ extraContext }),
    setOutputSchema: (outputSchema: string) => update({ outputSchema }),
    removeAttachment,
    insertTextIfEmpty,
  };
}
