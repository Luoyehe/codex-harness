import { useState } from 'react';
import type { Api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { message, object } from '../lib/types';
import { ReceiptMaintenance } from './ReceiptMaintenance';

// The deployed manager serializes its transactions, including reads. Share this
// queue across remounts so two page reads cannot race for the same manager lock.
const reads = new WeakMap<Api, Promise<unknown>>();
function readManager(
  api: Api,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) {
  const pending = (reads.get(api) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      if (signal.aborted) throw new DOMException('Read cancelled', 'AbortError');
      // Once dispatched, let the read settle: aborting fetch does not release the
      // server's transaction lock. The resource hook still discards stale results.
      return api.call(method, params, AbortSignal.timeout(30_000));
    });
  reads.set(api, pending);
  void pending
    .finally(() => {
      if (reads.get(api) === pending) reads.delete(api);
    })
    .catch(() => {});
  return pending;
}

export function AdminSettings({ api, epoch }: { api: Api; epoch: string }) {
  const [logService, setLogService] = useState('gateway');
  const status = useResource(epoch, (signal) => readManager(api, 'system/status', {}, signal));
  const logs = useResource(`${epoch}:${logService}`, (signal) =>
    readManager(api, 'system/logs', { service: logService, lines: 100 }, signal),
  );
  const usage = object(status.data?.journalUsage);
  const https = object(status.data?.https);
  const certificate = object(https.certificate);
  const renewal = object(https.renewal);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [restart, setRestart] = useState(false);
  return (
    <section className="stack">
      <div className="section-heading">
        <h3>服务状态</h3>
        <button className="button" disabled={status.loading} onClick={status.refresh}>
          刷新状态
        </button>
      </div>
      {status.loading && <p role="status">读取服务状态…</p>}
      {status.error && (
        <p className="error" role="alert">
          {status.error}
        </p>
      )}
      {https.configured === true && (
        <div className="info-card stack" aria-label="HTTPS 状态">
          <h3>HTTPS 与证书</h3>
          <p>{https.ready === true ? '服务器上的 HTTPS 和实例身份验证通过。' : 'HTTPS 验证未通过，请查看 HTTPS 与证书日志。'}</p>
          {typeof certificate.notAfter === 'string' && <p>证书有效期至：{certificate.notAfter}</p>}
          {typeof certificate.daysRemaining === 'number' && certificate.daysRemaining < 14 && <p className="error">证书将在两周内到期，请确认续期是否正常。</p>}
          <p>{renewal.automatic === true ? '由 Caddy 自动管理证书；未来续期仍依赖网络和证书服务可用。' : renewal.automatic === false && renewal.manager === 'operator' ? '证书由管理员提供，需要自行更新。' : '证书管理方式尚未确认，请检查配置。'}</p>
          <p className="muted">此检查来自服务器本机。公网访问请再用手机移动网络等外部网络确认。</p>
        </div>
      )}
      <pre className="raw">{JSON.stringify(status.data, null, 2)}</pre>
      <div className="section-heading">
        <h3>最近日志</h3>
        <label>
          服务
          <select aria-label="日志服务" value={logService} onChange={(event) => setLogService(event.target.value)}>
            <option value="gateway">网页与账号</option>
            <option value="worker">任务运行</option>
            <option value="caddy">HTTPS 与证书</option>
          </select>
        </label>
        <button className="button" disabled={logs.loading} onClick={logs.refresh}>
          刷新日志
        </button>
      </div>
      {logs.loading && <p role="status">读取日志…</p>}
      {logs.error && (
        <p className="error" role="alert">
          {logs.error}
        </p>
      )}
      <pre className="raw log-output">
        {typeof logs.data === 'string'
          ? logs.data
          : typeof logs.data?.text === 'string'
            ? logs.data.text
            : JSON.stringify(logs.data, null, 2)}
      </pre>
      {typeof usage.receipts === 'number' && typeof usage.receiptCountLimit === 'number' && (
        <div className="info-card stack" aria-label="当前回执容量">
          <h3>当前回执容量</h3>
          <p>
            回执 {usage.receipts.toLocaleString()} / {usage.receiptCountLimit.toLocaleString()} 条
          </p>
          {typeof usage.receiptBytes === 'number' && typeof usage.receiptByteLimit === 'number' && (
            <p>
              已用 {(usage.receiptBytes / 1048576).toFixed(1)} /{' '}
              {(usage.receiptByteLimit / 1048576).toFixed(1)} MiB
            </p>
          )}
          {typeof usage.automationRuns === 'number' &&
            typeof usage.automationRunLimit === 'number' && (
              <p>
                自动化运行记录 {usage.automationRuns} / {usage.automationRunLimit}{' '}
                条；已完成记录自动循环保留，未知记录保留待核对。
              </p>
            )}
        </div>
      )}
      <ReceiptMaintenance api={api} onChanged={status.refresh} />
      <div className="info-card">
        <h3>重启服务</h3>
        <p className="muted">
          重启会终止本实例仍在运行的任务和终端，并断开当前连接。未知操作不会重放；重启完成后仍需核对历史与回执。
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={restart}
            onChange={(event) => setRestart(event.target.checked)}
          />
          我确认终止本实例运行中的任务和终端，并重启服务
        </label>
        <button
          className="button danger"
          disabled={!restart || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api.mutate('system/restart');
              setRestart(false);
              status.refresh();
            } catch (error) {
              setError(message(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '正在提交…' : '终止任务并重启服务'}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
