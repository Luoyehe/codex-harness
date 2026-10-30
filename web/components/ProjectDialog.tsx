import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { composing } from '../lib/types';
import { executionIdentity, type ExecutionIdentity } from '../lib/execution-mode';
import { useWorkflow } from '../hooks/useWorkflow';
import { useResource } from '../hooks/useResource';
import { Dialog } from './Dialog';

type Props = {
  api: Api;
  epoch?: string;
  executionMode?: ExecutionIdentity;
  executionModeConfirmed?: boolean;
  enabled?: boolean;
  onClose: () => void;
  onAdded: () => void;
  onOpen: (projectId: string) => void;
};
// Resolve lexical path segments without treating this project base as a sandbox.
function normalizePath(value: string, windows = false) {
  const drive = windows ? /^[A-Za-z]:\//.exec(value)?.[0].slice(0, 2) ?? '' : '';
  const path = drive ? value.slice(2) : value, absolute = path.startsWith('/'), unc = windows && path.startsWith('//');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > (unc ? 2 : 0) && parts.at(-1) !== '..') parts.pop();
      else if (!absolute) parts.push(part);
    } else parts.push(part);
  }
  return drive + (unc ? '//' : absolute ? '/' : '') + parts.join('/') || (absolute ? '/' : '.');
}
export function ProjectDialog({
  api, epoch = '', executionMode, executionModeConfirmed = false, enabled = true,
  onClose, onAdded, onOpen,
}: Props) {
  const [name, setName] = useState(''), [cwd, setCwd] = useState(''),
    [mode, setMode] = useState<'create' | 'existing'>('create'), [directory, setDirectory] = useState('');
  const identityKey = JSON.stringify([api.csrf, epoch, executionMode?.mode, executionMode?.effectiveUid, enabled]);
  const owner = useRef({ api, identityKey, generation: 0 });
  if (owner.current.api !== api || owner.current.identityKey !== identityKey)
    owner.current = { api, identityKey, generation: owner.current.generation + 1 };
  const scope = owner.current;
  const [handoff, setHandoff] = useState<{ owner: object; error: string }>();
  const running = useRef<object | undefined>(undefined);
  const identity = executionIdentity(executionMode);
  // Keep the user's text through reconnection or an identity change, but never
  // reuse old defaults or let an old operation navigate/close the current form.
  const defaults = useResource(`project-defaults:${scope.generation}`, signal => api.call('project/defaults', {}, signal), enabled);
  const root = typeof defaults.data?.directory === 'string' ? defaults.data.directory : '';
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\');
  const defaultsIssue = defaults.loading ? '' : defaults.error || (!(root.startsWith('/') || windows) || /[\u0000-\u001f\u007f]/u.test(root)
    ? '默认项目目录无法确认，请重新读取后再操作。' : '');
  const suggestedDirectory = Array.from(name.trim().replace(/[^\p{L}\p{N} ._-]/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '').replace(/[ .]+$/u, '')).slice(0, 80).join('');
  const rawPath = mode === 'create' ? directory || suggestedDirectory : cwd;
  const path = windows ? rawPath.replaceAll('\\', '/') : rawPath;
  const absolute = path.startsWith('/') || windows && /^[A-Za-z]:\//.test(path);
  // A drive-like Linux filename is still relative; only / separates Linux paths.
  const normalized = normalizePath(path, windows);
  const preview = normalizePath(absolute ? normalized : `${windows ? root.replaceAll('\\', '/') : root}/${normalized}`, windows);
  const invalidUnicode = Array.from(rawPath).some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff);
  const pathIssue = !rawPath ? '' : /[\u0000-\u001f\u007f]/u.test(rawPath) || invalidUnicode ? '项目路径不能包含控制字符或无效 Unicode。' :
    new TextEncoder().encode(rawPath).length > 4096 || new TextEncoder().encode(JSON.stringify({ [mode === 'create' ? 'directory' : 'path']: normalized })).length > 4096
      ? '项目路径超过 4096 字节请求上限。' : mode === 'create' && normalized === '/' ? '不能新建服务器根目录 /，请填写要创建的项目路径。' : '';
  const ready = Boolean(name.trim() && rawPath) && !defaults.loading && !defaultsIssue && !pathIssue;
  const action = useWorkflow(api, '', enabled, onAdded, String(scope.generation));
  const reconciliation = (handoff?.owner === scope ? handoff.error : '') || (action.operation?.state === 'accepted'
    ? '项目已受理。请关闭窗口后在项目列表中核对，不要重复添加。' : '');
  const frozen = Boolean(reconciliation) || action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const close = () => { if (running.current !== scope) onClose(); };
  const submit = async () => {
    if (running.current === scope || owner.current !== scope || action.disabled || reconciliation || !ready) return;
    running.current = scope;
    try {
      const method = mode === 'create' ? 'project/create' : 'project/add';
      const params = mode === 'create' ? { name: name.trim(), directory: normalized } : { name: name.trim(), path: normalized };
      const result = await action.run(method, params);
      if (result && owner.current === scope) {
        if (typeof result.id !== 'string' || !result.id) {
          setHandoff({ owner: scope, error: '项目已受理，但未收到项目编号。请关闭窗口后在项目列表中核对，不要重复添加。' });
          return;
        }
        onOpen(result.id); onClose();
      }
    } finally { if (running.current === scope) running.current = undefined; }
  };
  return <Dialog title="添加项目" onClose={close}>
    <form className="stack" onKeyDown={event => { if (event.key === 'Enter' && composing(event)) event.preventDefault(); }}
      onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset className="submission-fields stack" disabled={frozen}>
        <div className="segmented" role="group" aria-label="添加项目方式">
          <button type="button" className="segmented-option" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>新建项目</button>
          <button type="button" className="segmented-option" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>添加已有目录</button>
        </div>
        <label className="field">项目名称
          <input value={name} onChange={event => setName(event.target.value)} required maxLength={120} autoFocus placeholder="例如：我的产品" />
        </label>
        <label className="field">项目路径
          <input value={mode === 'create' ? directory : cwd} onChange={event => mode === 'create' ? setDirectory(event.target.value) : setCwd(event.target.value)}
            required={mode === 'existing'} placeholder={mode === 'create' ? suggestedDirectory || 'my-project 或 /srv/my-project' : 'existing-project 或 /srv/existing-project'}
            maxLength={4096} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <p className="small muted"><strong>{absolute ? '绝对路径' : '相对路径'}</strong>：以 / 开头时使用服务器绝对位置，否则相对于默认项目根目录；支持多层路径、./ 和 ../。{windows && '此 Windows 开发环境也识别盘符绝对路径。'}</p>
        {mode === 'create' && !directory && suggestedDirectory && <p className="small muted">未填写路径时使用：<code>{suggestedDirectory}</code>（相对路径）。</p>}
        {identity?.mode === 'root' && <p className="small muted">{executionModeConfirmed ? '当前为 ROOT 执行身份。' : '上次确认的执行身份为 ROOT。'}路径规则相同，操作权限由服务器实际执行账号决定。</p>}
        {defaults.loading && <p className="small muted" role="status">正在读取默认项目目录…</p>}
        {!defaults.loading && !defaultsIssue && <>
          <p className="small muted">默认项目根目录：<code>{root}</code></p>
          {rawPath && !pathIssue && <p className="small muted">{mode === 'create' ? '创建位置' : '添加位置'}：<code>{preview}</code></p>}
        </>}
        <p className="small muted">{mode === 'create'
          ? '父目录必须已存在（默认项目根目录可由系统准备）；不会创建缺失的中间目录，也不会覆盖已有目录。'
          : '只添加已存在的目录，不创建目录，也不会自动修改已有目录的所有权和权限。'}</p>
        {pathIssue && <p role="alert" className="error">{pathIssue}</p>}
        {defaultsIssue && <div role="alert" className="error">{defaultsIssue}<button type="button" className="button small" disabled={!enabled || defaults.loading} onClick={defaults.refresh}>重试读取目录</button></div>}
      </fieldset>
      {action.error && <p role="alert" className="error">{action.error}</p>}
      {reconciliation && <p role="alert" className="error">{reconciliation}</p>}
      {action.notice && <p className="small muted" role="status">{action.notice}</p>}
      <button className="button primary" type="submit" disabled={action.disabled || Boolean(reconciliation) || !ready}>
        {action.busy ? '正在添加…' : mode === 'create' ? '创建项目' : '添加项目'}
      </button>
    </form>
  </Dialog>;
}
