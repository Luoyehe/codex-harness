import type { Model, Options } from '../lib/types';

export function ComposerOptions({
  existingThread,
  options,
  onOptions,
  inheritance,
  inherited,
  efforts,
  onRefreshModels,
  modelsLoading,
  moreModels,
  onMoreModels,
}: {
  existingThread: boolean;
  options: Options;
  onOptions: (value: Options) => void;
  inheritance: string;
  inherited: (key: string) => string;
  efforts: NonNullable<Model['supportedReasoningEfforts']>;
  onRefreshModels?: () => void;
  modelsLoading?: boolean;
  moreModels?: boolean;
  onMoreModels?: () => void;
}) {
  return (
    <div className="composer-options">
      <p className="small muted">
        {existingThread
          ? '未覆盖的选项沿用会话当前设置；已受理的覆盖会继续用于后续回合。'
          : '未覆盖的选项使用项目配置默认值；本次设置会成为新会话的后续设置。'}
      </p>
      <label className="field">
        推理强度
        <select
          value={options.effort ?? ''}
          onChange={(e) => onOptions({ ...options, effort: e.target.value || undefined })}
        >
          <option value="">
            {inheritance}（{inherited('reasoningEffort')}）
          </option>
          {efforts.map((e) => (
            <option key={e.reasoningEffort} value={e.reasoningEffort}>
              {e.reasoningEffort}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        审批策略
        <select
          value={options.approvalPolicy ?? ''}
          onChange={(e) => onOptions({ ...options, approvalPolicy: e.target.value || undefined })}
        >
          <option value="">
            {inheritance}（{inherited('approvalPolicy')}）
          </option>
          <option value="untrusted">仅信任安全操作</option>
          <option value="on-request">模型请求时审批</option>
          <option value="never">不请求审批</option>
        </select>
      </label>
      <label className="field">
        文件访问
        <select
          value={options.sandbox ?? ''}
          onChange={(e) => onOptions({ ...options, sandbox: e.target.value || undefined })}
        >
          <option value="">
            {inheritance}（{inherited('sandbox')}）
          </option>
          <option value="read-only">只读</option>
          <option value="workspace-write">工作目录可写</option>
          <option value="danger-full-access">完整访问</option>
        </select>
      </label>
      <label className="field">
        自定义模型 ID
        <input
          value={options.model ?? ''}
          placeholder="由当前供应商支持的模型"
          onChange={(e) => onOptions({ ...options, model: e.target.value || undefined })}
        />
      </label>
      <div className="inline">
        {onRefreshModels && (
          <button className="button small" disabled={modelsLoading} onClick={onRefreshModels}>
            刷新模型目录
          </button>
        )}
        {moreModels && (
          <button className="button small" disabled={modelsLoading} onClick={onMoreModels}>
            加载更多模型
          </button>
        )}
      </div>
    </div>
  );
}
