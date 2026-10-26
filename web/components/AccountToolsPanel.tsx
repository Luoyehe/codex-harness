import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { object, safeUrl } from '../lib/types';
import { useResource } from '../hooks/useResource';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';
import { CreditNudge } from './CreditNudge';

type Credit = {
  id: string;
  title: string | null;
  description: string | null;
  expiresAt: number | null;
  status: string;
};
type Preview = {
  previewHash: string;
  redeemable: boolean;
  accountId: string | null;
  summary: { availableCount: number; credits: Credit[] | null } | null;
};
type Gateway = {
  providerId: string;
  providerName: string;
  required: boolean;
  status: string | null;
  error: string | null;
  restartRequired?: boolean;
};
const outcomes: Record<string, string> = {
  reset: '原生服务已确认重置额度。',
  nothingToReset: '当前没有需要重置的额度。',
  noCredit: '原生服务报告没有可用重置次数。',
  alreadyRedeemed: '此重置次数已经使用，不会重复兑换。',
};

function AccountToolsSession({
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
  const action = useExtensionAction(api, enabled && connected, onChanged),
    [revision, setRevision] = useState(0),
    key = `${epoch}:${action.revision}:${revision}`;
  const credits = useResource(key, (signal) =>
      api.call<Preview>('account/resetCredit/preview', {}, signal),
    ),
    gateway = useResource(key, (signal) =>
      api.call<Gateway>('account/gatewayOAuth/read', {}, signal),
    );
  const verification = useResource(key, (signal) =>
    api.call<{
      credentialId: string | null;
      unavailableReason: string | null;
      unavailableMessage: string | null;
    }>('userVerification/status', {}, signal),
  );
  const [creditId, setCreditId] = useState(''),
    [confirmCredit, setConfirmCredit] = useState(false),
    [creditHash, setCreditHash] = useState(''),
    [outcome, setOutcome] = useState('');
  const [confirmGateway, setConfirmGateway] = useState(false),
    [provider, setProvider] = useState(''),
    [handoffId, setHandoffId] = useState('');
  const handoff = useResource(
    `${key}:${connected}:${handoffId}`,
    (signal) =>
      api.call<{ status: string; expiresAt: number; authUrl?: string; error?: string }>(
        'account/gatewayOAuth/handoff',
        { handoffId },
        signal,
      ),
    connected && Boolean(handoffId),
  );
  const completedId = action.operation?.state === 'accepted' ? action.operation.id : '';
  useEffect(
    () =>
      events.subscribe((event) => {
        if (
          event.type === 'notification' &&
          [
            'account/gatewayOAuth/changed',
            'account/updated',
            'account/rateLimits/updated',
          ].includes(String(event.data.method))
        )
          setRevision((value) => value + 1);
      }),
    [events],
  );
  useEffect(() => {
    if (!connected) {
      setHandoffId('');
      setConfirmGateway(false);
      setConfirmCredit(false);
    }
  }, [connected]);
  useEffect(() => {
    if (!handoff.data) return;
    const remaining = handoff.data.expiresAt - Date.now();
    const timer = setTimeout(
      () => {
        setHandoffId('');
        setRevision((value) => value + 1);
      },
      Number.isSafeInteger(handoff.data.expiresAt) ? Math.max(0, Math.min(600000, remaining)) : 0,
    );
    return () => clearTimeout(timer);
  }, [handoff.data]);
  useEffect(() => {
    if (!completedId || !connected) return;
    const controller = new AbortController();
    void api.call('operation/read', { operationId: completedId }, controller.signal).then(
      (receipt) => {
        if (
          controller.signal.aborted ||
          receipt.operationId !== completedId ||
          receipt.state !== 'accepted'
        )
          return;
        const result = object(receipt.result);
        if (receipt.method === 'account/gatewayOAuth/login' && typeof result.handoffId === 'string')
          setHandoffId(result.handoffId);
        if (receipt.method === 'account/resetCredit/consume' && typeof result.outcome === 'string')
          setOutcome(outcomes[result.outcome] ?? '回执包含未知的原生结果，请核对账户状态。');
      },
      () => {},
    );
    return () => controller.abort();
  }, [api, completedId, connected]);
  const authUrl = safeUrl(handoff.data?.authUrl),
    creditList = credits.data?.summary?.credits ?? [];
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>账号能力与网关登录</h3>
        <button className="button small" onClick={() => setRevision((value) => value + 1)}>
          重新读取账号能力
        </button>
      </div>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原账号操作回执" />
      <details className="info-card">
        <summary>执行服务器的原生身份验证能力</summary>
        <div className="stack">
          <ReadState {...verification} />
          {verification.data && (
            <>
              <p>
                {verification.data.unavailableReason
                  ? `原生服务当前不可用：${verification.data.unavailableReason}`
                  : '原生服务报告本机验证器就绪。'}
                {verification.data.unavailableMessage
                  ? ` ${verification.data.unavailableMessage}`
                  : ''}
              </p>
              <p className="muted">
                此状态来自执行服务器，不是浏览器所在电脑的指纹或系统认证。网页不代替设备持有人登记或签名；需要本机用户在原生客户端完成支持的验证流程。
              </p>
            </>
          )}
        </div>
      </details>
      <details className="info-card">
        <summary>明确使用一次额度重置</summary>
        <div className="stack">
          <p>
            这会使用当前账号已有的一次重置权益，不会购买额度。不会自动触发；实际结果由原生服务确认。发生未知结果时只查询原回执，不创建第二次兑换。
          </p>
          <ReadState {...credits} />
          {credits.data?.summary ? (
            <p>可用重置次数：{credits.data.summary.availableCount}</p>
          ) : (
            credits.data && (
              <p className="muted">原生服务未提供重置权益信息，不能按零次或可用推断。</p>
            )
          )}
          {creditList.length > 0 && (
            <label className="field">
              选择重置权益
              <select
                value={creditId}
                onChange={(e) => {
                  setCreditId(e.target.value);
                  setConfirmCredit(false);
                }}
              >
                <option value="">由原生服务选择下一个可用权益</option>
                {creditList.map((credit) => (
                  <option
                    key={credit.id}
                    value={credit.id}
                    disabled={credit.status !== 'available'}
                  >
                    {credit.title ?? credit.id}
                    {credit.expiresAt
                      ? ` · ${new Date(credit.expiresAt * 1000).toLocaleString()}到期`
                      : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {creditId && creditList.find((credit) => credit.id === creditId)?.description && (
            <p>{creditList.find((credit) => credit.id === creditId)!.description}</p>
          )}
          {credits.data && !credits.data.redeemable && (
            <p className="muted">
              当前没有可核对账号身份和可用权益的兑换条件。可重新读取或到账号服务核对。
            </p>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmCredit && creditHash === credits.data?.previewHash}
              onChange={(e) => {
                setConfirmCredit(e.target.checked);
                setCreditHash(credits.data?.previewHash ?? '');
              }}
            />
            确认使用当前账号的一次重置权益
          </label>
          <button
            className="button"
            disabled={
              action.disabled ||
              !credits.data?.redeemable ||
              !confirmCredit ||
              creditHash !== credits.data?.previewHash ||
              Boolean(
                creditId &&
                  !creditList.some(
                    (credit) => credit.id === creditId && credit.status === 'available',
                  ),
              )
            }
            onClick={async () => {
              const result = await action.run(
                'account/resetCredit/consume',
                {
                  previewHash: credits.data!.previewHash,
                  ...(creditId ? { creditId } : {}),
                  confirm: true,
                },
                '已收到原生兑换回执，请核对具体结果与最新额度。',
              );
              if (result) {
                setConfirmCredit(false);
                setOutcome(
                  outcomes[String(result.outcome)] ?? '回执已受理，具体结果请查询原回执。',
                );
              }
            }}
          >
            使用一次重置
          </button>
          {outcome && <p role="status">{outcome}</p>}
        </div>
      </details>
      <CreditNudge api={api} enabled={enabled} connected={connected} epoch={epoch} />
      <details className="info-card">
        <summary>供应商网关 OAuth</summary>
        <div className="stack">
          <ReadState {...gateway} />
          {gateway.data && (
            <>
              <p>当前供应商：{gateway.data.providerName}</p>
              <p>
                {gateway.data.required
                  ? `原生网关认证状态：${gateway.data.status ?? '未提供'}`
                  : '当前供应商不要求此种网关 OAuth。ChatGPT 设备码登录仍在账号区。'}
              </p>
              {gateway.data.error && <p className="error">{gateway.data.error}</p>}
            </>
          )}
          {gateway.data?.restartRequired && (
            <p role="status" className="workspace-warning">
              此原生服务的授权接力已结束。原生通知不包含登录编号；请先在服务设置中重启原生服务，再开始新的授权，避免把延迟到达的链接交给新连接。
            </p>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmGateway && provider === gateway.data?.providerId}
              onChange={(e) => {
                setConfirmGateway(e.target.checked);
                setProvider(gateway.data?.providerId ?? '');
              }}
            />
            确认开始当前供应商的网关授权流程
          </label>
          <button
            className="button"
            disabled={
              action.disabled ||
              !gateway.data?.required ||
              gateway.data.restartRequired ||
              !confirmGateway ||
              provider !== gateway.data.providerId ||
              Boolean(handoffId)
            }
            onClick={async () => {
              const result = await action.run(
                'account/gatewayOAuth/login',
                { providerId: gateway.data!.providerId, confirm: true },
                '授权流程已启动；打开链接不代表登录成功。',
              );
              if (typeof result?.handoffId === 'string') {
                setHandoffId(result.handoffId);
                setConfirmGateway(false);
              }
            }}
          >
            开始网关授权
          </button>
          {handoffId && (
            <div className="stack">
              <ReadState {...handoff} />
              {handoff.data && <p role="status">授权状态：{handoff.data.status}</p>}
              {authUrl?.startsWith('https:') && (
                <a className="button primary" href={authUrl} target="_blank" rel="noreferrer">
                  打开此连接的网关授权链接 ↗
                </a>
              )}
              {handoff.data?.error && <p className="error">{handoff.data.error}</p>}
              <p className="small muted">
                授权链接仅对当前网页连接开放，不写入浏览器持久存储。断线会撤销这次接力；最多保留 10
                分钟。
              </p>
              <p className="workspace-warning">
                原生 OAuth 需要浏览器可达执行服务器上的 loopback
                回调。如果浏览器在另一台机器，请先将授权链接中 redirect_uri 的 loopback 端口通过 SSH
                转发到执行服务器同一端口。此流程没有设备码备用方式；不要把回调改成其他地址。
              </p>
              <button
                className="button"
                disabled={action.disabled}
                onClick={async () => {
                  if (
                    await action.run(
                      'account/gatewayOAuth/cancel',
                      { handoffId },
                      '授权流程取消已确认。',
                    )
                  )
                    setHandoffId('');
                }}
              >
                取消或结束此授权流程
              </button>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
export function AccountToolsPanel(props: {
  api: Api;
  events: Events;
  epoch: string;
  connectionId: string;
  enabled: boolean;
  connected: boolean;
  onChanged: () => void;
}) {
  return <AccountToolsSession key={`${props.epoch}:${props.connectionId}`} {...props} />;
}
