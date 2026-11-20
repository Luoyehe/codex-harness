import { useEffect, useState } from 'react';
import { branchDraftSource, discardDraft, executionDraftContext, listDrafts, damagedDrafts, discardDamagedDraft, type Draft, type DraftMode } from '../lib/drafts';
import { damagedFileDrafts, discardDamagedFileDraft, fileDraftKey, unsavedFileDrafts, type FileDraft } from '../lib/file-drafts';
import { downloadBlob, downloadJson } from '../lib/download';
import { message, type Project } from '../lib/types';
export function DraftsSettings({
  projects,
  onOpen,
  draftMode = 'native',
}: {
  projects: Project[];
  onOpen: (key: string) => void;
  draftMode?: DraftMode;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [unsaved, setUnsaved] = useState<FileDraft[]>([]),
    [damaged, setDamaged] = useState<{ storageKey: string; raw: string; file?: boolean }[]>([]),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState('');
  useEffect(() => {
    const refresh = () => {
      setUnsaved(unsavedFileDrafts());
      try {
        setDrafts(listDrafts());
        setDamaged([...damagedDrafts(), ...damagedFileDrafts().map(row => ({ ...row, file: true }))]);
        setError('');
      } catch (e) {
        setError(message(e));
      }
    };
    refresh();
    window.addEventListener('harness-drafts', refresh);
    window.addEventListener('harness-file-drafts', refresh);
    return () => {
      window.removeEventListener('harness-drafts', refresh);
      window.removeEventListener('harness-file-drafts', refresh);
    };
  }, []);
  return (
    <section className="stack">
      <h3>此标签页的本地草稿</h3>
      <p className="muted">
        草稿保留在当前标签页，可跨刷新恢复；关闭标签页后可能丢失。需要长期保留时请导出备份，文件可能包含私密内容。没有发送的草稿不是服务器会话。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {unsaved.map(row => <div className="info-card" key={fileDraftKey(row.projectId, row.path)}>
        <strong>{row.path}</strong>
        <p>文件修改仅保存在当前页面内存中，关闭标签页前请下载备份。</p>
        <button className="button small" onClick={() => {
          try { downloadBlob(new Blob([row.text], { type: 'text/plain;charset=utf-8' }), row.path); }
          catch (e) { setError(message(e)); }
        }}>下载文件草稿备份</button>
      </div>)}
      {drafts.length === 0 && damaged.length === 0 && unsaved.length === 0 && !error && <p className="muted">没有未处理的本地草稿。</p>}
      {damaged.map(row => <div className="info-card" key={row.storageKey}>
        <strong>{row.file ? '文件草稿' : '聊天草稿'}损坏，原始内容仍保留</strong>
        <p>已与其他草稿隔离。请先导出原始内容；丢弃仅删除此条本地记录，不撤销任何服务器操作。</p>
        <div className="inline wrap">
          <button className="button small" onClick={() => downloadBlob(new Blob([row.raw], { type: 'application/octet-stream' }), 'damaged-draft.txt')}>导出原始内容</button>
          <button className="button danger small" onClick={() => {
            if (confirm !== row.storageKey) { setConfirm(row.storageKey); return; }
            try { (row.file ? discardDamagedFileDraft : discardDamagedDraft)(row.storageKey, row.raw); setConfirm(''); }
            catch (e) { setError(message(e)); }
          }}>{confirm === row.storageKey ? '确认丢弃此损坏记录' : '丢弃损坏记录'}</button>
        </div>
      </div>)}
      {drafts.map((draft) => { const context = executionDraftContext(draft.key); return (
        <div className="info-card" key={draft.key}>
          <strong>
            {context.mode === 'root' ? 'ROOT · ' : '普通 · '}
            {branchDraftSource(context.key)
              ? '分支消息草稿'
              : context.key.startsWith('new:')
                ? (projects.find((p) => p.id === context.key.slice(4))?.name ?? '尚未匹配项目的草稿')
                : `会话草稿 ${context.key.slice(0, 8)}`}
          </strong>
          <p className="muted small">
            {draft.text.length} 字符 · {draft.attachments.length} 个附件 · {draft.references.length}{' '}
            个引用 · {draft.extraContext.length} 段资料{draft.outputSchema ? ' · 结构化输出' : ''} ·{' '}
            {new Date(draft.updatedAt).toLocaleString('zh-CN')}
          </p>
          <details>
            <summary>查看草稿内容</summary>
            <pre className="raw">{draft.text || '（没有文字）'}</pre>
            {draft.references.map((reference, index) => (
              <p className="small path" key={index}>
                引用：{reference.label}
              </p>
            ))}
            {draft.extraContext.map((note, index) => (
              <details key={index}>
                <summary>{note.label || '未命名资料'}</summary>
                <pre className="raw">{note.text}</pre>
              </details>
            ))}
            {draft.outputSchema && (
              <details>
                <summary>输出 Schema</summary>
                <pre className="raw">{draft.outputSchema}</pre>
              </details>
            )}
          </details>
          <div className="inline">
            <button className="button small" onClick={() => { try { downloadJson(draft, 'harness-draft.json'); } catch (e) { setError(message(e)); } }}>导出草稿</button>
            <button className="button small" disabled={context.mode !== draftMode} onClick={() => onOpen(draft.key)}>
              打开草稿
            </button>
            {context.mode !== draftMode && <span className="muted small">切换到{context.mode === 'root' ? ' ROOT ' : '普通'}模式后可打开；仍可查看和复制内容。</span>}
            {confirm === draft.key ? (
              <>
                <button
                  className="button danger small"
                  onClick={() => {
                    try {
                      discardDraft(draft.key);
                      setConfirm('');
                    } catch (e) {
                      setError(message(e));
                    }
                  }}
                >
                  确认丢弃
                </button>
                <button className="button small" onClick={() => setConfirm('')}>
                  保留
                </button>
              </>
            ) : (
              <button className="button subtle small" onClick={() => setConfirm(draft.key)}>
                丢弃草稿
              </button>
            )}
          </div>
        </div>
      ); })}
    </section>
  );
}
