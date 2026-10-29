import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { message, object } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

type Environment = {
  environmentId: string;
  name: string;
  endpoint: string;
  selectionReady: boolean;
  requiresRestartToDisconnect: boolean;
  info?: { cwd: string | null; shell: { name: string; path: string } };
};
type RemoteStatus = {
  status: 'disabled' | 'connecting' | 'connected' | 'errored';
  serverName: string;
  installationId: string;
  environmentId: string | null;
};
type Client = {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  lastSeenAt: number | null;
};
type Pairing = {
  pairingId: string;
  environmentId: string;
  pairingCode: string;
  manualPairingCode: string | null;
  expiresAt: number;
};
type PairingCheck = { owner: object; controller: AbortController };
function expiry(value: number) {
  return value < 1e12 ? value * 1000 : value;
}

function Executor({
  api,
  epoch,
  enabled,
  visible,
  onChanged,
}: {
  api: Api;
  epoch: string;
  enabled: boolean;
  visible: boolean;
  onChanged: () => void;
}) {
  const action = useExtensionAction(
    api, enabled && visible, onChanged, JSON.stringify([epoch, visible, enabled]),
  ),
    environments = useResource(
      `${epoch}:${action.revision}`,
      (signal) => api.call<{ data: Environment[] }>('environment/list', {}, signal),
      visible,
    );
  const [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [token, setToken] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [selected, setSelected] = useState('');
  useEffect(() => {
    setToken('');
    setConfirmed(false);
  }, [epoch, visible, enabled]);
  const row = environments.data?.data.find((item) => item.environmentId === selected);
  const status = useResource(
    `${epoch}:${selected}:${action.revision}`,
    (signal) =>
      api.call<{ status: string; error?: string }>(
        'environment/status',
        { environmentId: selected },
        signal,
      ),
    visible && Boolean(row),
  );
  const change = (set: () => void) => {
    set();
    setConfirmed(false);
  };
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>远端执行环境</h3>
        <button className="button small" onClick={action.refresh}>
          刷新执行环境
        </button>
      </div>
      <p>
        将 Codex 连接到你管理的
        exec-server。注册后还需读取远端信息，才能在新会话中明确选择。远端工作目录与网页项目目录属于不同机器。
      </p>
      <p className="workspace-warning">
        连接会持续到执行服务重启，关闭网页不会断开。原生接口没有单独删除环境功能。注册远端后，无法证明执行环境的旧会话可能需要先重启执行服务、断开远端，才能安全恢复。
      </p>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原远端配置回执" />
      <ReadState {...environments} />
      <label className="field">
        已注册执行环境
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">选择环境</option>
          {environments.data?.data.map((item) => (
            <option key={item.environmentId} value={item.environmentId}>
              {item.name} · {item.selectionReady ? '可显式选择' : '待读取信息'}
            </option>
          ))}
        </select>
      </label>
      {row && (
        <div className="info-card stack">
          <p className="small path">连接地址：{row.endpoint}</p>
          <ReadState {...status} />
          {status.data && (
            <p>
              状态：{status.data.status}
              {status.data.error ? ` · ${status.data.error}` : ''}
            </p>
          )}
          {row.info && (
            <>
              <p className="small path">远端工作目录：{row.info.cwd ?? '未提供'}</p>
              <p className="small path">
                远端 shell：{row.info.shell.name} · {row.info.shell.path}
              </p>
            </>
          )}
          <button
            className="button"
            disabled={action.disabled}
            onClick={() =>
              void action.run(
                'environment/info',
                { environmentId: row.environmentId },
                '已读取远端信息；尚未选择到会话。',
              )
            }
          >
            读取并核对远端信息
          </button>
        </div>
      )}
      <details className="info-card">
        <summary>登记新的远端环境</summary>
        <div className="stack">
          <label className="field">
            环境名称
            <input
              value={name}
              maxLength={128}
              onChange={(e) => change(() => setName(e.target.value))}
            />
          </label>
          <label className="field">
            Exec-server WebSocket 地址
            <input
              value={url}
              placeholder="wss://executor.example.com/"
              maxLength={4096}
              onChange={(e) => change(() => setUrl(e.target.value))}
            />
          </label>
          <p className="small muted">
            远端需要 WSS；只有服务器自身 loopback 地址允许
            WS。不要在地址中加入凭证、查询参数或片段。
            切换设置类别会清除 token 与授权勾选，名称和地址仍保留。
          </p>
          <label className="field">
            Bearer token（按需填写，仅保留在本次运行内存）
            <input
              type="password"
              autoComplete="off"
              value={token}
              maxLength={4096}
              onChange={(e) => change(() => setToken(e.target.value))}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            确认连接此执行服务，并授权后续明确选中的会话在远端执行
          </label>
          <button
            className="button primary"
            disabled={action.disabled || !name.trim() || !url.trim() || !confirmed}
            onClick={async () => {
              if (action.disabled || !confirmed) return;
              // Clear the form's secret even when the outcome is unknown; recovery reads
              // the original receipt and must not re-register using a retained token.
              const bearer = token;
              setToken('');
              setConfirmed(false);
              const result = await action.run(
                'environment/add',
                {
                  name: name.trim(),
                  execServerUrl: url.trim(),
                  ...(bearer ? { authBearerToken: bearer } : {}),
                  confirmRemoteExecution: true,
                },
                '远端已登记。请读取信息并核对，再选择到会话。',
              );
              if (typeof result?.environmentId === 'string') setSelected(result.environmentId);
            }}
          >
            确认登记远端
          </button>
        </div>
      </details>
    </section>
  );
}

function RemoteControl({
  api,
  events,
  epoch,
  enabled,
  connected,
  onChanged,
}: {
  api: Api;
  events: Events;
  epoch: string;
  enabled: boolean;
  connected: boolean;
  onChanged: () => void;
}) {
  const [revision, setRevision] = useState(0),
    refresh = useCallback(() => {
      setRevision((value) => value + 1);
      onChanged();
    }, [onChanged]);
  const action = useExtensionAction(api, enabled && connected, refresh),
    status = useResource(`${epoch}:${revision}`, (signal) =>
      api.call<RemoteStatus>('remoteControl/status/read', {}, signal),
    );
  const [confirm, setConfirm] = useState(false),
    [persist, setPersist] = useState(false),
    [pairingId, setPairingId] = useState(''),
    [manual, setManual] = useState(false),
    [pairConfirmed, setPairConfirmed] = useState(false),
    [claimed, setClaimed] = useState<boolean>(),
    [pairError, setPairError] = useState(''),
    [expired, setExpired] = useState(false);
  const [cursor, setCursor] = useState(''),
    [cursors, setCursors] = useState<string[]>([]),
    [revoke, setRevoke] = useState('');
  const lastStatus = useRef<RemoteStatus | undefined>(undefined);
  if (status.data) lastStatus.current = status.data;
  const environmentId = lastStatus.current?.environmentId ?? '';
  const pairScope = `${epoch}:${connected}:${pairingId}:${environmentId}`;
  // Each transition gets a new owner, even when an ID or environment later returns.
  const pairOwner = useMemo(() => ({}), [epoch, connected, pairingId, environmentId]),
    ownerRef = useRef(pairOwner);
  ownerRef.current = pairOwner;
  const checkRequest = useRef<PairingCheck | undefined>(undefined),
    [pendingCheck, setPendingCheck] = useState<PairingCheck>();
  const checking = pendingCheck?.owner === pairOwner;
  const clients = useResource(
    `${epoch}:${environmentId}:${cursor}:${revision}`,
    (signal) =>
      api.call<{ data: Client[]; nextCursor: string | null }>(
        'remoteControl/client/list',
        { environmentId, ...(cursor ? { cursor } : {}), limit: 25, order: 'desc' },
        signal,
      ),
    Boolean(environmentId),
  );
  const pair = useResource(
    pairScope,
    (signal) => api.call<Pairing>('remoteControl/pairing/read', { pairingId }, signal),
    connected && Boolean(pairingId) && !expired && claimed !== true,
  );
  useEffect(
    () => () => {
      const request = checkRequest.current;
      if (request?.owner === pairOwner) {
        checkRequest.current = undefined;
        request.controller.abort();
      }
    },
    [pairOwner],
  );
  useEffect(
    () =>
      events.subscribe((event) => {
        if (object(event.data).method === 'remoteControl/status/changed') refresh();
      }),
    [events, refresh],
  );
  useEffect(() => {
    setPairingId('');
    setClaimed(undefined);
    setExpired(false);
    setPairError('');
    setConfirm(false);
    setPairConfirmed(false);
  }, [connected, environmentId]);
  useEffect(() => {
    setCursor('');
    setCursors([]);
    setRevoke('');
  }, [environmentId]);
  useEffect(() => {
    if (!pair.data) return;
    const remaining = Math.min(600000, Math.max(0, expiry(pair.data.expiresAt) - Date.now()));
    const timer = setTimeout(() => {
      setExpired(true);
      setPairingId('');
    }, remaining);
    return () => clearTimeout(timer);
  }, [pair.data]);
  const recoveredId =
    action.operation?.state === 'accepted' &&
    action.operation.method === 'remoteControl/pairing/start'
      ? action.operation.id
      : '';
  useEffect(() => {
    if (!recoveredId || !connected) return;
    const controller = new AbortController();
    void api.call('operation/read', { operationId: recoveredId }, controller.signal).then(
      (receipt) => {
        const result = object(receipt.result);
        if (
          !controller.signal.aborted &&
          receipt.state === 'accepted' &&
          receipt.method === 'remoteControl/pairing/start' &&
          typeof result.pairingId === 'string'
        ) {
          setPairingId(result.pairingId);
          setClaimed(undefined);
          setExpired(false);
        }
      },
      () => {},
    );
    return () => controller.abort();
  }, [api, recoveredId, connected]);
  const hasRemote = status.data?.status === 'connected' || status.data?.status === 'connecting';
  const checkPairing = async () => {
    if (
      !connected ||
      !pairingId ||
      !pair.data ||
      expired ||
      claimed === true ||
      ownerRef.current !== pairOwner ||
      checkRequest.current?.owner === pairOwner
    )
      return;
    checkRequest.current?.controller.abort();
    const request: PairingCheck = { owner: pairOwner, controller: new AbortController() };
    checkRequest.current = request;
    setPendingCheck(request);
    setPairError('');
    const current = () =>
      checkRequest.current === request &&
      ownerRef.current === pairOwner &&
      !request.controller.signal.aborted;
    try {
      const result = await api.call<{ claimed: boolean }>(
        'remoteControl/pairing/status',
        { pairingId },
        request.controller.signal,
      );
      if (current()) {
        setClaimed(result.claimed);
        if (result.claimed) refresh();
      }
    } catch (e) {
      if (current()) setPairError(message(e));
    } finally {
      // A late completion must not clear the pending state of a newer request.
      if (current()) {
        checkRequest.current = undefined;
        setPendingCheck((previous) => (previous === request ? undefined : previous));
      }
    }
  };
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>Codex 原生远程控制</h3>
        <button className="button small" onClick={refresh}>
          刷新远程控制状态
        </button>
      </div>
      <p>
        允许原生账号客户端连接此运行时。此通道独立于 Harness 网页认证，受 Codex
        账号、组织策略与原生服务能力限制。
      </p>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原远程控制回执" />
      <ReadState {...status} />
      {status.data && (
        <p>
          状态：{status.data.status} · {status.data.serverName}
        </p>
      )}
      <label className="check-row">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => {
            setPersist(e.target.checked);
            setConfirm(false);
          }}
        />
        将启用或关闭选择持久保存到原生配置
      </label>
      <p className="small muted">默认仅改变本次运行。持久保存会影响以后的启动。</p>
      <label className="check-row">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        确认开放独立于网页登录的原生远程访问
      </label>
      <div className="toolbar">
        <button
          className="button primary"
          disabled={action.disabled || !confirm || hasRemote}
          onClick={async () => {
            if (
              await action.run('remoteControl/enable', {
                ephemeral: !persist,
                confirmExternalAccess: true,
              })
            )
              setConfirm(false);
          }}
        >
          启用原生远程控制
        </button>
        <button
          className="button danger"
          disabled={action.disabled || status.data?.status === 'disabled' || !status.data}
          onClick={async () => {
            if (await action.run('remoteControl/disable', { ephemeral: !persist })) {
              setPairingId('');
              setConfirm(false);
            }
          }}
        >
          关闭原生远程控制
        </button>
      </div>
      <details className="info-card">
        <summary>配对新的客户端</summary>
        <div className="stack">
          <p>
            配对码可授予客户端访问权。只在你当前连接中显示，不写入浏览器存储；连接断开或到期后不再显示。不要分享给无关人员。
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={manual}
              onChange={(e) => {
                setManual(e.target.checked);
                setPairConfirmed(false);
              }}
            />
            同时生成手动输入码
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={pairConfirmed}
              onChange={(e) => setPairConfirmed(e.target.checked)}
            />
            确认创建用于授权新客户端的配对码
          </label>
          <button
            className="button"
            disabled={
              action.disabled ||
              !hasRemote ||
              !pairConfirmed ||
              Boolean(pairingId && !expired && claimed !== true)
            }
            onClick={async () => {
              const result = await action.run(
                'remoteControl/pairing/start',
                { manualCode: manual },
                '配对创建已确认。正在读取当前连接可见的配对码。',
              );
              if (typeof result?.pairingId === 'string') {
                setPairingId(result.pairingId);
                setClaimed(undefined);
                setExpired(false);
                setPairError('');
                setPairConfirmed(false);
              }
            }}
          >
            创建一次配对
          </button>
          <ReadState {...pair} />
          {connected && pair.data && !expired && claimed !== true && (
            <div className="stack">
              <label className="field">
                配对码
                <textarea readOnly value={pair.data.pairingCode} />
              </label>
              {pair.data.manualPairingCode && (
                <label className="field">
                  手动输入码
                  <input readOnly value={pair.data.manualPairingCode} />
                </label>
              )}
              <p>到期时间：{new Date(expiry(pair.data.expiresAt)).toLocaleString()}</p>
              <button className="button" disabled={checking} onClick={() => void checkPairing()}>
                检查是否已配对
              </button>
            </div>
          )}
          {claimed === true && <p role="status">客户端已领取此配对，请核对下方客户端列表。</p>}
          {expired && <p role="status">配对显示已到期。需要新配对时请重新确认。</p>}
          {pairError && (
            <p className="error" role="alert">
              {pairError}
            </p>
          )}
        </div>
      </details>
      <h4>已授权客户端</h4>
      <ReadState {...clients} />
      {clients.data?.data.map((client) => (
        <div className="info-card stack" key={client.clientId}>
          <strong>{client.displayName ?? client.clientId}</strong>
          <p className="small">
            {client.platform ?? '平台未提供'} · {client.deviceType ?? '设备类型未提供'}
            {client.lastSeenAt
              ? ` · 最近活动 ${new Date(expiry(client.lastSeenAt)).toLocaleString()}`
              : ''}
          </p>
          <p className="small path">{client.clientId}</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={revoke === client.clientId}
              onChange={(e) => setRevoke(e.target.checked ? client.clientId : '')}
            />
            确认撤销此客户端
          </label>
          <button
            className="button danger"
            disabled={action.disabled || revoke !== client.clientId}
            onClick={async () => {
              if (
                await action.run(
                  'remoteControl/client/revoke',
                  { environmentId, clientId: client.clientId },
                  '客户端撤销已确认。',
                )
              )
                setRevoke('');
            }}
          >
            撤销此客户端
          </button>
        </div>
      ))}
      {clients.data?.data.length === 0 && <p className="muted">当前页没有已授权客户端。</p>}
      <div className="toolbar">
        <button
          className="button small"
          disabled={!cursors.length || clients.loading}
          onClick={() => {
            setCursor(cursors[cursors.length - 1]!);
            setCursors((previous) => previous.slice(0, -1));
            setRevoke('');
          }}
        >
          上一页客户端
        </button>
        <button
          className="button small"
          disabled={
            !clients.data?.nextCursor ||
            clients.loading ||
            cursors.length >= 99 ||
            clients.data.nextCursor === cursor ||
            cursors.includes(clients.data.nextCursor)
          }
          onClick={() => {
            setCursors((previous) => [...previous, cursor]);
            setCursor(clients.data!.nextCursor!);
            setRevoke('');
          }}
        >
          下一页客户端
        </button>
      </div>
    </section>
  );
}

export function RemoteSettings({
  api,
  events,
  epoch,
  connectionId,
  enabled,
  connected,
  onChanged,
  visible = true,
}: {
  api: Api;
  events: Events;
  epoch: string;
  connectionId: string;
  enabled: boolean;
  connected: boolean;
  onChanged: () => void;
  visible?: boolean;
}) {
  const owner = useRef({ api, csrf: api.csrf, epoch, connectionId, generation: 0 });
  if (
    owner.current.api !== api || owner.current.csrf !== api.csrf ||
    owner.current.epoch !== epoch || owner.current.connectionId !== connectionId
  )
    owner.current = {
      api, csrf: api.csrf, epoch, connectionId, generation: owner.current.generation + 1,
    };
  return (
    <div className="stack" key={owner.current.generation}>
      <Executor {...{ api, epoch, enabled: enabled && connected, visible, onChanged }} />
      {visible && <RemoteControl {...{ api, events, epoch, enabled, connected, onChanged }} />}
    </div>
  );
}
