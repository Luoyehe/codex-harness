import { useState } from 'react';

export function CompactThreshold({
  contextWindow,
  threshold,
  disabled,
  onChange,
}: {
  contextWindow: unknown;
  threshold: unknown;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [percent, setPercent] = useState('80');
  const windowTokens =
    typeof contextWindow === 'number' || typeof contextWindow === 'string'
      ? Number(contextWindow)
      : NaN;
  const known = Number.isSafeInteger(windowTokens) && windowTokens > 0;
  const value = Number(percent),
    tokens = Math.floor((windowTokens * value) / 100);
  const current = Number(threshold);
  const valid =
    known &&
    percent.trim() !== '' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 100 &&
    tokens > 0;
  return (
    <section className="info-card stack" aria-label="自动压缩阈值换算">
      <h4>自动压缩阈值</h4>
      <p className="small muted">
        由 Codex 原生上下文管理执行自动压缩。下方换算只修改 Token
        阈值草稿，保存配置后才生效；不会创建后台重试任务。留空阈值可恢复原生默认值。统计范围 total
        计算全部上下文，body_after_prefix 计算固定前缀之后的正文；百分比仅作为相对于窗口的换算参考。
      </p>
      {known ? (
        <>
          <p className="small">
            已配置的上下文窗口为 {windowTokens.toLocaleString()} Token。
            {Number.isSafeInteger(current) && current > 0
              ? ` 当前阈值约占 ${((current / windowTokens) * 100).toFixed(1)}%。`
              : ''}
            运行时仍可能预留上下文空间。
          </p>
          <div className="inline wrap">
            <label className="field">
              窗口占比（%）
              <input
                type="number"
                min="0.1"
                max="100"
                step="0.1"
                value={percent}
                disabled={disabled}
                onChange={(event) => setPercent(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="button"
              disabled={disabled || !valid}
              onClick={() => onChange(String(tokens))}
            >
              换算为 Token 阈值
            </button>
            {valid && <span className="small">{tokens.toLocaleString()} Token</span>}
          </div>
        </>
      ) : (
        <p className="small muted">
          尚无明确的模型上下文窗口，不能可靠换算百分比。可以直接填写 Token
          阈值，或先根据供应商规格设置上下文窗口；不会根据模型名称猜测容量。
        </p>
      )}
    </section>
  );
}
