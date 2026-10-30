export type ModelPagination = {
  loading: boolean;
  error: string;
  warning: string;
  hasMore: boolean;
  more: () => Promise<void>;
  refresh: () => void;
};

export function ModelDirectoryStatus({
  directory,
  enabled = true,
}: {
  directory?: ModelPagination;
  enabled?: boolean;
}) {
  if (!directory) return null;
  return (
    <div className="stack">
      {directory.error && (
        <p className="error" role="alert">{directory.error}</p>
      )}
      {directory.warning && (
        <p className="workspace-warning" role="status">{directory.warning}</p>
      )}
      {directory.loading && (
        <p className="small muted" role="status">正在读取模型目录…</p>
      )}
      <div className="inline wrap">
        {directory.hasMore && (
          <button
            type="button"
            className="button small"
            disabled={!enabled || directory.loading}
            onClick={() => void directory.more()}
          >
            加载更多模型
          </button>
        )}
        <button
          type="button"
          className="button small"
          disabled={!enabled || directory.loading}
          onClick={directory.refresh}
        >
          重新读取模型目录
        </button>
      </div>
    </div>
  );
}
