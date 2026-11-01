import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { executionMode, type ExecutionIdentity } from '../lib/execution-mode';
import { object } from '../lib/types';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';

export function RootExecutionNotice({ identity, confirmed, onSettings }: {
  identity?: ExecutionIdentity; confirmed: boolean; onSettings: () => void;
}) {
  if (identity?.mode !== 'root') return null;
  const label = `${confirmed ? 'ROOT 模式已启用' : 'ROOT 执行身份待确认'}，查看执行权限`;
  return <span className="root-execution-notice" role="status" aria-label="ROOT 执行权限">
    <button type="button" title={label} aria-label={label} onClick={onSettings}>
      {confirmed ? 'ROOT' : 'ROOT ?'}
    </button>
  </span>;
}

export function ExecutionModeSettings({ api, value, sharedChatgptAuth, loading, enabled, onRefresh }: {
  api: Api; value: unknown; sharedChatgptAuth?: unknown; loading: boolean; enabled: boolean; onRefresh: () => void;
}) {
  const current = executionMode(value);
  const auth = object(sharedChatgptAuth);
  const sharedAuthReady = auth.shared === true && auth.ready !== false && ['native', 'root'].includes(String(auth.activeMode)) &&
    auth.automaticRestore === false && Array.isArray(auth.archivedLegacyModes) && auth.archivedLegacyModes.length <= 1 &&
    auth.archivedLegacyModes.every(mode => mode === 'native' || mode === 'root');
  const archivedModes = sharedAuthReady ? auth.archivedLegacyModes as ('native' | 'root')[] : [];
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
    <div className="stack" aria-label="实例 ChatGPT 登录">
      <p className="small muted">{loading ? '正在读取实例登录共享状态…' : auth.shared === true && auth.ready === false
        ? 'ChatGPT 登录转交尚未完成。请由服务器管理员恢复执行权限事务后刷新状态；不会自动恢复旧账号。'
        : sharedAuthReady
        ? `本实例共用一份 ChatGPT 登录，当前由${auth.activeMode === 'root' ? 'ROOT 模式' : '普通账号模式'}使用，切换执行模式时一并转交。共享状态不代表已经登录，请在账户设置中确认。`
        : auth.shared === false ? '实例登录共享尚未初始化；执行权限切换时会沿用切换前模式的登录，并保留另一模式原有登录为受限备份。'
        : '实例登录共享状态尚未确认，请刷新服务状态。'}</p>
      {!loading && archivedModes.length > 0 && <p className="small" role="status">
        {archivedModes.map(mode => mode === 'root' ? 'ROOT 模式' : '普通账号模式').join('、')}原有的 ChatGPT 登录已保留为受限备份，不会自动恢复，也不会覆盖当前实例登录。
      </p>}
      <p className="small muted">会话历史仍按执行模式分别保留。模型供应商配置共享，自动化任务会使用当前执行模式。</p>
    </div>
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
