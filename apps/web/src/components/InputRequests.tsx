import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { inputForm, validateInput, validateResponse, type InputRequest } from "../utils/input-forms";

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
  return <form className="approval-card input-request-form" onSubmit={submit} autoComplete="off">
      <div className="approval-title">{request.method === "mcpServer/elicitation/request" ? `MCP · ${request.params.serverName}` : "Codex 请求输入"}</div>
      <p>{form.message}</p>
      <div className="dim">会话 {request.params.threadId} · 回答会发送给上述请求方。取消或超时将结束本次请求。</div>
      {form.error && <p className="error-text" role="alert">{form.error}。未自动批准或取消；你可以取消此请求。</p>}
      {form.url && <p><a href={form.url} target="_blank" rel="noreferrer noopener">打开请求方的交互页面</a>（在该页面完成后，再点击「确认完成」。）</p>}
      {!submitted && form.fields.map((field) => <label className="input-request-field" key={field.id}>
        <span>{field.label}{field.required ? " *" : ""}</span>
        {field.description && <span className="dim">{field.description}</span>}
        {field.type === "boolean" ? <select disabled={disabled} value={values[field.id] === undefined ? "" : String(values[field.id])} onChange={(event) => setValues((previous) => ({ ...previous, [field.id]: event.target.value === "" ? undefined : event.target.value === "true" }))}>
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
