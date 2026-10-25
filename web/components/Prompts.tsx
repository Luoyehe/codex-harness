import { useRef, useState } from 'react';
import { array, composing, message, object, safeUrl, type Item, type PromptRecord, type Turn } from '../lib/types';
import { schemaSupported, validateValue } from '../lib/prompt-validation';
import { SchemaField } from './PromptFields';
import { ownField, withField } from '../lib/form-values';
const labels: Record<string, string> = { accept: '允许这一次', acceptForSession: '允许本次会话', decline: '拒绝', cancel: '取消', acceptWithExecpolicyAmendment: '允许并保存命令规则', applyNetworkPolicyAmendment: '应用网络规则' };
type QuestionSelection = { kind: 'none' } | { kind: 'option'; index: number } | { kind: 'other' };
type QuestionDraft = { selection: QuestionSelection; text: string; otherText: string };
const emptyDraft = (): QuestionDraft => ({ selection: { kind: 'none' }, text: '', otherText: '' });

function UserInputForm({ questions, busy, onSubmit, onError }: { questions: Record<string, unknown>[]; busy: boolean; onSubmit: (response: unknown) => Promise<void>; onError: (error: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const updateDraft = (id: string, change: Partial<QuestionDraft>) => setDrafts(current => withField(current, id, { ...(ownField(current, id) ?? emptyDraft()), ...change }));
  return <form onSubmit={event => {
    event.preventDefault();
    const entries: [string, { answers: string[] }][] = [];
    for (const question of questions) {
      const id = String(question.id), draft = ownField(drafts, id) ?? emptyDraft();
      const options = array<unknown>(question.options).map(object);
      const selection = draft.selection;
      const answer = !options.length ? draft.text
        : selection.kind === 'option' && options[selection.index] ? String(options[selection.index]!.label)
        : selection.kind === 'other' && question.isOther === true ? draft.otherText : undefined;
      if (answer === undefined || answer.length === 0) { onError('请完成所有问题。'); return; }
      entries.push([id, { answers: [answer] }]);
    }
    void onSubmit({ answers: Object.fromEntries(entries) });
  }} onKeyDown={event => { if (event.key === 'Enter' && composing(event)) event.preventDefault(); }}>
    {questions.map(question => {
      const id = String(question.id), options = array<unknown>(question.options).map(object);
      const draft = ownField(drafts, id) ?? emptyDraft(), label = String(question.header ?? question.question);
      const selectedValue = draft.selection.kind === 'option' ? String(draft.selection.index) : draft.selection.kind === 'other' ? 'other' : '';
      return <fieldset key={id}>
        <legend>{String(question.header ?? '')} · {String(question.question)}</legend>
        {options.length > 0 ? <>
          <label className="field">{label}<select value={selectedValue} onChange={event => {
            const value = event.target.value;
            updateDraft(id, { selection: value === '' ? { kind: 'none' } : value === 'other' ? { kind: 'other' } : { kind: 'option', index: Number(value) } });
          }}><option value="">请选择</option>{options.map((option, index) => <option key={index} value={index}>{String(option.label)} — {String(option.description ?? '')}</option>)}{question.isOther === true && <option value="other">其他</option>}</select></label>
          {question.isOther === true && draft.selection.kind === 'other' && <label className="field">{label}：其他答案<input type={question.isSecret ? 'password' : 'text'} autoComplete="off" value={draft.otherText} onChange={event => updateDraft(id, { otherText: event.target.value })}/></label>}
        </> : <label className="field">{label}：答案<input type={question.isSecret ? 'password' : 'text'} autoComplete="off" value={draft.text} onChange={event => updateDraft(id, { text: event.target.value })}/></label>}
      </fieldset>;
    })}
    <button className="button primary" disabled={busy} type="submit">提交回答</button>
  </form>;
}

function Prompt({ prompt, onAnswer, previewItem, onRefresh }: { prompt: PromptRecord; onAnswer: (id: string, response: unknown) => Promise<void>; previewItem?: Item; onRefresh?: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sending = useRef(false);
  const [content, setContent] = useState<Record<string, unknown>>({}), [scope, setScope] = useState('turn'), [confirmed, setConfirmed] = useState(false);
  const p = prompt.params, method = prompt.method;
  const send = async (response: unknown) => { if (sending.current) return; sending.current = true; setBusy(true); setError(''); try { await onAnswer(prompt.promptId, response); } catch (e) { setError(message(e)); } finally { sending.current = false; setBusy(false); } };
  const approval = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
  const fileApproval = method === 'item/fileChange/requestApproval', changes = array<unknown>(previewItem?.changes).map(object);
  const filePreviewReady = previewItem?.type === 'fileChange' && changes.length > 0 && changes.every(c => typeof c.path === 'string' && c.path.length > 0 && typeof c.diff === 'string' && ['add', 'delete', 'update'].includes(String(object(c.kind).type)));
  const questions = array<unknown>(p.questions).map(object);
  const elicitation = method === 'mcpServer/elicitation/request', schema = object(p.requestedSchema);
  const urlMode = p.mode === 'url';
  const supported = (p.mode === 'form' || p.mode === undefined) && schemaSupported(schema) && schema.type === 'object';
  const permissions = object(p.permissions);
  return <section className="approval-card" aria-label="等待你的决定"><header><span className="eyebrow">需要你的决定</span><strong>{p.networkApprovalContext ? '网络访问审批' : approval ? '操作批准' : method === 'item/tool/requestUserInput' ? '补充信息' : elicitation ? 'MCP 请求' : '权限请求'}</strong></header>{p.reason ? <p>{String(p.reason)}</p> : null}{p.message ? <p>{String(p.message)}</p> : null}
    {approval && <div className="approval-preview">{typeof p.command === 'string' && <pre className="raw">{p.command}</pre>}{typeof p.cwd === 'string' && <p className="path small">工作目录：{p.cwd}</p>}{p.networkApprovalContext ? <pre className="raw">{JSON.stringify(p.networkApprovalContext, null, 2)}</pre> : null}{p.additionalPermissions ? <pre className="raw">{JSON.stringify(p.additionalPermissions, null, 2)}</pre> : null}{typeof p.grantRoot === 'string' && <p className="path">请求写入路径：{p.grantRoot}</p>}{array<unknown>(previewItem?.changes).map((change, i) => <div key={i}><p className="path">{String(object(change).path ?? '文件修改')}</p><details><summary>查看修改内容</summary><pre className="raw">{String(object(change).diff ?? JSON.stringify(change, null, 2))}</pre></details></div>)}</div>}
    <details><summary>查看请求详情</summary><pre className="raw">{JSON.stringify(p, null, 2)}</pre></details>
    {error && <p role="alert" className="error">{error}</p>}
    <fieldset className="submission-fields" disabled={busy}>
    {fileApproval && typeof p.grantRoot === 'string' && <p className="small">此请求还申请在本次会话中写入该目录：{p.grantRoot}。目录授权范围不能替代具体文件变更的核对。</p>}
    {fileApproval && !filePreviewReady && <div className="stack"><p role="status">尚未取得此回合的完整文件变更内容，暂不能允许。请重新同步；如果读取失败，可拒绝或取消。</p>{onRefresh && <button className="button small" onClick={onRefresh}>重新同步变更</button>}</div>}
    {fileApproval && filePreviewReady && <p className="small">{changes.map(c => `${String(c.path)}（${String(object(c.kind).type)}${object(c.kind).move_path ? ` → ${String(object(c.kind).move_path)}` : ''}${c.diff === '' ? '，内容为空' : ''}）`).join('；')}</p>}
    {approval && <div className="stack">{array<unknown>(p.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel']).map((decision, i) => <div key={i}>{typeof decision === 'object' && <pre className="raw">{JSON.stringify(decision, null, 2)}</pre>}<button disabled={busy || (fileApproval && !filePreviewReady && !['decline', 'cancel'].includes(String(decision)))} className="button" onClick={() => void send({ decision })}>{ownField(labels, typeof decision === 'string' ? decision : Object.keys(object(decision))[0] ?? '') ?? '确认此决定'}</button></div>)}</div>}
    {method === 'item/tool/requestUserInput' && <UserInputForm questions={questions} busy={busy} onSubmit={send} onError={setError}/>}
    {method === 'item/permissions/requestApproval' && <div className="stack">{Object.entries(permissions).map(([key, value]) => <label className="check-row" key={key}><input type="checkbox" checked={Object.hasOwn(content, key)} onChange={e => setContent(current => withField(current, key, e.target.checked ? value : undefined))}/><span>{key}<pre className="raw">{JSON.stringify(value, null, 2)}</pre></span></label>)}<label className="field">有效范围<select value={scope} onChange={e => setScope(e.target.value)}><option value="turn">当前回合</option><option value="session">当前会话</option></select></label><div className="inline"><button className="button primary" disabled={busy} onClick={() => void send({ permissions: content, scope })}>授予所选权限</button><button className="button" disabled={busy} onClick={() => void send({ permissions: {}, scope: 'turn' })}>拒绝</button></div></div>}
    {elicitation && <div className="stack">{urlMode ? <><p>请打开授权页面，完成后明确确认。</p>{safeUrl(p.url) ? <a className="button" href={safeUrl(p.url)} target="_blank" rel="noreferrer">打开授权页面 ↗</a> : <p role="alert">授权网址无效。</p>}<label className="check-row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>我已完成授权</label></> : supported ? Object.entries(object(schema.properties)).map(([key, s]) => <SchemaField key={key} name={key} schema={s} required={array(schema.required).includes(key)} value={ownField(content, key)} onChange={v => setContent(current => withField(current, key, v))}/>) : <p className="error">此请求包含尚不支持的表单扩展，不能接受。</p>}<div className="inline"><button className="button primary" disabled={busy || (urlMode ? !confirmed || !safeUrl(p.url) : !supported)} onClick={() => { const errors = urlMode ? [] : validateValue(schema, content); if (errors.length) { setError(errors.join(' ')); return; } void send({ action: 'accept', content: urlMode ? null : content, _meta: null }); }}>确认</button><button className="button" disabled={busy} onClick={() => void send({ action: 'decline', content: null, _meta: null })}>拒绝</button><button className="button" disabled={busy} onClick={() => void send({ action: 'cancel', content: null, _meta: null })}>取消</button></div></div>}
    {!approval && !elicitation && !['item/tool/requestUserInput', 'item/permissions/requestApproval'].includes(method) && <p className="error">暂不支持的请求类型：{method}。请在服务状态中检查协议错误。</p>}
    </fieldset>
    {busy && <p role="status">正在提交决定…</p>}
  </section>;
}
export function Prompts({ prompts, onAnswer, contextTurns = [], contextThreadId, onRefresh, compact = false, onOpen }: { prompts: PromptRecord[]; onAnswer: (id: string, response: unknown) => Promise<void>; contextTurns?: Turn[]; contextThreadId?: string; onRefresh?: () => void; compact?: boolean; onOpen?: () => void }) {
  const [collapsed, setCollapsed] = useState(false), hidden = compact || collapsed;
  return <div className={`prompts ${hidden ? "prompts-collapsed" : ""}`}><div className="prompt-strip"><strong role="status">{prompts.length} 项请求等待你的决定</strong><button className="button small" aria-expanded={!hidden} onClick={() => { if (compact) { setCollapsed(false); onOpen?.(); } else setCollapsed(value => !value); }}>{compact ? "处理待答请求" : collapsed ? "展开待答请求" : "收起请求，查看历史"}</button></div><div className="prompt-scroll" hidden={hidden}>{prompts.map(prompt => <Prompt key={`${prompt.epoch}:${prompt.promptId}`} prompt={prompt} onAnswer={onAnswer} onRefresh={onRefresh} previewItem={contextThreadId && contextThreadId === prompt.params.threadId ? contextTurns.find(turn => turn.id === prompt.params.turnId)?.items.find(item => item.id === prompt.params.itemId) : undefined}/>)}</div></div>;
}
