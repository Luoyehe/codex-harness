import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { executionMode, type ExecutionIdentity } from '../lib/execution-mode';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';

export function RootExecutionNotice({ identity, confirmed, onSettings }: {
  identity?: ExecutionIdentity; confirmed: boolean; onSettings: () => void;
}) {
  if (identity?.mode !== 'root') return null;
  return <aside className="workspace-warning root-execution-notice" role="status" aria-label="ROOT 执行权限">
    <strong>{confirmed ? 'ROOT 执行模式已启用' : 'ROOT 执行身份待重新确认'}</strong>
    <span>Agent 和终端具有整机 root 权限，可修改系统、服务及 Harness 自身。对话的沙箱和审批设置不改变执行账号。</span>
    {!confirmed && <span>连接恢复前保留 ROOT 提示；不能据此认定已经切回普通账号。</span>}
    <button className="button small" onClick={onSettings}>查看执行权限</button>
  </aside>;
}

export function ExecutionModeSettings({ api, value, loading, enabled, onRefresh }: {
  api: Api; value: unknown; loading: boolean; enabled: boolean; onRefresh: () => void;
}) {
  const current = executionMode(value);
  const [choice, setChoice] = useState<{ mode: 'native' | 'root'; revision: string }>();
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [current?.revision]);
  // A switch restarts the runtime. Its receipt belongs to the authenticated browser,
  // not to the runtime epoch which the switch itself replaces.
  const action = useExtensionAction(api, enabled && !loading && Boolean(current), onRefresh, api.csrf ?? '');
  const recovered = useRef('');
  useEffect(() => {
    if (action.operation?.state === 'accepted' && recovered.current !== action.operation.id) {
      recovered.current = action.operation.id;
      setChoice(undefined);
      setConfirmed(false);
    }
  }, [action.operation?.id, action.operation?.state]);
  const selected = choice?.mode ?? current?.mode;
  const conflict = Boolean(choice && current && choice.revision !== current.revision);
  const changing = Boolean(choice && current && choice.mode !== current.mode);
  const frozen = action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const apply = async () => {
    if (action.disabled || !current || !choice || conflict || !changing || !confirmed || (choice.mode === 'root' && !current.rootAllowed)) return;
    setConfirmed(false);
    const result = await action.run('system/execution-mode/write', {
      mode: choice.mode, expectedRevision: choice.revision, confirmRestart: true, confirmRoot: choice.mode === 'root',
    }, '执行权限切换已受理，正在重新读取状态。请以重新连接后的实际执行身份为准。');
    if (result) setChoice(undefined);
  };
  return <section className="info-card stack" aria-label="执行权限">
    <h3>执行权限</h3>
    {current ? <p>当前配置：<strong>{current.mode === 'root' ? 'ROOT 执行' : '普通账号执行'}</strong>（UID {current.effectiveUid}）。切换后的实际身份由重新连接的后台确认。</p>
      : <p className="muted">{loading ? '正在读取执行权限…' : '执行身份尚未确认，请刷新服务状态。'}</p>}
    {current && <p>服务器 ROOT 授权：{current.rootAllowed ? '已允许，仍须在此明确选择和确认后才会启用。' : '未允许。请在服务器运行一站式运维脚本，先授权 ROOT 执行。'}</p>}
    <p>默认使用普通账号。ROOT 模式让 Agent、项目文件操作和终端以 root 身份执行，可访问 /root 并修改整机，包括 Harness 控制面、账号和凭据。</p>
    <p className="small muted">这是服务器执行身份，与模型、对话沙箱和审批策略分别管理。切回普通账号不会撤销已完成的系统修改，也不会自动修复 root 创建文件的权限。</p>
    <p className="small muted">两种模式分别保留 Codex 登录和会话历史；首次进入 ROOT 模式需单独登录 ChatGPT，不复制普通模式的登录凭据。模型供应商配置共享，自动化任务会使用当前执行模式。</p>
    {!enabled && <p className="workspace-warning">请先结束任务、终端和其他活动，并等待后台状态确认，再切换执行权限。</p>}
    <fieldset className="submission-fields stack" disabled={frozen || !current || loading || !enabled}>
      <div className="segmented" role="group" aria-label="选择执行权限">
        <button type="button" className="segmented-option" aria-pressed={selected === 'native'} onClick={() => {
          if (current) setChoice({ mode: 'native', revision: current.revision });
          setConfirmed(false);
        }}>普通账号</button>
        <button type="button" className="segmented-option" aria-pressed={selected === 'root'} disabled={!current?.rootAllowed} onClick={() => {
          if (current) setChoice({ mode: 'root', revision: current.revision });
          setConfirmed(false);
        }}>ROOT 模式</button>
      </div>
      {conflict && <div className="workspace-warning" role="alert">
        执行权限已被其他操作更改。请先核对最新状态，再重新选择和确认。
        <button type="button" className="button small" onClick={() => { setChoice(undefined); setConfirmed(false); }}>使用最新状态重新选择</button>
      </div>}
      {changing && !conflict && <label className="check-row">
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        {selected === 'root' ? '我确认授予 Agent 和终端整机 root 权限（包括 Harness 自身），并允许重启实例服务' : '我确认切回普通账号并重启实例服务；这不会撤销已完成的系统修改'}
      </label>}
      <button type="button" className={`button ${selected === 'root' ? 'danger' : 'primary'}`}
        disabled={action.disabled || !changing || conflict || !confirmed} onClick={() => void apply()}>
        {action.busy ? '正在切换…' : selected === 'root' ? '应用 ROOT 执行模式' : '应用普通执行模式'}
      </button>
    </fieldset>
    <ExtensionStatus api={api} action={action} recoveryLabel="查询原执行权限切换回执" />
  </section>;
}
