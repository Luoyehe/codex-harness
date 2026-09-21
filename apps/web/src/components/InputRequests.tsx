import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { inputForm, validateInput, validateResponse, type InputForm, type InputRequest } from "../utils/input-forms";

function requestParams(request: InputRequest): Record<string, unknown> {
  return request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params as Record<string, unknown>
    : {};
}

function requestText(value: unknown, max = 256): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function InputRequests() {
  const requests = useStore((state) => state.inputRequests);
  if (!requests?.length) return null;
  return <section className="approval-dock" aria-label="待补充信息">
    <div className="approval-dock-count" role="status">等待输入：{requests.length} 项</div>
    {requests.map((request) => <InputRequestCard key={String(request.requestId)} request={request} />)}
  </section>;
}

export function InputRequestCard({ request }: { request: InputRequest }) {
  const form = useMemo(() => inputForm(request), [request]);
  const params = requestParams(request);
  // A gateway request id identifies a pending response, but a defensive
  // replacement can reuse that id with a corrected schema. Put state behind a
  // normalized-form key so answers (especially secrets) never cross forms.
  const identity = useMemo(() => JSON.stringify([
    request.method,
    requestText(params.threadId),
    requestText(params.turnId),
    request.method === "mcpServer/elicitation/request" ? requestText(params.serverName) : requestText(params.itemId),
    form,
  ]), [form, request]);
  return <InputRequestCardBody key={identity} request={request} form={form} />;
}

function InputRequestCardBody({ request, form }: { request: InputRequest; form: InputForm }) {
  const params = requestParams(request);
  const threadId = requestText(params.threadId) || "未知会话";
  const serverName = requestText(params.serverName) || "未知服务器";
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(form.fields.filter((field) => !field.secret && field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue])));
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const connected = useStore((state) => state.connection === "open");
  const respond = useStore((state) => state.respondInputRequest);
  const serverError = useStore((state) => state.inputRequestErrors?.[String(request.requestId)]);
  useEffect(() => {
    if (serverError) { setSubmitted(false); setError(serverError); }
  }, [serverError]);
  const disabled = submitted || !connected;
  function send(cancel: boolean) {
    const validated = cancel ? {} : validateInput(form, values);
    if (validated.error) { setError(validated.error); return; }
    const payload = request.method === "item/tool/requestUserInput"
      ? { answers: cancel ? {} : Object.fromEntries(Object.entries(validated.content ?? {}).map(([id, value]) => [id, { answers: [String(value)] }])) }
      : { action: cancel ? "cancel" : "accept", content: form.url || cancel ? null : validated.content, _meta: null };
    const responseError = validateResponse(request, payload).error;
    if (responseError) { setError(responseError); return; }
    if (!respond(request.requestId, payload)) { setError("连接不可用，回答未发送；请重连后再试。"); return; }
    setSubmitted(true);
    setValues({}); // Secrets never enter storage, timeline, logs or optimistic echoes.
    setError(null);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!disabled) send(false); }
  function addSecretArrayValue(fieldId: string, value: string, max?: number) {
    if (!value) return;
    setValues((previous) => {
      const current = Array.isArray(previous[fieldId])
        ? (previous[fieldId] as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : [];
      if (current.includes(value) || current.length >= (max ?? 100)) return previous;
      return { ...previous, [fieldId]: [...current, value] };
    });
  }
  function trimSecretArray(fieldId: string, clear: boolean) {
    setValues((previous) => {
      const current = Array.isArray(previous[fieldId]) ? previous[fieldId] as unknown[] : [];
      const next = clear ? [] : current.slice(0, -1);
      const values = { ...previous };
      if (next.length) values[fieldId] = next;
      else delete values[fieldId];
      return values;
    });
  }
  function secretArrayCount(fieldId: string): number {
    const value = values[fieldId];
    return Array.isArray(value) ? value.length : 0;
  }
  function setSecretValue(fieldId: string, value: string | undefined) {
    setValues((previous) => {
      const next = { ...previous };
      if (value) next[fieldId] = value;
      else delete next[fieldId];
      return next;
    });
  }
  return <form className="approval-card input-request-form" onSubmit={submit} autoComplete="off">
      <div className="approval-title">{request.method === "mcpServer/elicitation/request" ? `MCP · ${serverName}` : "Codex 请求输入"}</div>
      <p>{form.message}</p>
      <div className="dim">会话 {threadId} · 回答会发送给上述请求方。取消或超时将结束本次请求。</div>
      {form.error && <p className="error-text" role="alert">{form.error}。未自动批准或取消；你可以取消此请求。</p>}
      {form.url && <p><a href={form.url} target="_blank" rel="noreferrer noopener">打开请求方的交互页面</a>（在该页面完成后，再点击「确认完成」。）</p>}
      {!submitted && form.fields.map((field) => <label className="input-request-field" key={field.id}>
        <span>{field.label}{field.required ? " *" : ""}</span>
        {field.description && <span className="dim">{field.description}</span>}
        {field.type === "array" && field.secret ? <>
          <select className="secret-array-picker" disabled={disabled} value="" onChange={(event) => addSecretArrayValue(field.id, event.target.value, field.max)}>
            <option value="">添加一个选项</option>
            {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <div className="secret-array-status" role="status">
            <span>已选择 {secretArrayCount(field.id)} 项（内容已隐藏）</span>
            <button type="button" className="btn" disabled={disabled || secretArrayCount(field.id) === 0} onClick={() => trimSecretArray(field.id, false)}>撤销最后一项</button>
            <button type="button" className="btn" disabled={disabled || secretArrayCount(field.id) === 0} onClick={() => trimSecretArray(field.id, true)}>清空</button>
          </div>
        </> : field.type === "string" && field.secret && field.options ? <>
          <select className="secret-value-picker" disabled={disabled} value="" onChange={(event) => setSecretValue(field.id, event.target.value || undefined)}>
            <option value="">选择一个选项</option>
            {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <div className="secret-value-status" role="status">
            <span>{typeof values[field.id] === "string" && values[field.id] ? "已选择 1 项（内容已隐藏）" : "尚未选择"}</span>
            <button type="button" className="btn" disabled={disabled || typeof values[field.id] !== "string" || !values[field.id]} onClick={() => setSecretValue(field.id, undefined)}>清空</button>
          </div>
          {field.other && <input disabled={disabled} type="password" autoComplete="off" spellCheck={false} maxLength={20_000}
            value={String(values[field.id] ?? "")} onChange={(event) => setSecretValue(field.id, event.target.value || undefined)} />}
        </> : field.type === "boolean" ? <select disabled={disabled} value={values[field.id] === undefined ? "" : String(values[field.id])} onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: event.target.value === "" ? undefined : event.target.value === "true" }))}>
          <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
        </select> : field.options && !field.secret && !field.other ? <select disabled={disabled} multiple={field.type === "array"} value={field.type === "array" ? values[field.id] as string[] ?? [] : String(values[field.id] ?? "")} onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: field.type === "array" ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value }))}>
          {field.type !== "array" && <option value="">请选择</option>}
          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select> : <>
          {field.options && !field.secret && <select disabled={disabled} value={field.options.some((option) => option.value === values[field.id]) ? String(values[field.id]) : ""} onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: event.target.value }))}>
            <option value="">选择选项或在下方填写</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>}
          <input disabled={disabled} type={field.secret ? "password" : field.type === "number" || field.type === "integer" ? "number" : "text"} autoComplete="off" spellCheck={!field.secret} maxLength={20_000} step={field.type === "integer" ? 1 : "any"} value={String(values[field.id] ?? "")} onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: (field.type === "number" || field.type === "integer") && event.target.value === "" ? undefined : event.target.value }))} />
        </>}
      </label>)}
      {error && <div className="error-text" role="alert">{error}</div>}
      {submitted ? <div role="status">回答已发送，等待服务器确认；不会自动重发。</div> : <div className="approval-actions">
        <button type="submit" className="btn-primary" disabled={disabled || !!form.error}>{form.url ? "确认完成" : "提交回答"}</button>
        <button type="button" className="btn" disabled={disabled} onClick={() => send(true)}>取消请求</button>
      </div>}
  </form>;
}
