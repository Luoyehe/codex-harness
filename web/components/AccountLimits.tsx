import { object } from '../lib/types';

export function AccountLimits({ value }: { value: unknown }) {
  const root = object(value), fallback = object(root.rateLimits);
  const limits = Object.entries(object(root.rateLimitsByLimitId));
  const rows = limits.length ? limits : Object.keys(fallback).length ? [['default', fallback] as const] : [];
  return <div className="stack">
    {rows.map(([id, raw]) => {
      const limit = object(raw), credits = object(limit.credits);
      return <div className="info-card" key={id}>
        <strong>{String(limit.limitName ?? limit.limitId ?? '账户配额')}</strong>
        {typeof limit.planType === 'string' && <p>套餐：{limit.planType}</p>}
        {(['primary', 'secondary'] as const).map((key, index) => {
          const window = object(limit[key]);
          if (!Object.keys(window).length) return null;
          const reset = typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000) : null;
          return <p key={key}>
            {typeof window.windowDurationMins === 'number' ? `${window.windowDurationMins} 分钟窗口` : `配额窗口 ${index + 1}`}：
            {typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? `已用 ${window.usedPercent}%` : '用量未提供'}
            {reset && Number.isFinite(reset.getTime()) ? `；重置于 ${reset.toLocaleString('zh-CN')}` : ''}
          </p>;
        })}
        {credits.unlimited === true ? <p>点数：不限额</p> : typeof credits.balance === 'string' ? <p>点数余额：{credits.balance}</p> : null}
        {limit.spendControlReached === true && <p className="workspace-warning">已达到支出控制上限。</p>}
      </div>;
    })}
    {!rows.length && <p className="muted">服务暂未提供可摘要的用量字段。</p>}
    <details><summary>原始用量详情</summary><pre className="raw">{JSON.stringify(value, null, 2)}</pre></details>
  </div>;
}
