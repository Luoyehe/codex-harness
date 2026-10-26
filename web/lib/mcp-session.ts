import type { Api } from './api';
import { object } from './types';
export type McpAttempt = {
  operationId: string;
  method: 'mcp/tool/call' | 'mcp/stream/start';
  threadId: string;
  server: string;
  name: string;
  state: 'pending' | 'accepted' | 'unknown' | 'not_sent';
  resultId?: string;
  subscriptionId?: string;
  isError?: boolean;
  body?: Record<string, unknown>;
  error?: string;
  bodyTooLarge?: boolean;
  unavailable?: boolean;
};
export type McpStream = { subscriptionId: string; threadId: string; server: string; name: string };
export type McpOauthAttempt = {
  name: string; threadId: string | null; operationId?: string;
  state: 'pending' | 'unknown' | 'accepted' | 'not_sent';
  identity?: { handoffId: string; epoch: string; name: string; threadId: string | null };
  status?: 'pending' | 'completed' | 'failed'; restartRequired?: boolean;
};
export type McpSession = {
  epoch: string;
  attempts: McpAttempt[];
  oauth: McpOauthAttempt[];
  logs: { subscriptionId: string; text: string }[];
  dropped: number;
  listeners: Set<() => void>;
};
const sessions = new WeakMap<Api, McpSession>();
export function mcpSession(api: Api, epoch: string): McpSession {
  let session = sessions.get(api);
  if (!session || session.epoch !== epoch) {
    session = { epoch, attempts: [], oauth: [], logs: [], dropped: 0, listeners: new Set() };
    sessions.set(api, session);
  }
  return session;
}
export function currentMcpSession(api: Api, session: McpSession) {
  return sessions.get(api) === session;
}
export function changedMcpSession(session: McpSession) {
  session.listeners.forEach((listener) => listener());
}
export function acceptMcpIdentity(attempt: McpAttempt, value: unknown) {
  const result = object(value);
  if (
    result.threadId !== attempt.threadId ||
    result.server !== attempt.server ||
    (attempt.method === 'mcp/tool/call' ? result.tool : result.name) !== attempt.name
  )
    throw new Error('MCP 回执与原会话、服务或工具身份不匹配。');
  const name = attempt.method === 'mcp/tool/call' ? 'resultId' : 'subscriptionId',
    id = result[name];
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(id) ||
    (attempt[name] && attempt[name] !== id)
  )
    throw new Error('MCP 回执结果身份无效。');
  if (attempt.method === 'mcp/tool/call' && typeof result.isError !== 'boolean')
    throw new Error('MCP 工具结果状态无效。');
  attempt[name] = id;
  attempt.isError = result.isError === true;
  attempt.state = 'accepted';
  attempt.error = undefined;
}
export function acceptMcpBody(attempt: McpAttempt, value: unknown) {
  const result = object(value),
    body = object(result.result);
  if (
    result.resultId !== attempt.resultId ||
    result.threadId !== attempt.threadId ||
    result.server !== attempt.server ||
    result.tool !== attempt.name ||
    !Array.isArray(body.content)
  )
    throw new Error('MCP 正文与原调用身份不匹配。');
  attempt.isError = body.isError === true;
  attempt.bodyTooLarge = new TextEncoder().encode(JSON.stringify(body)).length > 2 * 1024 * 1024;
  attempt.body = attempt.bodyTooLarge ? undefined : body;
}
export function appendMcpLog(session: McpSession, subscriptionId: string, value: unknown) {
  let text = JSON.stringify(value ?? null);
  if (text.length > 8192) {
    text = text.slice(0, 8192) + '\n[单条事件展示已截断]';
    session.dropped++;
  }
  session.logs.push({ subscriptionId, text });
  let bytes = session.logs.reduce((n, row) => n + row.text.length * 2, 0);
  while (session.logs.length > 100 || bytes > 262144) {
    const row = session.logs.shift();
    bytes -= (row?.text.length ?? 0) * 2;
    session.dropped++;
  }
  changedMcpSession(session);
}
