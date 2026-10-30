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
    saved = useRef(draft),
    unsaved = useRef(false),
    mounted = useRef(false);
  const ownership = useRef(0),
    snapshotOwnership = ownership.current;
  const savedKey = useRef<string | undefined>(undefined);
  const savedNeedsWrite = useRef(false);
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
    if (savedKey.current !== next.key) {
      try { saved.current = readDraft(next.key); }
      catch { saved.current = emptyDraft(next.key); }
      savedKey.current = next.key;
      savedNeedsWrite.current = false;
    }
    acceptedClear.current = undefined;
    current.current = next;
    unsaved.current = true;
    setDraft(next);
    try {
      writeDraft(next);
      saved.current = next;
      savedNeedsWrite.current = false;
      unsaved.current = false;
      setError('');
      return true;
    } catch (e) {
      setError(`${failure}：${message(e)} 当前输入仍留在页面，请保留页面并复制备份。`);
      return false;
    }
  }, []);
  const removeCurrentAttachment = useCallback((attachmentId: string) => {
    const previous = current.current;
    // A confirmed server deletion must not be undone by restoring saved input.
    if (saved.current.key === previous.key && saved.current.attachments.some(
      (attachment) => attachment.attachmentId === attachmentId,
    )) {
      saved.current = { ...saved.current, attachments: saved.current.attachments.filter(
        (attachment) => attachment.attachmentId !== attachmentId,
      ) };
      savedNeedsWrite.current = true;
    }
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
      saved.current = next;
      savedKey.current = key;
      savedNeedsWrite.current = false;
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
        saved.current = current.current;
        savedKey.current = key;
        savedNeedsWrite.current = false;
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
        if (saved.current.key === key && saved.current.revision === change.revision) {
          saved.current = emptyDraft(key);
          savedNeedsWrite.current = false;
        }
        if (current.current.key === key && current.current.revision === change.revision) load(change.revision);
      } else if (change?.type === 'attachment-removed') {
        if (current.current.key === key) removeCurrentAttachment(change.attachmentId);
      } else load();
    };
    window.addEventListener('harness-drafts', changed);
    return () => window.removeEventListener('harness-drafts', changed);
  }, [key, load, removeCurrentAttachment, visit]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (!mounted.current || !unsaved.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, []);
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
    hasUnsaved: current.current.key === key && unsaved.current,
    canNavigateTo: (targetKey: string) => visit.active &&
      (targetKey === current.current.key || !unsaved.current),
    retrySave: () => {
      if (!visit.active || current.current.key !== key) return false;
      return persist(current.current);
    },
    discardUnsaved: (revision: string) => {
      if (!visit.active || current.current.key !== key || current.current.revision !== revision)
        return false;
      // Restore only this owner's last verified save, including confirmed cleanup.
      // This remains possible when browser storage is unavailable; no other draft is touched.
      let next = saved.current.key === key ? saved.current : emptyDraft(key),
        needsWrite = savedNeedsWrite.current;
      try {
        const stored = readDraft(key);
        const contents = (value: Draft) => JSON.stringify([
          value.text, value.options, value.attachments, value.references, value.extraContext, value.outputSchema,
        ]);
        // A write may have reached storage even though its read-back verification failed.
        if (contents(stored) !== contents(next)) needsWrite = true;
        else if (!needsWrite) next = stored;
      } catch {
        needsWrite = true;
      }
      ownership.current++;
      acceptedClear.current = undefined;
      // Confirmed deletion can make the baseline safer than the stored copy.
      // Do not unlock navigation until that projection is durable too.
      if (needsWrite)
        return persist({ ...next, revision: uuid(), updatedAt: Date.now() }, '原稿已恢复，但恢复版本尚未安全保存');
      saved.current = next;
      current.current = next;
      unsaved.current = false;
      setDraft(next);
      setError('');
      return true;
    },
    // Non-input operations do not accept this draft. They may leave only a saved,
    // unchanged snapshot; in particular, pre-existing save failures must stay put.
    canLeave: () => visit.active && ownership.current === snapshotOwnership && !unsaved.current && current.current.key === key &&
      current.current.revision === draft.revision,
    // A successful send may clear its exact snapshot before its promise resolves.
    // Check the live owner synchronously: edits (including ABA) revoke this render's
    // handoff, while that snapshot's accepted cleanup remains safe to leave.
    canLeaveAfterAcceptance: () => visit.active && ownership.current === snapshotOwnership && current.current.key === key && (
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
