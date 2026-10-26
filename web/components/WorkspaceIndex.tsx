import { useCallback, useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { commitState, indexVersions, type CommitState } from '../lib/git-state';
import {
  checkedSnapshot,
  gitStatusLabel,
  validRevision,
  workspacePath,
  type GitEntry,
} from '../lib/workspace';
import { array, message, type Project } from '../lib/types';
import { Diff } from './Messages';
import { ExtensionStatus, useExtensionAction } from './ExtensionControls';
type SelectedFile = {
  path: string;
  expectedRevision: string | null;
  deleted: boolean;
  bytes?: number;
};
type Preview = {
  key: string;
  mode: 'stage' | 'unstage';
  state: CommitState;
  files: SelectedFile[];
  paths: string[];
  diff: string;
};
export function WorkspaceIndex({
  api,
  project,
  epoch,
  entries,
  enabled,
  onChanged,
  onFile,
}: {
  api: Api;
  project: Project;
  epoch: string;
  entries: GitEntry[];
  enabled: boolean;
  onChanged: () => void;
  onFile: (path: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [preview, setPreview] = useState<Preview>(),
    [confirmed, setConfirmed] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  const key = JSON.stringify([project.id, epoch, selected, entries]),
    owner = useRef(key);
  owner.current = key;
  const changed = useCallback(() => {
      setPreview(undefined);
      setConfirmed(false);
      setSelected([]);
      onChanged();
    }, [onChanged]),
    action = useExtensionAction(api, enabled, changed);
  useEffect(() => {
    setPreview(undefined);
    setConfirmed(false);
  }, [key]);
  useEffect(() => {
    if (action.operation?.state === 'not_sent') {
      setPreview(undefined);
      setConfirmed(false);
      onChanged();
    }
  }, [action.operation?.id, action.operation?.state]);
  const current = preview?.key === key ? preview : undefined;
  const inspect = async (mode: 'stage' | 'unstage') => {
    if (reading || !selected.length || action.disabled) return;
    const expected = key;
    setReading(true);
    setError('');
    setPreview(undefined);
    setConfirmed(false);
    try {
      const before = await api.call('workspace/git/status', { projectId: project.id }),
        state = commitState(before),
        rows = array<GitEntry>(before.entries);
      const chosen = selected.map((path) => {
        const row = rows.find((entry) => entry.path === path);
        if (!row) throw new Error('所选文件已不在当前 Git 状态中，请刷新后重新选择。');
        return row;
      });
      const paths = [
        ...new Set(
          chosen.flatMap((row) => (row.originalPath ? [row.originalPath, row.path] : [row.path])),
        ),
      ].map((path) => workspacePath(path));
      if (!paths.length || paths.length > 32)
        throw new Error('一次最多选择 32 个实际文件路径，重命名的原路径也计入。');
      if (mode === 'unstage' && chosen.some((row) => row.index === ' ' || row.index === '?'))
        throw new Error('取消暂存只适用于有暂存修改的条目，请调整选择。');
      const files: SelectedFile[] = [];
      if (mode === 'stage')
        for (const path of paths) {
          try {
            const metadata = checkedSnapshot(
              await api.call('workspace/metadata', { projectId: project.id, path }),
              path,
            );
            if (
              metadata.kind !== 'file' ||
              !validRevision(metadata.revision) ||
              metadata.bytes > 8 * 1024 * 1024
            )
              throw new Error(
                `无法暂存此路径：${path}。只支持具有可核对版本且不超过 8 MiB 的普通文件。`,
              );
            files.push({
              path,
              expectedRevision: metadata.revision,
              deleted: false,
              bytes: metadata.bytes,
            });
          } catch (e) {
            if (e instanceof RpcError && e.code === 'not_found' && e.delivery === 'not_sent')
              files.push({ path, expectedRevision: null, deleted: true });
            else throw e;
          }
        }
      if (files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) > 32 * 1024 * 1024)
        throw new Error('所选文件超过 32 MiB 总上限，请减少选择。');
      const diff = await api.call<{ text: string; staged: boolean; complete: boolean }>(
        'workspace/git/diff',
        { projectId: project.id, staged: mode === 'unstage' },
      );
      const after = commitState(await api.call('workspace/git/status', { projectId: project.id }));
      if (owner.current !== expected) return;
      if (JSON.stringify(state) !== JSON.stringify(after))
        throw new Error('核对期间 HEAD 或索引已变化，请重新读取。');
      if (
        diff.complete !== true ||
        diff.staged !== (mode === 'unstage') ||
        typeof diff.text !== 'string'
      )
        throw new Error('Git Diff 尚未完整读取。');
      setPreview({ key: expected, mode, state, files, paths, diff: diff.text });
    } catch (e) {
      if (owner.current === expected) setError(message(e));
    } finally {
      setReading(false);
    }
  };
  return (
    <section className="stack">
      <ul className="git-status-list">
        {entries.map((entry, index) => (
          <li key={`${entry.path}:${index}`}>
            <input
              type="checkbox"
              aria-label={`选择 ${entry.path}`}
              checked={selected.includes(entry.path)}
              disabled={action.busy}
              onChange={(e) => {
                setSelected((value) =>
                  e.target.checked
                    ? [...value, entry.path]
                    : value.filter((path) => path !== entry.path),
                );
                setConfirmed(false);
              }}
            />
            <button className="button subtle small" onClick={() => onFile(entry.path)}>
              {entry.originalPath && <span>{entry.originalPath} → </span>}
              {entry.path}
            </button>
            <span className="small muted">{gitStatusLabel(entry)}</span>
          </li>
        ))}
      </ul>
      {entries.length === 0 && <p className="muted">当前没有未提交的修改。</p>}
      <div className="inline">
        <span className="small muted">已选择 {selected.length} 项</span>
        <button
          className="button small"
          disabled={action.disabled || reading || !selected.length}
          onClick={() => void inspect('stage')}
        >
          核对并暂存所选文件
        </button>
        <button
          className="button small"
          disabled={action.disabled || reading || !selected.length}
          onClick={() => void inspect('unstage')}
        >
          核对并取消暂存
        </button>
      </div>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原暂存操作回执" />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {reading && <p role="status">正在核对 HEAD、索引和所选文件版本…</p>}
      {current && (
        <div className="info-card stack">
          <h4>
            {current.mode === 'stage'
              ? '将当前文件版本写入暂存区'
              : '将所选路径的索引恢复为 HEAD 版本'}
          </h4>
          <p className="small muted">
            只处理下列路径，不修改工作区文件，不创建提交。重命名会同时处理原路径和新路径。
          </p>
          <ul>
            {current.paths.map((path) => {
              const file = current.files.find((file) => file.path === path);
              return (
                <li key={path} className="path">
                  {path}
                  {file
                    ? file.deleted
                      ? ' · 暂存删除（当前不存在）'
                      : ` · ${file.bytes!.toLocaleString()} 字节`
                    : ''}
                </li>
              );
            })}
          </ul>
          <details>
            <summary>
              核对当前{current.mode === 'stage' ? '工作区' : '暂存区'}完整
              Diff（可能包含未选择条目）
            </summary>
            <p className="small muted">
              未跟踪文件与二进制内容可能不提供文本 Diff；可先打开相应文件核对。
            </p>
            <Diff text={current.diff} />
          </details>
          <label className="check-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            确认以上路径与版本，
            {current.mode === 'stage' ? '暂存当前文件内容或删除' : '只取消这些路径的暂存'}
          </label>
          <button
            className="button primary"
            disabled={action.disabled || !confirmed}
            onClick={() =>
              void action.run(
                `workspace/git/${current.mode}`,
                {
                  projectId: project.id,
                  ...indexVersions(current.state),
                  ...(current.mode === 'stage'
                    ? { files: current.files.map(({ bytes: _bytes, ...file }) => file) }
                    : { paths: current.paths }),
                },
                '索引操作已受理，正在重新读取 Git 状态。',
              )
            }
          >
            {current.mode === 'stage' ? '确认暂存所选版本' : '确认取消所选暂存'}
          </button>
        </div>
      )}
    </section>
  );
}
