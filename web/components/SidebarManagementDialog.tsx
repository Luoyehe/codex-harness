import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { composing, type Project, type Thread } from '../lib/types';
import { useConversation } from '../hooks/useConversation';
import { Dialog } from './Dialog';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

export type SidebarAction =
  | { kind: 'project'; target: Project; action: 'rename' | 'remove' }
  | { kind: 'thread'; target: Thread; action: 'rename' | 'archive' | 'unarchive' | 'delete' };

// The parent keys this dialog by a frozen row/action, independently of navigation.
export function SidebarManagementDialog({
  api, events, epoch, selection, enabled, beforeSubmit, onAccepted, onClose,
}: {
  api: Api;
  events: Events;
  epoch: string;
  selection: SidebarAction;
  enabled: boolean;
  beforeSubmit: () => boolean;
  onAccepted: () => void;
  onClose: () => void;
}) {
  const { target, action: intent, kind } = selection;
  const renaming = intent === 'rename', deleting = intent === 'delete';
  const noun = kind === 'project' ? '项目' : '会话';
  const verb = { rename: '重命名', remove: '移除', archive: '归档', unarchive: '取消归档', delete: '永久删除' }[intent];
  const [name, setName] = useState(target.name ?? ''), [consent, setConsent] = useState(false);
  const [guardError, setGuardError] = useState('');
  const done = useRef(false), submitting = useRef(false);
  const action = useExtensionAction(api, enabled, () => {}, `${kind}:${target.id}:${intent}`);
  // A delete requires complete history, but must never resume a queued task.
  const history = useConversation(api, events, deleting && enabled ? target.id : '', epoch);
  const ready = !deleting || (history.ready && !history.active && !history.realtimeActive);
  const frozen = action.busy || Boolean(action.operation && ['pending', 'unknown'].includes(action.operation.state));
  const complete = () => {
    if (done.current) return;
    done.current = true;
    onAccepted();
  };
  const close = () => { if (!submitting.current) onClose(); };
  useEffect(() => {
    if (action.operation?.state === 'accepted') complete();
  }, [action.operation?.id, action.operation?.state]);
  return (
    <Dialog title={`${verb}${noun}`} onClose={close}>
      <form className="stack" onKeyDown={event => {
        if (event.key === 'Enter' && composing(event)) event.preventDefault();
      }} onSubmit={async event => {
        event.preventDefault();
        if (submitting.current || done.current || action.disabled || !ready ||
          (deleting && !consent) || (renaming && !name.trim())) return;
        if (!beforeSubmit()) {
          setGuardError('当前草稿尚未安全保存。请先关闭此窗口，保存或复制草稿后再操作。');
          return;
        }
        submitting.current = true;
        setGuardError('');
        const method = kind === 'project' ? `project/${intent}` : intent === 'rename' ? 'thread/name/set' : `thread/${intent}`;
        const params = { ...(kind === 'project' ? { id: target.id } : { threadId: target.id }), ...(renaming ? { name: name.trim() } : {}) };
        try {
          if (await action.run(method, params)) complete();
        } finally {
          submitting.current = false;
        }
      }}>
        <p className="small muted">{target.name || target.id}</p>
        {kind === 'project' && <p className="small path">{target.cwd}</p>}
        <fieldset className="submission-fields stack" disabled={frozen}>
          {renaming && <label className="field">{noun}名称
            <input autoFocus required maxLength={kind === 'project' ? 128 : 200} value={name}
              onChange={event => setName(event.target.value)} />
          </label>}
          {intent === 'remove' && <p>只从项目列表中移除，目录、文件和会话历史都会保留。以后可重新添加此目录。</p>}
          {intent === 'archive' && <p>归档后会话保留在此项目的“归档会话”中，可随时取消归档。</p>}
          {intent === 'unarchive' && <p>会话将回到此项目的“最近会话”列表。</p>}
          {deleting && <>
            <p>永久删除此会话的历史记录，无法恢复。工作目录中的文件不会删除，已执行的修改也不会撤销。</p>
            <ReadState loading={history.loading} error={history.error} />
            {!history.ready && !history.loading && <button type="button" className="button small" disabled={!enabled} onClick={history.refresh}>重新读取会话状态</button>}
            {(history.active || history.realtimeActive) && <p role="status">请先结束此会话中正在运行的任务或语音会话。</p>}
            <label className="check-row"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />确认永久删除此会话历史</label>
          </>}
        </fieldset>
        {guardError && <p className="error" role="alert">{guardError}</p>}
        <ExtensionStatus api={api} action={action} recoveryLabel="查询原管理操作回执" />
        <div className="inline">
          <button type="button" className="button" disabled={action.busy} onClick={close}>取消</button>
          <button type="submit" className={`button ${deleting || intent === 'remove' ? 'danger' : 'primary'}`}
            disabled={action.disabled || !ready || (renaming && !name.trim()) || (deleting && !consent)}>
            {action.busy ? '正在处理…' : renaming ? '保存名称' : `${verb}${noun}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
