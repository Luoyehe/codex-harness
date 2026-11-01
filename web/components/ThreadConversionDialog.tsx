import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { object, type Model } from '../lib/types';
import { Dialog } from './Dialog';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';
import { effortName, modelSelection } from './ModelPicker';

export function ThreadConversionDialog({ api, threadId, sourceProvider, epoch, models, loading, more,
  onMore, enabled, onBusy, onCreated, onClose }: {
  api: Api; threadId: string; sourceProvider: string; epoch: string; models: Model[]; loading: boolean;
  more?: boolean; onMore: () => void; enabled: boolean; onBusy: (busy: boolean) => void;
  onCreated: (id: string) => void; onClose: () => void;
}) {
  const [choice, setChoice] = useState(''), [effort, setEffort] = useState(''), [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState('');
  const heading = useRef<HTMLParagraphElement>(null), opened = useRef('');
  const candidates = models.filter(row => Boolean(row.modelProvider));
  const selected = candidates.find(row => modelSelection(row) === choice);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const valid = Boolean(selected && (!effort || efforts.some(row => row.reasoningEffort === effort)));
  const scope = JSON.stringify([threadId, sourceProvider, epoch]);
  const action = useExtensionAction(api, enabled && Boolean(sourceProvider), () => {}, scope);
  const unresolved = action.operation && ['pending', 'unknown'].includes(action.operation.state);
  const created = (id: unknown) => {
    if (!action.isCurrent() || typeof id !== 'string' || !id || id === threadId) {
      setError('转换操作已受理，但新会话标识尚未确认，请查询原操作回执。');
      return;
    }
    if (opened.current === id) return;
    opened.current = id;
    onCreated(id);
  };
  useEffect(() => {
    if (step === 2) heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (action.operation?.state === 'accepted' && action.operation.resolvedThreadId)
      created(action.operation.resolvedThreadId);
  }, [action.operation?.id, action.operation?.state, action.operation?.resolvedThreadId]);
  const submit = async () => {
    if (action.disabled || loading || !valid || !selected || step !== 2) return;
    setError('');
    onBusy(true);
    try {
      const result = await action.run('thread/convert', { threadId, sourceProvider,
        targetProvider: selected.modelProvider!, model: selected.model ?? selected.id,
        ...(effort ? { effort } : {}), confirm: true }, '转换会话已创建，正在读取新会话。');
      if (result && action.isCurrent()) created(object(result.thread).id);
    } finally { onBusy(false); }
  };
  return <Dialog title="切换供应商 / 转换会话" onClose={onClose}>
    <section className="stack">
      <p ref={heading} tabIndex={-1} aria-live="polite"><strong>第 {step}/2 步：{step === 1 ? '选择新会话的模型' : '确认创建转换会话'}</strong></p>
      <p>转换会创建同一项目下带供应商备注的新会话，原会话保持不变。当前草稿不会作为消息发送。</p>
      {step === 1 ? <>
        <label className="field">目标模型<select value={choice} disabled={action.busy || Boolean(unresolved) || loading}
          onChange={event => { setChoice(event.target.value); setEffort(''); setError(''); }}>
          <option value="">请选择供应商和模型</option>
          {choice && !selected && <option value={choice} disabled>之前选择的模型已不可用</option>}
          {[...new Set(candidates.map(row => row.modelProvider!))].map(provider => <optgroup key={provider}
            label={candidates.find(row => row.modelProvider === provider)?.providerName ?? provider}>
            {candidates.filter(row => row.modelProvider === provider).map(row => <option key={modelSelection(row)} value={modelSelection(row)}>{row.displayName ?? row.model ?? row.id}</option>)}
          </optgroup>)}
        </select></label>
        <label className="field">新会话思考强度<select value={effort} disabled={action.busy || Boolean(unresolved) || loading || !selected || !efforts.length}
          onChange={event => setEffort(event.target.value)}>
          <option value="">模型默认</option>
          {efforts.map(row => <option key={row.reasoningEffort} value={row.reasoningEffort}>{effortName(row.reasoningEffort)}</option>)}
        </select></label>
        <p className="small muted">当前供应商存在旧格式兼容问题时，也可选择它创建兼容会话；普通同供应商换模型直接使用输入框的模型菜单。原会话的历史和设置不会被转换。</p>
        {more && <button className="button small" disabled={loading || action.busy} onClick={onMore}>加载更多模型</button>}
      </> : <>
        <p>新会话将使用 {selected?.providerName ?? selected?.modelProvider ?? '待重新选择的供应商'} / {selected?.displayName ?? selected?.model ?? selected?.id ?? '模型已不可用'}。</p>
        <p>新会话的供应商专用推理上下文会转换，正文和工具记录保留。目标供应商仍可能不接受全部上下文；转换也可能失败。长历史需要等待，请勿重复提交。</p>
        <p>这不会撤销已经发生的命令、文件修改或外部操作。转换完成后打开新会话；你仍可回到原会话。</p>
      </>}
      {!enabled && <p role="status">原会话必须已加载且空闲。若原供应商已停用或删除，请先恢复其配置并加载会话；转换不会替你加载或继续任务。</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原转换操作回执" />
      <div className="inline wrap">
        <button className="button" onClick={onClose}>{action.busy || unresolved ? '关闭（保留操作记录）' : '取消'}</button>
        {step === 2 && <button className="button" disabled={action.busy || Boolean(unresolved)} onClick={() => setStep(1)}>返回选择</button>}
        <button key={step} className="button primary" disabled={action.disabled || loading || !valid}
          onKeyDown={event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); }}
          onClick={event => {
            if (event.detail > 1 || action.disabled || loading || !valid) return;
            if (step === 1) setStep(2); else void submit();
          }}>{step === 1 ? '继续（1/2）' : action.busy ? '正在创建转换会话…' : '创建转换会话（2/2）'}</button>
      </div>
    </section>
  </Dialog>;
}
