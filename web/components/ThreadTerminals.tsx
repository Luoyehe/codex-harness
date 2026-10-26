import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Api } from '../lib/api';
import type { Events } from '../lib/events';
import { object } from '../lib/types';
import { usePaged } from '../hooks/usePaged';
import { ExtensionStatus, ReadState, useExtensionAction } from './ExtensionControls';

type NativeTerminal = {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | string | null;
};
const checkedRows = (rows: NativeTerminal[]) => {
  const seen = new Set<string>();
  for (const value of rows) {
    const row = object(value);
    if (
      ['itemId', 'processId', 'command', 'cwd'].some((field) => typeof row[field] !== 'string') ||
      !row.itemId ||
      !row.processId ||
      seen.has(String(row.processId)) ||
      (row.osPid !== null && (!Number.isSafeInteger(row.osPid) || Number(row.osPid) < 1)) ||
      (row.cpuPercent !== null &&
        (typeof row.cpuPercent !== 'number' ||
          !Number.isFinite(row.cpuPercent) ||
          row.cpuPercent < 0)) ||
      (row.rssKb !== null &&
        !(
          (typeof row.rssKb === 'number' && Number.isSafeInteger(row.rssKb) && row.rssKb >= 0) ||
          (typeof row.rssKb === 'string' && /^\d{1,24}$/.test(row.rssKb))
        ))
    )
      return '原生后台终端目录无效，请重新读取。';
    seen.add(String(row.processId));
  }
  return '';
};
function TerminalRow({
  row,
  scope,
  disabled,
  onTerminate,
  onLocate,
}: {
  row: NativeTerminal;
  scope: object;
  disabled: boolean;
  onTerminate: () => void;
  onLocate: () => void;
}) {
  const [confirmation, setConfirmation] = useState<{ row: NativeTerminal; scope: object }>();
  const confirm = confirmation?.row === row && confirmation.scope === scope;
  const setConfirm = (value: boolean) => setConfirmation(value ? { row, scope } : undefined);
  return (
    <article className="info-card stack">
      <div className="section-heading">
        <strong>原生进程 {row.processId}</strong>
        <button className="button small" onClick={onLocate}>
          定位命令历史
        </button>
      </div>
      <p className="small path">工作目录：{row.cwd}</p>
      <pre className="raw">{row.command}</pre>
      <p className="small muted">
        系统 PID：{row.osPid ?? '未提供'} · CPU：
        {row.cpuPercent === null ? '未提供' : `${row.cpuPercent}%`} · 内存：
        {row.rssKb === null ? '未提供' : `${row.rssKb} KiB`}
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
        />
        确认终止这个原生后台进程
      </label>
      <button
        className="button danger small"
        disabled={disabled || !confirm}
        onClick={() => {
          setConfirm(false);
          onTerminate();
        }}
      >
        终止此后台进程
      </button>
    </article>
  );
}
export function ThreadTerminals({
  api,
  events,
  epoch,
  threadId,
  connected,
  enabled,
  idle,
  onChanged,
  onLocate,
  onChat,
}: {
  api: Api;
  events: Events;
  epoch: string;
  threadId: string;
  connected: boolean;
  enabled: boolean;
  idle: boolean;
  onChanged: () => void;
  onLocate: (itemId: string) => void;
  onChat?: () => void;
}) {
  const [revision, setRevision] = useState(0),
    [draft, setDraft] = useState({ threadId, text: '', revision: 0 }),
    [timeout, setTimeoutMinutes] = useState('60'),
    [consentOwner, setConsentOwner] = useState<object>(),
    [cleanProof, setCleanProof] = useState<{
      scope: object;
      key: string;
      items: NativeTerminal[];
    }>(),
    [noticeState, setNoticeState] = useState<{ scope: object; text: string }>();
  const scope = useMemo(() => ({}), [api, epoch, threadId, connected]);
  const command = draft.threadId === threadId ? draft.text : '',
    consent = consentOwner === scope;
  const setConsent = (value: boolean) => setConsentOwner(value ? scope : undefined);
  const editCommand = (text: string) => {
    setDraft((previous) => ({ threadId, text, revision: previous.revision + 1 }));
    setConsent(false);
  };
  const editTimeout = (value: string) => {
    setTimeoutMinutes(value);
    setDraft((previous) => ({ ...previous, revision: previous.revision + 1 }));
    setConsent(false);
  };
  const notice = noticeState?.scope === scope ? noticeState.text : '',
    setNotice = (text: string) => setNoticeState({ scope, text });
  const key = `${epoch}:${threadId}:${revision}`,
    directory = usePaged<NativeTerminal>(
      api,
      'thread/backgroundTerminals/list',
      { threadId },
      key,
      connected,
    );
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const changed = useCallback(() => {
    refresh();
    onChanged();
  }, [refresh, onChanged]);
  const action = useExtensionAction(
    api,
    connected && enabled,
    changed,
    JSON.stringify([epoch, threadId, connected]),
  );
  const validation = checkedRows(directory.items),
    ready =
      connected &&
      directory.snapshotKey === key &&
      !directory.loading &&
      !directory.error &&
      !validation;
  const cleanupReady = ready && !directory.hasMore && !action.disabled;
  const clean =
    cleanupReady &&
    cleanProof?.scope === scope &&
    cleanProof.key === key &&
    cleanProof.items === directory.items;
  const setClean = (value: boolean) =>
    setCleanProof(value && cleanupReady ? { scope, key, items: directory.items } : undefined);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type !== 'notification' || object(event.data.params).threadId !== threadId)
          return;
        if (
          [
            'item/started',
            'item/completed',
            'turn/completed',
            'turn/started',
            'thread/closed',
          ].includes(String(event.data.method))
        )
          refresh();
      }),
    [events, threadId, refresh],
  );
  const terminate = async (row: NativeTerminal) => {
    if (!ready || !directory.items.includes(row) || action.disabled) return;
    setNotice('');
    const result = await action.run(
      'thread/backgroundTerminals/terminate',
      { threadId, processId: row.processId },
      '终止请求已受理，正在重新读取原生后台进程。',
    );
    if (result !== undefined)
      setNotice(
        result.terminated === true
          ? '原生服务报告已终止该进程；请核对刷新后的列表。'
          : result.terminated === false
            ? '原生服务未报告终止成功，进程可能已结束；请核对刷新后的列表。'
            : '原终止请求已受理，具体终止结果未取得；请重新读取列表。',
      );
  };
  const minutes = Number(timeout),
    validTimeout =
      /^\d+$/.test(timeout) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 120;
  const run = async () => {
    if (
      action.disabled ||
      !idle ||
      !consent ||
      !command.trim() ||
      new TextEncoder().encode(command).length > 65536 ||
      !validTimeout
    )
      return;
    const submitted = command,
      submittedDraft = draft;
    setNotice('');
    setConsent(false);
    const result = await action.run(
      'thread/shellCommand',
      { threadId, command: submitted, timeoutMs: minutes * 60000, confirmUnsandboxed: true },
      '会话命令已提交，请在历史中查看输出和最终状态；受理不代表完成。',
    );
    if (result !== undefined) {
      setDraft((current) =>
        current === submittedDraft
          ? { ...current, text: '', revision: current.revision + 1 }
          : current,
      );
      setNotice('命令已受理，尚不代表执行完成。请在当前会话历史中查看输出、退出状态与停止入口。');
    }
  };
  return (
    <section className="stack">
      <div className="section-heading">
        <h2>会话命令与 Agent 后台终端</h2>
        {onChat && (
          <button className="button small" onClick={onChat}>
            返回会话与输出
          </button>
        )}
      </div>
      <p className="small muted">
        这里是原生会话创建的后台进程，与浏览器的项目终端、一次性进程面板不同。进程身份来自当前会话目录；这里只按发现的原生进程
        ID 操作。
      </p>
      <ExtensionStatus api={api} action={action} recoveryLabel="查询原会话终端操作回执" />
      {notice && <p role="status">{notice}</p>}
      {!enabled && (
        <p className="connection-banner">
          操作前需要会话已加载且完整历史就绪。未知操作须先核对原回执。
        </p>
      )}
      <div className="section-heading">
        <h3>原生后台进程</h3>
        <button
          className="button small"
          disabled={!connected || directory.loading}
          onClick={refresh}
        >
          刷新后台进程
        </button>
      </div>
      <ReadState {...directory} />
      {validation && (
        <p className="error" role="alert">
          {validation}
        </p>
      )}
      {!validation &&
        directory.items.map((row) => (
          <TerminalRow
            key={JSON.stringify(row)}
            row={row}
            scope={scope}
            disabled={!ready || action.disabled}
            onTerminate={() => void terminate(row)}
            onLocate={() => onLocate(row.itemId)}
          />
        ))}
      {ready && !directory.items.length && !directory.hasMore && (
        <p className="muted">当前会话没有原生后台终端。</p>
      )}
      {directory.hasMore && (
        <button
          className="button"
          disabled={directory.loading}
          onClick={() => void directory.more()}
        >
          加载更多后台进程
        </button>
      )}
      <details className="info-card">
        <summary>清理这个会话的所有原生后台终端</summary>
        <div className="stack">
          <p>
            此操作作用于原生服务执行清理时的整个会话，包括刚产生而未显示的后台进程。不会操作其他会话或浏览器项目终端。清理请求受理后仍要读取列表核对。
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              disabled={!cleanupReady}
              checked={clean}
              onChange={(event) => setClean(event.target.checked)}
            />
            确认清理当前会话的所有原生后台终端
          </label>
          <button
            className="button danger"
            disabled={action.disabled || !ready || directory.hasMore || !clean}
            onClick={async () => {
              if (!cleanupReady || !clean) return;
              setClean(false);
              if (
                await action.run(
                  'thread/backgroundTerminals/clean',
                  { threadId, confirm: true },
                  '清理请求已受理，正在重新读取；不代表所有进程已清理完成。',
                )
              )
                setClean(false);
            }}
          >
            清理所有原生后台终端
          </button>
          {directory.hasMore && <p className="small muted">请先加载当前目录的剩余页面。</p>}
        </div>
      </details>
      <details className="info-card">
        <summary>在当前会话运行一次 shell 命令</summary>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <p>
            该命令以原生服务的完整权限执行，绕过当前会话的模型审批与沙箱。输出和执行结果写入会话历史；不是向模型发送指令。
          </p>
          <label className="field">
            会话 shell 命令
            <textarea
              rows={4}
              value={command}
              maxLength={65536}
              onChange={(event) => editCommand(event.target.value)}
            />
          </label>
          <label className="field">
            最长运行时间（分钟，1–120）
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={timeout}
              onChange={(event) => editTimeout(event.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            确认以原生完整权限执行以上命令，不使用会话沙箱
          </label>
          {!idle && (
            <p className="small muted">当前会话仍在运行，结束后才能提交一次 shell 命令。</p>
          )}
          <button
            className="button primary"
            disabled={
              action.disabled ||
              !idle ||
              !consent ||
              !command.trim() ||
              new TextEncoder().encode(command).length > 65536 ||
              !validTimeout
            }
          >
            执行此会话 shell 命令
          </button>
        </form>
      </details>
    </section>
  );
}
