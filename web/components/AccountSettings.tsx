import { isArchivedReceipt } from '../lib/operations';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
import { useResource } from '../hooks/useResource';
import { acknowledgeOperation, reconcileOperation } from '../lib/operations';
import { message, object, safeUrl } from '../lib/types';
import { useOperations } from './Recovery';
type Attempt = {
  id: string;
  method: 'account/login' | 'account/login/cancel' | 'account/logout';
  state: 'pending' | 'unknown' | 'accepted' | 'not_sent';
};
type IdentityCache = { loginId: string; attempt?: Attempt; restartRequired?: boolean };
type Handoff = { loginId: string; verificationUrl: string; userCode: string; expiresAt: number };
// Only non-secret identities survive a modal close. Codes live solely in the mounted owner component.
let ownerKey = '',
  ownerRecord: IdentityCache = { loginId: '' };
const changedEvent = 'harness-device-login-identity';
function cacheFor(key: string) {
  if (ownerKey !== key) {
    ownerKey = key;
    ownerRecord = { loginId: '' };
  }
  return ownerRecord;
}
export function AccountSettings(props: {
  api: Api;
  epoch: string;
  events: Events;
  connectionId?: string;
  connected?: boolean;
  enabled?: boolean;
  onServiceSettings?: () => void;
}) {
  const key = `${props.api.clientId}:${props.epoch}:${props.connectionId ?? ''}`;
  return <OwnedAccountSettings key={key} {...props} owner={key} />;
}
function OwnedAccountSettings({
  api,
  epoch,
  events,
  owner,
  connected = true,
  enabled = true,
  onServiceSettings,
}: {
  api: Api;
  epoch: string;
  events: Events;
  owner: string;
  connected?: boolean;
  enabled?: boolean;
  onServiceSettings?: () => void;
}) {
  const record = useRef(cacheFor(owner)).current,
    [identity, setIdentity] = useState<IdentityCache>({ ...record });
  const account = useResource(epoch, (signal) => api.call('account/read', {}, signal), connected),
    limits = useResource(epoch, (signal) => api.call('account/rateLimits', {}, signal), connected);
  const [handoff, setHandoff] = useState<Handoff>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const restartRequired = Boolean(identity.restartRequired);
  const mounted = useRef(true),
    online = useRef(connected),
    running = useRef(false),
    handoffRead = useRef(0),
    completions = useRef(new Map<string, { success: boolean; error?: string }>());
  online.current = connected;
  const operations = useOperations(),
    unresolved = operations.operations.some((op) => ['pending', 'unknown'].includes(op.state)),
    pending = Boolean(identity.attempt && ['pending', 'unknown'].includes(identity.attempt.state));
  const owned = () => ownerKey === owner && record === ownerRecord;
  const current = () =>
    mounted.current && online.current && owned() && !api.externalAuthenticationRequired;
  const store = (update: Partial<IdentityCache>) => {
    if (!owned()) return;
    Object.assign(record, update);
    window.dispatchEvent(new Event(changedEvent));
  };
  const clearCode = () => {
    handoffRead.current++;
    if (mounted.current) setHandoff(undefined);
  };
  const finishLogin = (text: string) => {
    clearCode();
    store({
      loginId: '',
      restartRequired: false,
      ...(!record.attempt || !['pending', 'unknown'].includes(record.attempt.state)
        ? { attempt: undefined }
        : {}),
    });
    if (current()) {
      setStatus(text);
      account.refresh();
      limits.refresh();
    }
  };
  const readHandoff = async (loginId = record.loginId) => {
    if (!loginId || !current()) return;
    const generation = ++handoffRead.current;
    try {
      const result = await api.call('account/login/handoff', { loginId });
      if (!current() || generation !== handoffRead.current || record.loginId !== loginId) return;
      if (
        result.loginId !== loginId ||
        !['pending', 'completed', 'failed'].includes(String(result.status))
      )
        throw new Error('登录交接身份或状态无效，未显示设备码。');
      if (result.status !== 'pending') {
        finishLogin(
          result.status === 'completed'
            ? '原生服务报告登录已完成，正在核对账户。'
            : '原生服务报告登录失败，请核对账户状态。',
        );
        return;
      }
      if (
        record.attempt?.method === 'account/login/cancel' &&
        ['pending', 'unknown'].includes(record.attempt.state)
      ) {
        clearCode();
        return;
      }
      const url = safeUrl(result.verificationUrl);
      if (
        !url ||
        !url.startsWith('https://') ||
        typeof result.userCode !== 'string' ||
        !result.userCode ||
        result.userCode.length > 256 ||
        !Number.isSafeInteger(result.expiresAt) ||
        Number(result.expiresAt) <= Date.now()
      )
        throw new Error('设备码已过期或交接内容无效，请重新读取或取消原登录。');
      setHandoff({
        loginId,
        verificationUrl: url,
        userCode: result.userCode,
        expiresAt: Number(result.expiresAt),
      });
      setStatus('等待原生服务确认登录结果。');
    } catch (e) {
      if (!current() || generation !== handoffRead.current) return;
      clearCode();
      if (e instanceof RpcError && e.code === 'not_found')
        finishLogin('原设备码已撤销或过期。已关闭交接，请核对当前账户。');
      else setError(message(e));
    }
  };
  const accept = async (attempt: Attempt, value: Record<string, unknown>) => {
    if (!owned()) return;
    store({ attempt: { ...attempt, state: 'accepted' } });
    if (attempt.method === 'account/login') {
      if (
        value.type !== 'chatgptDeviceCode' ||
        typeof value.loginId !== 'string' ||
        !value.loginId ||
        value.loginId.length > 256
      ) {
        store({ restartRequired: true });
        if (current())
          setError('原登录已受理，但没有取得有效登录 ID。不能重新登录，请明确重启服务恢复。');
        return;
      }
      store({ restartRequired: false });
      if (current()) setError('');
      const completed = completions.current.get(value.loginId);
      if (completed) {
        finishLogin(
          completed.success
            ? '原生服务已确认登录成功，正在读取账户。'
            : (completed.error ?? '原登录已失败。'),
        );
        return;
      }
      store({ loginId: value.loginId });
      if (current()) await readHandoff(value.loginId);
    } else if (attempt.method === 'account/login/cancel') {
      if (!['canceled', 'notFound'].includes(String(value.status))) {
        store({ restartRequired: true });
        if (current())
          setError('取消请求已受理，但没有取得取消状态。请读取原登录状态或明确重启服务。');
        return;
      }
      finishLogin(
        value.status === 'canceled'
          ? '已取消原设备码登录。'
          : '原登录已不在待处理状态，正在核对账户。',
      );
    } else {
      finishLogin('退出请求已受理，正在重新读取账户。');
    }
  };
  const perform = async (method: Attempt['method']) => {
    if (
      running.current ||
      !current() ||
      !enabled ||
      operations.error ||
      unresolved ||
      pending ||
      restartRequired ||
      (method === 'account/login' && record.loginId) ||
      (method === 'account/logout' && record.loginId)
    )
      return;
    running.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    if (method !== 'account/login') clearCode();
    let attempt: Attempt | undefined;
    try {
      const request = api.beginMutation(
        method,
        method === 'account/login/cancel' ? { loginId: record.loginId } : {},
      );
      attempt = { id: request.operationId, method, state: 'pending' };
      store({ attempt });
      const result = await request.result;
      await accept(attempt, result);
    } catch (e) {
      if (
        attempt &&
        owned() &&
        record.attempt?.id === attempt.id &&
        record.attempt.state !== 'accepted'
      )
        store({
          attempt: {
            ...attempt,
            state: e instanceof RpcError && e.delivery === 'not_sent' ? 'not_sent' : 'unknown',
          },
        });
      if (current()) setError(message(e));
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  };
  const recover = async () => {
    const attempt = record.attempt;
    if (!attempt || !current() || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await api.call('operation/read', { operationId: attempt.id });
      if (!current() || record.attempt?.id !== attempt.id) return;
      if (
        receipt.operationId !== attempt.id ||
        (receipt.state !== 'not_received' &&
          receipt.method !== attempt.method &&
          !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
          !isArchivedReceipt(receipt))
      )
        throw new Error('账户操作回执身份不匹配。');
      await reconcileOperation(attempt.id, receipt);
      if (!current() || record.attempt?.id !== attempt.id) return;
      if (receipt.state === 'accepted') {
        await accept(attempt, object(receipt.result));
        await acknowledgeOperation(attempt.id);
      } else if (receipt.state === 'not_sent') {
        store({ attempt: { ...attempt, state: 'not_sent' } });
        setStatus('已确认原请求未发送；新的登录或取消需要你重新操作。');
      } else setStatus('原账户操作仍待确认。不能自动重登；可继续查询或明确重启服务。');
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    const changed = () => {
      if (owned()) setIdentity({ ...record });
    };
    window.addEventListener(changedEvent, changed);
    return () => {
      mounted.current = false;
      handoffRead.current++;
      window.removeEventListener(changedEvent, changed);
    };
  }, [owner]);
  useEffect(() => {
    if (!connected) {
      clearCode();
      store({ loginId: '', attempt: undefined, restartRequired: false });
      setStatus('连接已结束，设备码已清除；原生服务撤销交接。不会自动重新登录。');
      setBusy(false);
    }
  }, [connected]);
  useEffect(
    () =>
      api.onAuthenticationLost(() => {
        clearCode();
        store({ loginId: '', attempt: undefined, restartRequired: false });
      }),
    [api],
  );
  useEffect(() => {
    if (connected && record.loginId) void readHandoff();
  }, [connected, owner]);
  useEffect(() => {
    if (!handoff) return;
    const timer = setTimeout(
      () => {
        clearCode();
        if (current()) setStatus('设备码已到期，请读取原登录状态。');
      },
      Math.max(1, Math.min(2147483647, handoff.expiresAt - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [handoff]);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (!current()) return;
        if (
          event.type === 'receipt' &&
          record.attempt &&
          event.data.operationId === record.attempt.id &&
          event.data.method === record.attempt.method &&
          event.data.state === 'accepted'
        ) {
          void reconcileOperation(record.attempt.id, event.data).catch((error) => { if (current()) setError(message(error)); });
          const result = object(event.data.result);
          if (
            (record.attempt.method === 'account/login' && typeof result.loginId !== 'string') ||
            (record.attempt.method === 'account/login/cancel' &&
              !['canceled', 'notFound'].includes(String(result.status)))
          ) {
            setStatus('原操作已受理，等待取得结果身份；可以查询原回执。');
            return;
          }
          void accept(record.attempt, result).catch((e) => {
            if (current()) setError(message(e));
          });
        }
        if (event.type !== 'notification') return;
        const params = object(event.data.params);
        if (event.data.method === 'account/login/completed' && typeof params.loginId === 'string') {
          completions.current.set(params.loginId, {
            success: params.success === true,
            ...(typeof params.error === 'string' ? { error: params.error } : {}),
          });
          while (completions.current.size > 16)
            completions.current.delete(completions.current.keys().next().value!);
          if (record.loginId === params.loginId)
            finishLogin(
              params.success === true
                ? '账户登录成功，正在核对原生状态。'
                : String(params.error ?? '账户登录未完成。'),
            );
        }
        if (event.data.method === 'account/updated') account.refresh();
        if (event.data.method === 'account/rateLimits/updated') limits.refresh();
      }),
    [events, owner, connected],
  );
  const details = object(account.data?.account),
    disabled =
      !connected ||
      !enabled ||
      busy ||
      Boolean(operations.error) ||
      unresolved ||
      pending ||
      restartRequired;
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>ChatGPT 账户</h3>
        <button
          className="button small"
          disabled={!connected || busy}
          onClick={() => {
            account.refresh();
            limits.refresh();
            if (record.loginId) void readHandoff();
          }}
        >
          重新读取账户与登录状态
        </button>
      </div>
      {account.loading ? (
        <p role="status">读取账户中…</p>
      ) : account.error ? (
        <p role="alert" className="error">
          {account.error}
        </p>
      ) : (
        <div className="info-card">
          <strong>
            {String(
              details.email ?? details.name ?? (account.data?.account ? '已登录' : '尚未登录'),
            )}
          </strong>
          <p className="muted">
            {String(
              details.planType ??
                details.type ??
                '使用设备码完成登录；设备码只在当前连接内存中展示。',
            )}
          </p>
        </div>
      )}
      {(operations.error || error) && (
        <p role="alert" className="error">
          {operations.error || error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {!enabled && <p className="small muted">账户变更需要已连接且全局空闲。</p>}
      {unresolved && (
        <p className="workspace-warning">有操作结果待确认。查询原回执，不会自动重登或重发。</p>
      )}
      {identity.attempt && (pending || restartRequired) && (
        <div className="workspace-warning">
          <p>
            原操作：{identity.attempt.id}。
            {!identity.loginId &&
              '尚未取得登录 ID 时，不能取消未知登录；可查询原回执或明确重启服务。'}
          </p>
          <button className="button" disabled={!connected || busy} onClick={() => void recover()}>
            查询原账户操作回执
          </button>
          {onServiceSettings && (
            <button className="button small" onClick={onServiceSettings}>
              前往服务管理恢复
            </button>
          )}
        </div>
      )}
      {handoff && (
        <div className="device-login">
          <p>打开验证页面，输入设备码；打开链接不代表登录成功：</p>
          <code>{handoff.userCode}</code>
          <a
            href={handoff.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="button primary"
          >
            打开验证页面 ↗
          </a>
          <p className="small">有效至 {new Date(handoff.expiresAt).toLocaleString()}</p>
        </div>
      )}
      {identity.loginId && (
        <button
          className="button"
          disabled={disabled}
          onClick={() => void perform('account/login/cancel')}
        >
          取消原设备码登录
        </button>
      )}
      <div className="inline">
        <button
          className="button primary"
          disabled={disabled || Boolean(identity.loginId)}
          onClick={() => void perform('account/login')}
        >
          使用 ChatGPT 登录
        </button>
        <button
          className="button"
          disabled={disabled || Boolean(identity.loginId) || !account.data?.account}
          onClick={() => void perform('account/logout')}
        >
          退出模型账户
        </button>
      </div>
      <h3>用量与限额</h3>
      {limits.loading && <p role="status">读取用量中…</p>}
      {limits.error ? (
        <p className="error">{limits.error}</p>
      ) : (
        <pre className="raw">{JSON.stringify(limits.data, null, 2)}</pre>
      )}
    </section>
  );
}
