import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { composing } from '../lib/types';
import { useWorkflow } from '../hooks/useWorkflow';
import { useResource } from '../hooks/useResource';
import { Dialog } from './Dialog';
export function ProjectDialog({
  api,
  onClose,
  onAdded,
  onOpen,
}: {
  api: Api;
  onClose: () => void;
  onAdded: () => void;
  onOpen: (projectId: string) => void;
}) {
  const [name, setName] = useState(''),
    [cwd, setCwd] = useState(''),
    [mode, setMode] = useState<'create' | 'existing'>('create'),
    [directory, setDirectory] = useState(''),
    [handoffError, setHandoffError] = useState(''),
    running = useRef(false);
  const defaults = useResource('project-defaults', signal => api.call('project/defaults', {}, signal));
  const root = typeof defaults.data?.directory === 'string' ? defaults.data.directory : '';
  const chosenDirectory = directory || name.trim().replace(/[^\p{L}\p{N} ._-]/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '').replace(/[ .]+$/u, '').slice(0, 80);
  const validDirectory = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,79}$/u.test(chosenDirectory) && !/[ .]$/.test(chosenDirectory);
  const ready = Boolean(name.trim()) && (mode === 'create' ? Boolean(root) && validDirectory : Boolean(cwd.trim()));
  const action = useWorkflow(api, '', true, onAdded);
  const reconciliation = handoffError || (action.operation?.state === 'accepted'
    ? '项目已受理。请关闭窗口后在项目列表中核对，不要重复添加。' : '');
  const frozen = Boolean(reconciliation) || action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const close = () => {
    if (!running.current) onClose();
  };
  const submit = async () => {
    if (running.current || action.disabled || reconciliation || !ready) return;
    running.current = true;
    try {
      const method = mode === 'create' ? 'project/create' : 'project/add';
      const params = mode === 'create' ? { name: name.trim(), directory: chosenDirectory } : { name: name.trim(), path: cwd.trim() };
      const result = await action.run(method, params);
      if (result) {
        if (typeof result.id !== 'string' || !result.id) {
          setHandoffError('项目已受理，但未收到项目编号。请关闭窗口后在项目列表中核对，不要重复添加。');
          return;
        }
        onOpen(result.id);
        onClose();
      }
    } finally {
      running.current = false;
    }
  };
  return (
    <Dialog title="添加项目" onClose={close}>
      <form
        className="stack"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && composing(e)) e.preventDefault();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="submission-fields stack" disabled={frozen}>
          <div className="segmented" role="group" aria-label="添加项目方式">
            <button type="button" className="segmented-option" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>新建项目</button>
            <button type="button" className="segmented-option" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>添加已有目录</button>
          </div>
          <label className="field">
            项目名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoFocus
              placeholder="例如：我的产品"
            />
          </label>
          {mode === 'create' ? <>
            <label className="field">目录名
              <input value={directory} onChange={event => setDirectory(event.target.value)} placeholder={chosenDirectory || 'my-project'} maxLength={80} />
            </label>
            {root ? <p className="small muted">创建位置：<code>{root}{root.includes('\\') ? '\\' : '/'}{chosenDirectory || '目录名'}</code></p> : <p className="small muted">正在读取默认项目目录…</p>}
            <p className="small muted">系统会创建空目录并设置好执行账号权限，可直接开始使用。</p>
            {defaults.error && <div role="alert" className="error">{defaults.error}<button type="button" className="button small" onClick={defaults.refresh}>重试读取目录</button></div>}
          </> : <label className="field">
            服务器上的绝对目录
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              required
              placeholder="/workspace/project"
            />
          </label>}
          {mode === 'existing' && <p className="small muted">填写服务器上的目录。执行账号需要能读取并进入该目录；已有目录的所有权和权限不会被自动修改。</p>}
        </fieldset>
        {action.error && (
          <p role="alert" className="error">
            {action.error}
          </p>
        )}
        {reconciliation && <p role="alert" className="error">{reconciliation}</p>}
        {action.notice && (
          <p className="small muted" role="status">
            {action.notice}
          </p>
        )}
        <button
          className="button primary"
          type="submit"
          disabled={action.disabled || Boolean(reconciliation) || !ready}
        >
          {action.busy ? '正在添加…' : mode === 'create' ? '创建项目' : '添加项目'}
        </button>
      </form>
    </Dialog>
  );
}
