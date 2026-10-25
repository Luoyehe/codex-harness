import { useCallback, useEffect, useRef, useState } from 'react';
import type { PermissionProfileSummary } from '../../protocol/ts/v2/PermissionProfileSummary';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { array, object, type Model } from '../lib/types';
import { usePaged } from '../hooks/usePaged';
import { useResource } from '../hooks/useResource';
import { Dialog } from './Dialog';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

type CatalogModel = Model & { serviceTiers?: { id: string; name: string; description: string }[] };
type Changes = { model: string; effort: string; summary: string; serviceTier: string; approvalsReviewer: string; approvalPolicy: string; permissions: string };
const empty = (): Changes => ({ model: '', effort: '', summary: '', serviceTier: '', approvalsReviewer: '', approvalPolicy: '', permissions: '' });
const text = (value: unknown) => typeof value === 'string' ? value : '未提供';
const reviewers = [['user', '由我审阅'], ['auto_review', '自动风险审阅'], ['guardian_subagent', 'Guardian 审阅']];

export function ThreadExecutionSettings({ api, events, threadId, projectId, epoch, enabled, activeTurnId = '', models, moreModels, modelsLoading, onMoreModels, onChanged, onClose }: {
  api: Api; events: Events; threadId: string; projectId: string; epoch: string; enabled: boolean; activeTurnId?: string; models: CatalogModel[]; moreModels: boolean; modelsLoading: boolean; onMoreModels: () => void; onChanged: () => void; onClose: () => void;
}) {
  const [scope, setScope] = useState<'thread' | 'turn'>('thread'), [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => events.subscribe(event => {
    if (event.type === 'notification' && object(event.data.params).threadId === threadId && ['thread/settings/updated', 'thread/closed', 'thread/status/changed'].includes(String(event.data.method))) refresh();
  }), [events, threadId, refresh]);
  const key = `${epoch}:${threadId}:${revision}`;
  const session = useResource(key, async signal => {
    const value = await api.call('thread/session', { threadId }, signal);
    if (value.requiresResume === true) return value;
    if (value.requiresResume !== false || object(value.thread).id !== threadId || typeof value.model !== 'string') throw new Error('会话设置身份不匹配，请重新读取。');
    return value;
  });
  const profiles = usePaged<PermissionProfileSummary>(api, 'permissionProfile/list', { projectId }, `${epoch}:${projectId}:profiles`, Boolean(projectId));
  const capabilities = useResource(epoch, async signal => {
    const value = await api.call('modelProvider/capabilities/read', {}, signal);
    if (typeof value.imageGeneration !== 'boolean' || typeof value.webSearch !== 'boolean') throw new Error('提供方能力响应无效。');
    return value as { imageGeneration: boolean; webSearch: boolean };
  });
  const snapshot = session.data;
  const changed = useCallback(() => { refresh(); onChanged(); }, [refresh, onChanged]);
  return <Dialog title="会话与回合设置" wide onClose={onClose}><div className="stack">
    <p className="muted">只修改明确选择的字段。这里保存的会话设置与输入框中的下一次发送选项相互独立；输入框的显式选项仍可覆盖会话设置。</p>
    <div className="section-heading"><h3>当前会话快照</h3><button className="button small" onClick={() => { refresh(); profiles.refresh(); capabilities.refresh(); }}>重新读取设置</button></div><ReadState {...session}/>
    {snapshot?.requiresResume === true && <p className="workspace-warning">此会话尚未加载。关闭本窗口，先明确选择“加载并继续”才能修改设置；读取设置不会自动加载任务。</p>}
    {snapshot?.requiresResume === false && <dl className="execution-snapshot"><dt>模型 / 提供方</dt><dd>{text(snapshot.model)} / {text(snapshot.modelProvider)}</dd><dt>推理强度 / 服务档位</dt><dd>{text(snapshot.reasoningEffort)} / {snapshot.serviceTier === null ? '默认档位' : text(snapshot.serviceTier)}</dd><dt>审批 / 审阅方</dt><dd>{typeof snapshot.approvalPolicy === 'string' ? snapshot.approvalPolicy : '细分审批规则'} / {text(snapshot.approvalsReviewer)}</dd><dt>权限档案 / 沙箱</dt><dd>{text(object(snapshot.activePermissionProfile).id)} / {text(object(snapshot.sandbox).type)}</dd></dl>}
    <ReadState {...capabilities}/>{capabilities.data && <p className="small muted">当前模型提供方报告：网页搜索{capabilities.data.webSearch ? '可用' : '不可用'}；图像生成{capabilities.data.imageGeneration ? '可用' : '不可用'}。这不是特定模型或账户额度保证。</p>}
    <nav className="extension-tabs" aria-label="设置作用范围"><button className={`button small ${scope === 'thread' ? 'selected' : ''}`} aria-pressed={scope === 'thread'} onClick={() => setScope('thread')}>会话的后续执行</button><button className={`button small ${scope === 'turn' ? 'selected' : ''}`} aria-pressed={scope === 'turn'} onClick={() => setScope('turn')}>仅当前回合</button></nav>
    {scope === 'turn' && !activeTurnId ? <p className="muted">当前没有正在运行的回合。</p> : <ExecutionForm key={`${epoch}:${threadId}:${scope}:${scope === 'turn' ? activeTurnId : ''}`} api={api} threadId={threadId} turnId={scope === 'turn' ? activeTurnId : ''} models={models} moreModels={moreModels} modelsLoading={modelsLoading} onMoreModels={onMoreModels} baseModel={typeof snapshot?.model === 'string' ? snapshot.model : ''} profiles={profiles.items} profilesLoading={profiles.loading} profilesError={profiles.error} profilesMore={profiles.hasMore} onMoreProfiles={() => void profiles.more()} enabled={enabled && snapshot?.requiresResume === false && !session.loading && !session.error} onChanged={changed}/>}
  </div></Dialog>;
}

function ExecutionForm({ api, threadId, turnId, models, moreModels, modelsLoading, onMoreModels, baseModel, profiles, profilesLoading, profilesError, profilesMore, onMoreProfiles, enabled, onChanged }: {
  api: Api; threadId: string; turnId: string; models: CatalogModel[]; moreModels: boolean; modelsLoading: boolean; onMoreModels: () => void; baseModel: string; profiles: PermissionProfileSummary[]; profilesLoading: boolean; profilesError: string; profilesMore: boolean; onMoreProfiles: () => void; enabled: boolean; onChanged: () => void;
}) {
  const [changes, setChanges] = useState(empty), [confirmed, setConfirmed] = useState(false), [result, setResult] = useState('');
  const submitting = useRef(false);
  const action = useExtensionAction(api, enabled, onChanged);
  const model = models.find(row => (row.model ?? row.id) === (changes.model || baseModel));
  const efforts = array<{ reasoningEffort: string; description?: string }>(model?.supportedReasoningEfforts);
  const tiers = array<{ id: string; name: string; description: string }>(model?.serviceTiers);
  const profile = profiles.find(row => row.id === changes.permissions && row.allowed === true);
  const valid = (!changes.model || models.some(row => (row.model ?? row.id) === changes.model)) && (!changes.effort || efforts.some(row => row.reasoningEffort === changes.effort)) && (!changes.serviceTier || changes.serviceTier === '__clear__' || tiers.some(row => row.id === changes.serviceTier)) && (!changes.permissions || Boolean(profile) && !profilesLoading && !profilesError);
  const selected = Object.values(changes).some(Boolean);
  const change = (field: keyof Changes, value: string) => { setConfirmed(false); setResult(''); setChanges(previous => ({ ...previous, [field]: value, ...(field === 'model' ? { effort: '', serviceTier: '' } : {}) })); };
  const apply = async () => {
    if (submitting.current || !selected || !valid || !confirmed || action.disabled) return;
    submitting.current = true;
    const params: Record<string, unknown> = { threadId, ...(turnId ? { turnId } : {}) };
    for (const [field, value] of Object.entries(changes)) if (value) params[field] = field === 'serviceTier' && value === '__clear__' ? null : value;
    try {
      setResult(''); setConfirmed(false); const response = await action.run(turnId ? 'turn/settings/update' : 'thread/settings/update', params, '设置请求已受理。会话快照会在原生设置通知到达后更新。');
      if (response !== undefined) { setChanges(empty()); setConfirmed(false); setResult(turnId ? response.status === 'applied' ? '当前回合设置已应用；不改变后续回合的会话设置。' : response.status === 'targetUnavailable' ? '目标回合已结束或不可用，未应用到其他回合。' : '原操作已受理；没有取得当前回合的应用状态，不会自动重发。' : '会话设置已受理，正在读取原生快照。'); }
    } finally { submitting.current = false; }
  };
  return <section className="stack"><h3>{turnId ? '仅修改当前回合' : '修改会话的后续执行设置'}</h3><p className="small muted">{turnId ? `目标回合：${turnId}。已开始的模型步骤、既有审批和子 Agent 可能继续使用原设置；此操作不会改成下一个回合。` : '保存会话默认值，已开始的步骤和当前回合不会被追溯改写。修改当前回合请切换作用范围。'}</p>
    <fieldset disabled={action.busy} className="submission-fields stack">
    <div className="settings-grid"><label className="field">模型<select value={changes.model} onChange={event => change('model', event.target.value)}><option value="">保持不变</option>{models.map(row => <option key={row.id} value={row.model ?? row.id}>{row.displayName ?? row.model ?? row.id}</option>)}</select></label><label className="field">推理强度<select value={changes.effort} disabled={!model} onChange={event => change('effort', event.target.value)}><option value="">保持不变</option>{efforts.map(row => <option key={row.reasoningEffort} value={row.reasoningEffort}>{row.reasoningEffort}{row.description ? ` · ${row.description}` : ''}</option>)}</select></label><label className="field">推理摘要<select value={changes.summary} onChange={event => change('summary', event.target.value)}><option value="">保持不变</option><option value="auto">自动</option><option value="concise">简洁</option><option value="detailed">详细</option><option value="none">不显示</option></select></label><label className="field">服务档位<select value={changes.serviceTier} onChange={event => change('serviceTier', event.target.value)}><option value="">保持不变</option><option value="__clear__">清除覆盖，使用默认档位</option>{tiers.map(row => <option key={row.id} value={row.id}>{row.name} · {row.description}</option>)}</select></label><label className="field">审批审阅方<select value={changes.approvalsReviewer} onChange={event => change('approvalsReviewer', event.target.value)}><option value="">保持不变</option>{reviewers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      {!turnId && <><label className="field">审批策略<select value={changes.approvalPolicy} onChange={event => change('approvalPolicy', event.target.value)}><option value="">保持不变</option><option value="untrusted">不受信任的操作请求审批</option><option value="on-request">按模型请求审批</option><option value="never">不请求审批</option></select></label><label className="field">命名权限档案<select value={changes.permissions} disabled={profilesLoading || Boolean(profilesError)} onChange={event => change('permissions', event.target.value)}><option value="">保持不变</option>{profiles.map(row => <option key={row.id} value={row.id} disabled={!row.allowed}>{row.id}{row.allowed ? '' : ' · 不允许'}{row.description ? ` · ${row.description}` : ''}</option>)}</select></label></>}
    </div>{moreModels && <button className="button small" disabled={modelsLoading} onClick={onMoreModels}>加载更多模型</button>}{!turnId && <><ReadState loading={profilesLoading} error={profilesError}/>{profilesMore && <button className="button small" disabled={profilesLoading} onClick={onMoreProfiles}>加载更多权限档案</button>}{profile?.description && <p className="workspace-warning">所选权限档案：{profile.description}</p>}</>}
    {(changes.approvalsReviewer && changes.approvalsReviewer !== 'user' || changes.approvalPolicy === 'never') && <p className="workspace-warning">所选设置可能让操作由自动审阅方处理或不再向你请求审批；沙箱和权限规则仍由原生服务执行。</p>}
    {!valid && <p className="error" role="alert">所选设置已不在当前目录中，请重新选择。</p>}
    <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>确认将以上明确选择的字段应用到{turnId ? '这个正在运行的回合' : '此会话的后续执行'}</label>
    <ExtensionStatus api={api} action={action} recoveryLabel="查询原设置操作回执"/>{result && <p role="status">{result}</p>}
    <button className="button primary" disabled={action.disabled || !valid || !selected || !confirmed} onClick={() => void apply()}>{action.busy ? '正在提交…' : turnId ? '应用到当前回合' : '保存会话设置'}</button>
    </fieldset>
  </section>;
}
