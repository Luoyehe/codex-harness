import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { composing } from '../lib/types';
import { useWorkflow } from '../hooks/useWorkflow';
import { Dialog } from './Dialog';
export function ProjectDialog({ api, onClose, onAdded }: { api: Api; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState(''), [cwd, setCwd] = useState(''), running = useRef(false);
  const action = useWorkflow(api, '', true, onAdded);
  const frozen = action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const close = () => { if (!running.current) onClose(); };
  const submit = async () => {
    if (running.current || action.disabled || !name.trim() || !cwd.trim()) return;
    running.current = true;
    try { if (await action.run('project/add', { name: name.trim(), path: cwd.trim() })) onClose(); }
    finally { running.current = false; }
  };
  return <Dialog title="添加本地项目" onClose={close}><form className="stack" onKeyDown={e => { if (e.key === 'Enter' && composing(e)) e.preventDefault(); }} onSubmit={e => { e.preventDefault(); void submit(); }}><p className="muted">选择工作目录。项目用于组织会话，不构成安全隔离边界。</p><fieldset className="submission-fields stack" disabled={frozen}><label className="field">项目名称<input value={name} onChange={e => setName(e.target.value)} required maxLength={120} autoFocus placeholder="例如：我的产品"/></label><label className="field">服务器上的绝对目录<input value={cwd} onChange={e => setCwd(e.target.value)} required placeholder="/workspace/project"/></label></fieldset>{action.error && <p role="alert" className="error">{action.error}</p>}{action.notice && <p className="small muted" role="status">{action.notice}</p>}<button className="button primary" type="submit" disabled={action.disabled || !name.trim() || !cwd.trim()}>{action.busy ? '正在添加…' : '添加项目'}</button></form></Dialog>;
}
