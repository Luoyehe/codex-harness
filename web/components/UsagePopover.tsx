import { useEffect, useRef } from 'react';
import { object } from '../lib/types';

const fields = [
  ['inputTokens', '输入'], ['cachedInputTokens', '缓存读取'],
  ['cacheWriteInputTokens', '缓存写入'], ['outputTokens', '输出'],
  ['reasoningOutputTokens', '推理'], ['totalTokens', '合计'],
] as const;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? new Intl.NumberFormat('zh-CN').format(value) : '—';

export function UsagePopover({ usage }: { usage: unknown }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const data = object(usage), last = object(data.last), total = object(data.total);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <details className="token-usage" ref={ref} onKeyDown={(event) => {
    if (event.key === 'Escape' && ref.current) {
      ref.current.open = false;
      ref.current.querySelector('summary')?.focus();
      event.stopPropagation();
    }
  }}>
    <summary aria-label="查看 Token 用量">用量</summary>
    <section className="usage-popover" aria-label="Token 用量">
      <h3>Token 用量</h3>
      <table>
        <thead><tr><th scope="col">类型</th><th scope="col">最近一轮</th><th scope="col">会话累计</th></tr></thead>
        <tbody>{fields.map(([key, label]) => <tr key={key}>
          <th scope="row">{label}</th><td>{count(last[key])}</td><td>{count(total[key])}</td>
        </tr>)}</tbody>
      </table>
      {typeof data.modelContextWindow === 'number' && <p className="small muted">上下文窗口：{count(data.modelContextWindow)}</p>}
      <p className="small muted">缓存计入输入，推理计入输出；用量不是费用账单。</p>
    </section>
  </details>;
}
