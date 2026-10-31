import { isArchivedReceipt } from '../lib/operations';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { McpServerStatus } from '../../protocol/ts/v2/McpServerStatus';
import type { McpResourceReadResponse } from '../../protocol/ts/v2/McpResourceReadResponse';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
import { array, message, object } from '../lib/types';
import { usePaged } from '../hooks/usePaged';
import { useResource } from '../hooks/useResource';
import { reconcileOperation } from '../lib/operations';
import {
  acceptMcpBody,
  acceptMcpIdentity,
  appendMcpLog,
  changedMcpSession,
  currentMcpSession,
  mcpSession,
  type McpAttempt,
  type McpStream,
} from '../lib/mcp-session';
import { useWorkflow } from '../hooks/useWorkflow';
import { useOperations } from './Recovery';
import { ExtensionStatus, ReadState } from './ExtensionControls';
import { McpArguments } from './McpArguments';
import { McpContent, McpMediaProvider } from './McpContent';
import { McpConfiguration } from './McpConfiguration';
import { McpAuthorization } from './McpAuthorization';
type PendingRequest = {
  scope: object;
  session: object;
  label: string;
  controller: AbortController;
};
export function McpEventBridge({
  api,
  events,
  lease,
}: {
  api: Api;
  events: Events;
  lease: string;
}) {
  const session = mcpSession(api, lease);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (
          !currentMcpSession(api, session) ||
          event.type !== 'mcp' ||
          event.data.owned !== true ||
          typeof event.data.subscriptionId !== 'string'
        )
          return;
        appendMcpLog(
          session,
          event.data.subscriptionId,
          event.data.type === 'closed' ? { status: '订阅已结束' } : event.data.notification,
        );
      }),
    [api, events, session],
  );
  return null;
}
function McpPanelContent({
  api,
  events,
  epoch,
  runtimeEpoch = epoch,
  lease,
  connected,
  threadId,
  threadReady,
  threadIdle,
  configurationReady,
  projectId,
  visible = true,
  tab,
  setTab,
}: {
  tab: 'tools' | 'resources' | 'streams';
  setTab: (tab: 'tools' | 'resources' | 'streams') => void;
  visible?: boolean;
  projectId: string;
  api: Api;
  events: Events;
  epoch: string;
  runtimeEpoch?: string;
  lease: string;
  connected: boolean;
  threadId: string;
  threadReady: boolean;
  threadIdle: boolean;
  configurationReady: boolean;
}) {
  const session = mcpSession(api, lease),
    [, render] = useState(0),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState(''),
    [tool, setTool] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingRequest>(),
    [error, setError] = useState(''),
    [resource, setResource] = useState<{
      threadId: string;
      server: string;
      uri: string;
      result: McpResourceReadResponse;
    }>();
  const [template, setTemplate] = useState(''),
    [uri, setUri] = useState(''),
    [streamName, setStreamName] = useState(''),
    [streamArguments, setStreamArguments] = useState('{}'),
    [streamConfirmation, setStreamConfirmation] = useState<object>();
  const streamScope = useMemo(() => ({}), [api, session, epoch, threadId, selected, connected, visible, tab]);
  const streamConsent = streamConfirmation === streamScope,
    setStreamConsent = (value: boolean) => setStreamConfirmation(value ? streamScope : undefined);
  const running = useRef<PendingRequest | undefined>(undefined),
    activeRequest = useRef<PendingRequest | undefined>(undefined),
    mounted = useRef(true),
    owner = useRef({ session, connected, visible, scope: streamScope });
  owner.current = { session, connected, visible, scope: streamScope };
  const busy = pendingRequest?.scope === streamScope ? pendingRequest.label : '';
  const refresh = useCallback(() => setRevision((value) => value + 1), []),
    flow = useWorkflow(
      api,
      '',
      connected && visible,
      refresh,
      JSON.stringify([epoch, lease, threadId, connected]),
    ),
    operations = useOperations();
  const key = `${epoch}:${revision}:${threadReady ? threadId : ''}`;
  const servers = usePaged<McpServerStatus>(
    api,
    'mcp/list',
    { ...(threadReady && threadId ? { threadId } : {}), detail: 'full' },
    key,
    connected && visible,
  );
  const streams = useResource(
    `${lease}:${revision}`,
    (signal) => api.call<{ data: McpStream[] }>('mcp/stream/list', {}, signal),
    connected && visible,
  );
  // A refresh temporarily removes hook data. Keep the editor mounted, but require
  // current discovery before authorizing a new call.
  const lastServers = useRef<McpServerStatus[]>([]);
  if (servers.snapshotKey === key) lastServers.current = servers.items;
  const displayedServers = servers.snapshotKey === key ? servers.items : lastServers.current;
  const server = displayedServers.find((server) => server.name === selected),
    descriptor = server?.tools[tool];
  const pending =
    session.attempts.some((attempt) => ['pending', 'unknown'].includes(attempt.state)) ||
    operations.operations.some((operation) => ['pending', 'unknown'].includes(operation.state));
  const allowed =
    visible &&
    connected &&
    threadReady &&
    Boolean(threadId) &&
    !pending &&
    !busy &&
    !operations.error &&
    !servers.loading && !servers.error && servers.snapshotKey === key &&
    server?.runtimeStatus === 'connected';
  useEffect(() => {
    const notify = () => render((value) => value + 1);
    session.listeners.add(notify);
    return () => {
      session.listeners.delete(notify);
    };
  }, [session]);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type === 'mcp' && event.data.owned === true && event.data.type === 'closed')
          refresh();
      }),
    [events, refresh],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      const request = activeRequest.current;
      if (request?.scope === streamScope) {
        request.controller.abort();
        activeRequest.current = undefined;
      }
    },
    [streamScope],
  );
  useEffect(() => {
    setSelected('');
    setTool('');
    setResource(undefined);
    setError('');
    setTemplate('');
    setUri('');
    setStreamConsent(false);
  }, [lease, epoch, threadId, connected]);
  const current = () =>
    owner.current.connected &&
    owner.current.session === session &&
    currentMcpSession(api, session) &&
    !api.externalAuthenticationRequired;
  // Session records outlive a selection; pending UI and downloads belong to one request/visit.
  const owns = (request: PendingRequest) =>
    mounted.current &&
    current() &&
    owner.current.scope === request.scope &&
    activeRequest.current === request &&
    !request.controller.signal.aborted;
  const begin = (label: string) => {
    if (
      !visible || !owner.current.visible ||
      !mounted.current ||
      !current() ||
      owner.current.scope !== streamScope ||
      activeRequest.current?.scope === streamScope
    )
      return;
    activeRequest.current?.controller.abort();
    const request = { scope: streamScope, session, label, controller: new AbortController() };
    activeRequest.current = request;
    setPendingRequest(request);
    setError('');
    return request;
  };
  const finish = (request: PendingRequest) => {
    if (activeRequest.current !== request) return;
    activeRequest.current = undefined;
    if (mounted.current && owner.current.scope === request.scope) setPendingRequest(undefined);
  };
  const retained = (attempt: McpAttempt) => current() && session.attempts.includes(attempt);
  const readBody = async (attempt: McpAttempt, request: PendingRequest) => {
    if (!retained(attempt) || !attempt.resultId || request.controller.signal.aborted) return;
    let result: Record<string, unknown>;
    try {
      result = await api.call(
        'mcp/result/read',
        { resultId: attempt.resultId },
        request.controller.signal,
      );
    } catch (e) {
      if (request.controller.signal.aborted) return;
      if (retained(attempt) && e instanceof RpcError && e.code === 'not_found') {
        attempt.unavailable = true;
        attempt.body = undefined;
        changedMcpSession(session);
      }
      throw e;
    }
    if (retained(attempt)) {
      acceptMcpBody(attempt, result);
      attempt.error = undefined;
      changedMcpSession(session);
      return result;
    }
  };
  const start = async (method: McpAttempt['method'], name: string, arguments_: unknown) => {
    if (
      !allowed ||
      running.current?.session === session ||
      (method === 'mcp/tool/call' && !threadIdle) ||
      (method === 'mcp/stream/start' && !streamConsent)
    )
      return;
    if (session.attempts.length >= 8) {
      setError('当前连接已保留 8 笔调用或订阅记录。请先释放已完成结果或清除确定结束的记录。');
      return;
    }
    const pending = begin('start');
    if (!pending) return;
    running.current = pending;
    if (method === 'mcp/stream/start') setStreamConsent(false);
    let attempt: McpAttempt | undefined;
    try {
      const request = api.beginMutation(method, {
        threadId,
        server: selected,
        [method === 'mcp/tool/call' ? 'tool' : 'name']: name,
        arguments: arguments_,
      });
      attempt = {
        operationId: request.operationId,
        method,
        threadId,
        server: selected,
        name,
        state: 'pending',
      };
      session.attempts.push(attempt);
      changedMcpSession(session);
      const result = await request.result;
      if (!retained(attempt)) return;
      acceptMcpIdentity(attempt, result);
      changedMcpSession(session);
      if (owns(pending)) refresh();
      if (method === 'mcp/tool/call') await readBody(attempt, pending);
    } catch (e) {
      if (current()) {
        if (attempt && retained(attempt)) {
          if (attempt.state !== 'accepted')
            attempt.state =
              e instanceof RpcError && e.delivery === 'not_sent' ? 'not_sent' : 'unknown';
          attempt.error = message(e);
          changedMcpSession(session);
        }
        if (owns(pending)) setError(message(e));
      }
    } finally {
      if (running.current === pending) running.current = undefined;
      finish(pending);
    }
  };
  const recover = async (attempt: McpAttempt) => {
    if (!retained(attempt)) return;
    const request = begin(attempt.operationId);
    if (!request) return;
    try {
      const receipt = await api.call(
        'operation/read',
        { operationId: attempt.operationId },
        request.controller.signal,
      );
      if (!retained(attempt)) return;
      if (
        receipt.operationId !== attempt.operationId ||
        (receipt.state !== 'not_received' &&
          receipt.method !== attempt.method &&
          !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
          !isArchivedReceipt(receipt))
      )
        throw new Error('MCP 原调用回执不匹配。');
      if (receipt.state === 'accepted') acceptMcpIdentity(attempt, receipt.result);
      else if (receipt.state === 'not_sent') {
        attempt.state = 'not_sent';
        attempt.error = undefined;
      }
      await reconcileOperation(attempt.operationId, receipt);
      changedMcpSession(session);
      if (owns(request)) refresh();
      if (attempt.resultId) await readBody(attempt, request);
    } catch (e) {
      if (retained(attempt) && !request.controller.signal.aborted) {
        attempt.error = message(e);
        changedMcpSession(session);
      }
    } finally {
      finish(request);
    }
  };
  const readResource = async (scopeThread: string, scopeServer: string, target: string) => {
    if (!scopeThread) return;
    const request = begin('resource');
    if (!request) return;
    try {
      const result = await api.call<McpResourceReadResponse>(
        'mcp/resource/read',
        { threadId: scopeThread, server: scopeServer, uri: target },
        request.controller.signal,
      );
      if (!owns(request)) return;
      if (
        !Array.isArray(result.contents) ||
        new TextEncoder().encode(JSON.stringify(result)).length > 2 * 1024 * 1024
      )
        throw new Error('资源超过 2 MiB 界面展示上限，未保留正文。');
      setResource({ threadId: scopeThread, server: scopeServer, uri: target, result });
    } catch (e) {
      if (owns(request)) setError(message(e));
    } finally {
      finish(request);
    }
  };
  const readResult = async (attempt: McpAttempt, download = false) => {
    if (!retained(attempt)) return;
    const request = begin(attempt.operationId);
    if (!request) return;
    try {
      const result = await readBody(attempt, request);
      if (!download || !result || !owns(request)) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.result, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `mcp-result-${attempt.resultId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (retained(attempt) && !request.controller.signal.aborted) {
        attempt.error = `${message(e)} 结果丢失时不会重放调用。`;
        changedMcpSession(session);
      }
    } finally {
      finish(request);
    }
  };
  return (
    <McpMediaProvider scope={streamScope} enabled={connected && visible}>
      <section className="mcp-panel stack" hidden={!visible} inert={!visible}
        onClickCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}
        onSubmitCapture={(event) => { if (!visible) { event.preventDefault(); event.stopPropagation(); } }}>
        <div className="section-heading">
          <h3>MCP 服务与工具</h3>
          <button className="button small" disabled={!connected} onClick={refresh}>
            重新读取目录与订阅
          </button>
        </div>
        <p className="small muted">
          {threadReady && threadId
            ? `当前已加载会话：${threadId}`
            : '当前没有可执行的已加载会话。可查看服务；请返回会话明确加载并完成历史读取后调用工具。'}
        </p>
        <ReadState {...servers} />
        {(error || flow.error || operations.error) && (
          <p className="error" role="alert">
            {error || flow.error || operations.error}
          </p>
        )}
        <ExtensionStatus api={api} action={{ ...flow, revision, refresh }} />
        <label className="field">
          选择 MCP 服务
          <select
            value={selected}
            disabled={servers.loading || Boolean(servers.error) || servers.snapshotKey !== key}
            onChange={(event) => {
              setSelected(event.target.value);
              setError('');
              setStreamConsent(false);
              setTool('');
              setTemplate('');
              setUri('');
              setResource(undefined);
            }}
          >
            <option value="">选择已发现的服务</option>
            {displayedServers.map((server) => (
              <option key={server.name} value={server.name}>
                {server.name} · {server.runtimeStatus ?? '状态未知'} · {server.authStatus}
              </option>
            ))}
          </select>
        </label>
        {servers.hasMore && (
          <button className="button" disabled={servers.loading} onClick={() => void servers.more()}>
            更多服务
          </button>
        )}
        {!servers.loading && !servers.error && !servers.items.length && (
          <p className="muted">没有已配置的 MCP 服务。</p>
        )}
        {server && (
          <>
            <div className="info-card stack">
              <strong>{server.serverInfo?.name ?? server.name}</strong>
              <p className="small">
                连接：{server.runtimeStatus ?? '未知'} · 认证：{server.authStatus}
              </p>
              {server.httpOrigin && <p className="small path">{server.httpOrigin}</p>}
              {server.pluginId && <p className="small muted">来源插件：{server.pluginId}</p>}
              <McpAuthorization key={JSON.stringify([lease, epoch, runtimeEpoch, server.name, threadId, threadReady, connected])}
                api={api} events={events} session={session} epoch={runtimeEpoch} name={server.name}
                threadId={threadReady && threadId ? threadId : null} connected={connected}
                visible={visible && !servers.loading && !servers.error && servers.snapshotKey === key} />
            </div>
            <nav className="extension-tabs" aria-label="MCP 操作类别">
              {[
                ['tools', '工具'],
                ['resources', '资源'],
                ['streams', '事件订阅'],
              ].map(([id, label]) => (
                <button
                  className={`button small ${tab === id ? 'selected' : ''}`}
                  aria-pressed={tab === id}
                  key={id}
                  onClick={() => setTab(id as typeof tab)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <section hidden={tab !== 'tools'} inert={tab !== 'tools'}>
                {server.toolsError && (
                  <p className="error" role="alert">
                    工具发现失败：{server.toolsError}
                  </p>
                )}
                <label className="field">
                  选择工具
                  <select value={tool} onChange={(event) => setTool(event.target.value)}>
                    <option value="">选择已发现的工具</option>
                    {Object.entries(server.tools).map(([name, tool]) => (
                      <option key={name} value={name}>
                        {tool?.title ?? name}
                      </option>
                    ))}
                  </select>
                </label>
                {descriptor && (
                  <McpArguments
                    key={`${lease}:${threadId}:${server.name}:${tool}`}
                    tool={descriptor}
                    visible={visible && tab === 'tools'}
                    disabled={
                      !allowed ||
                      !threadIdle ||
                      server.toolsError !== null ||
                      descriptor.name !== tool
                    }
                    onCall={(arguments_) => void start('mcp/tool/call', tool, arguments_)}
                  />
                )}
            </section>
            {tab === 'resources' && (
              <>
                <h4>已发现资源</h4>
                {server.resources.map((item) => (
                  <article className="info-card stack" key={item.uri}>
                    <strong>{item.title ?? item.name}</strong>
                    <p>{item.description}</p>
                    <code className="path">{item.uri}</code>
                    <button
                      className="button small"
                      disabled={!threadReady || !connected || Boolean(busy)}
                      onClick={() => void readResource(threadId, server.name, item.uri)}
                    >
                      读取此资源
                    </button>
                  </article>
                ))}
                {!server.resources.length && <p className="muted">服务没有列出静态资源。</p>}
                {server.resourceTemplates.length > 0 && (
                  <form
                    className="info-card stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (template && uri) void readResource(threadId, server.name, uri);
                    }}
                  >
                    <label className="field">
                      资源模板
                      <select
                        value={template}
                        onChange={(event) => {
                          setTemplate(event.target.value);
                          setUri('');
                        }}
                      >
                        <option value="">选择已发现模板</option>
                        {server.resourceTemplates.map((item) => (
                          <option key={item.uriTemplate} value={item.uriTemplate}>
                            {item.title ?? item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {template && <code className="path">{template}</code>}
                    <label className="field">
                      按模板填写完整资源 URI
                      <input
                        value={uri}
                        onChange={(event) => setUri(event.target.value)}
                        maxLength={4096}
                      />
                    </label>
                    <button
                      className="button"
                      disabled={!template || !uri || !threadReady || !connected || Boolean(busy)}
                    >
                      读取模板资源
                    </button>
                  </form>
                )}
              </>
            )}
            {tab === 'streams' && (
              <form
                className="info-card stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    const args = JSON.parse(streamArguments);
                    if (new TextEncoder().encode(streamArguments).length > 262144)
                      throw new Error();
                    if (streamConsent && streamName.trim())
                      void start('mcp/stream/start', streamName.trim(), args);
                  } catch {
                    setError('订阅参数必须为有效 JSON，且不超过 256 KiB。');
                  }
                }}
              >
                <h4>服务专用事件订阅</h4>
                <p className="small muted">
                  原生目录没有事件名称
                  Schema。请仅填写此服务文档约定的名称和参数。关闭设置不会停止订阅；连接断开后服务端自动清理。
                </p>
                <label className="field">
                  事件流名称
                  <input
                    value={streamName}
                    onChange={(event) => {
                      setStreamName(event.target.value);
                      setStreamConsent(false);
                    }}
                    maxLength={256}
                  />
                </label>
                <label className="field">
                  事件流参数 JSON
                  <textarea
                    rows={5}
                    value={streamArguments}
                    onChange={(event) => {
                      setStreamArguments(event.target.value);
                      setStreamConsent(false);
                    }}
                    maxLength={131072}
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={streamConsent}
                    onChange={(event) => setStreamConsent(event.target.checked)}
                  />
                  确认启动此服务的事件订阅，直到明确停止或断线
                </label>
                <button
                  className="button primary"
                  disabled={
                    !allowed ||
                    !streamConsent ||
                    !streamName.trim() ||
                    (streams.data?.data.length ?? 0) >= 2
                  }
                >
                  启动事件订阅
                </button>
              </form>
            )}
          </>
        )}
        {resource && (
          <section className="info-card stack">
            <h4>资源内容 · {resource.server}</h4>
            <p className="small path">会话 {resource.threadId}</p>
            <code className="path">{resource.uri}</code>
            <McpContent content={resource.result.contents} identity={resource} />
            <button className="button small" onClick={() => setResource(undefined)}>
              关闭资源预览
            </button>
          </section>
        )}
        <h3>本连接的调用记录</h3>
        <p className="small muted">
          工具结果仅在当前连接与运行时暂存约 10 分钟。断线、重启或过期后不会自动重新调用。
        </p>
        {session.attempts.map((attempt) => (
          <section className="info-card stack" key={attempt.operationId}>
            <div className="section-heading">
              <strong>
                {attempt.server} / {attempt.name}
              </strong>
              <span className="badge">
                {attempt.state === 'accepted'
                  ? attempt.isError
                    ? '工具返回错误'
                    : '已受理'
                  : attempt.state === 'not_sent'
                    ? '确定未发送'
                    : '结果待确认'}
              </span>
            </div>
            <p className="small path">
              会话 {attempt.threadId} · {attempt.operationId}
            </p>
            {attempt.error && (
              <p className="error" role="alert">
                {attempt.error}
              </p>
            )}
            {attempt.bodyTooLarge && (
              <p className="workspace-warning">
                完整正文超过 2 MiB 界面上限，未保留展示。结果 ID 仍可用于显式读取。
              </p>
            )}
            <div className="inline wrap">
              {['pending', 'unknown'].includes(attempt.state) && (
                <button
                  className="button small"
                  disabled={!connected || Boolean(busy)}
                  onClick={() => void recover(attempt)}
                >
                  查询原 MCP 调用回执
                </button>
              )}
              {attempt.resultId && (
                <>
                  <button
                    className="button small"
                    disabled={!connected || Boolean(busy)}
                    onClick={() => void readResult(attempt)}
                  >
                    重新读取原结果
                  </button>
                  <button
                    className="button small"
                    disabled={!connected || Boolean(busy)}
                    onClick={() => void readResult(attempt, true)}
                  >
                    下载原结果 JSON
                  </button>
                  <button
                    className="button small"
                    disabled={!connected || flow.disabled}
                    onClick={async () => {
                      if (await flow.run('mcp/result/remove', { resultId: attempt.resultId })) {
                        session.attempts = session.attempts.filter((row) => row !== attempt);
                        changedMcpSession(session);
                      }
                    }}
                  >
                    释放结果
                  </button>
                </>
              )}
              {(attempt.state === 'not_sent' ||
                attempt.unavailable ||
                (attempt.subscriptionId &&
                  !streams.loading &&
                  streams.data &&
                  !streams.data.data.some(
                    (stream) => stream.subscriptionId === attempt.subscriptionId,
                  ))) && (
                <button
                  className="button small"
                  onClick={() => {
                    session.attempts = session.attempts.filter((row) => row !== attempt);
                    changedMcpSession(session);
                  }}
                >
                  清除已结束记录
                </button>
              )}
            </div>
            {attempt.body && (
              <>
                <McpContent
                  content={attempt.body.content}
                  identity={attempt}
                  onResource={(target) =>
                    void readResource(attempt.threadId, attempt.server, target)
                  }
                />
                {attempt.body.structuredContent !== undefined && (
                  <details>
                    <summary>结构化结果</summary>
                    <pre className="raw">
                      {JSON.stringify(attempt.body.structuredContent, null, 2)}
                    </pre>
                  </details>
                )}
              </>
            )}
          </section>
        ))}
        <h3>当前连接订阅</h3>
        <ReadState {...streams} />
        {streams.data?.data.map((stream) => (
          <section className="info-card stack" key={stream.subscriptionId}>
            <strong>
              {stream.server} / {stream.name}
            </strong>
            <p className="small path">会话 {stream.threadId}</p>
            <button
              className="button danger small"
              disabled={!connected || flow.disabled}
              onClick={() =>
                void flow.run('mcp/stream/stop', { subscriptionId: stream.subscriptionId })
              }
            >
              停止此订阅
            </button>
            <details>
              <summary>最近事件</summary>
              {session.logs
                .filter((row) => row.subscriptionId === stream.subscriptionId)
                .map((row, index) => (
                  <pre className="raw" key={index}>
                    {row.text}
                  </pre>
                ))}
            </details>
          </section>
        ))}
        {streams.data?.data.length === 0 && <p className="muted">此连接没有活动订阅。</p>}
        {session.dropped > 0 && (
          <p className="workspace-warning">
            事件缓冲已截断或移除 {session.dropped} 条旧内容；显示不是完整事件历史。
          </p>
        )}
        <button
          className="button small"
          disabled={!configurationReady || flow.disabled}
          onClick={() =>
            void flow.run(
              'mcp/reload',
              {},
              '重载请求已受理。请重新读取各服务的连接、认证与工具状态。',
            )
          }
        >
          空闲时重载 MCP 配置
        </button>
        <details>
          <summary>查看或编辑 MCP 服务配置</summary>
          <McpConfiguration
            key={projectId}
            api={api}
            projectId={projectId}
            epoch={epoch}
            enabled={configurationReady}
            visible={visible}
            onChanged={refresh}
          />
        </details>
      </section>
    </McpMediaProvider>
  );
}

export function McpPanel(props: Omit<ComponentProps<typeof McpPanelContent>, 'tab' | 'setTab'>) {
  const [tab, setTab] = useState<'tools' | 'resources' | 'streams'>('tools');
  const identity = JSON.stringify([props.epoch, props.runtimeEpoch ?? props.epoch, props.lease,
    props.threadId, props.projectId, props.connected]);
  const owner = useRef({ api: props.api, identity, generation: 0 });
  if (owner.current.api !== props.api || owner.current.identity !== identity)
    owner.current = { api: props.api, identity, generation: owner.current.generation + 1 };
  return <McpPanelContent key={owner.current.generation} {...props} tab={tab} setTab={setTab} />;
}
