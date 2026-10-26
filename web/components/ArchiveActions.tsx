export function ArchiveActions({
  archived,
  busy,
  onChange,
}: {
  archived: boolean | undefined;
  busy: boolean;
  onChange: (archived: boolean) => void;
}) {
  return (
    <>
      {archived === undefined && (
        <p className="small muted">会话归档状态未同步，请明确选择目标状态。</p>
      )}
      {archived !== true && (
        <button disabled={busy} onClick={() => onChange(true)}>
          归档会话
        </button>
      )}
      {archived !== false && (
        <button disabled={busy} onClick={() => onChange(false)}>
          {archived === undefined ? '恢复已归档会话' : '恢复会话'}
        </button>
      )}
    </>
  );
}
