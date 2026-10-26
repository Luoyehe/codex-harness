import { isArchivedReceipt } from '../lib/operations';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ThreadRealtimeListVoicesResponse } from '../../protocol/ts/v2/ThreadRealtimeListVoicesResponse';
import { Api, RpcError } from '../lib/api';
import { Events } from '../lib/events';
import { message, object } from '../lib/types';
import { reconcileOperation } from '../lib/operations';
import { RealtimeMedia } from '../lib/realtime-media';
import { useResource } from '../hooks/useResource';
import { useOperations } from './Recovery';
type Snapshot = {
  sessionHandle: string;
  threadId: string;
  state: 'starting' | 'active' | 'stopping' | 'closed';
  nextSequence: number;
  lastAcceptedSequence: number;
  sdp?: string;
  reason?: string;
};
type Attempt = {
  operationId: string;
  method: 'thread/realtime/start' | 'thread/realtime/stop';
  state: 'pending' | 'unknown' | 'accepted' | 'not_sent';
};
type Caption = { id: string; role: string; text: string };
export type RealtimePanelProps = {
  api: Api;
  events: Events;
  epoch: string;
  lease: string;
  connected: boolean;
  threadId: string;
  threadReady: boolean;
  threadIdle: boolean;
  onStarted(threadId: string): void;
  onClosed(threadId: string): void;
  onChanged?(): void;
};
function snapshot(value: unknown, threadId: string): Snapshot {
  const row = object(value);
  if (
    row.threadId !== threadId ||
    typeof row.sessionHandle !== 'string' ||
    !row.sessionHandle ||
    !['starting', 'active', 'stopping', 'closed'].includes(String(row.state)) ||
    !Number.isSafeInteger(row.nextSequence) ||
    Number(row.nextSequence) < 0 ||
    !Number.isSafeInteger(row.lastAcceptedSequence)
  )
    throw new Error('语音会话身份或状态无效，请查询原操作回执。');
  return row as Snapshot;
}
export function RealtimePanel(props: RealtimePanelProps) {
  const owner = useRef({
    api: props.api,
    epoch: props.epoch,
    lease: props.lease,
    threadId: props.threadId,
    visit: 0,
  });
  if (
    owner.current.api !== props.api ||
    owner.current.epoch !== props.epoch ||
    owner.current.lease !== props.lease ||
    owner.current.threadId !== props.threadId
  ) {
    owner.current = {
      api: props.api,
      epoch: props.epoch,
      lease: props.lease,
      threadId: props.threadId,
      visit: owner.current.visit + 1,
    };
  }
  return <OwnedRealtimePanel key={owner.current.visit} {...props} />;
}
function OwnedRealtimePanel(props: RealtimePanelProps) {
  const { api, events, epoch, lease, connected, threadId, threadReady, threadIdle } = props;
  const key = `${epoch}:${lease}:${threadId}`,
    [state, setState] = useState<Snapshot>(),
    [attempt, setAttempt] = useState<Attempt>();
  const [mode, setMode] = useState<'audio' | 'text'>('audio'),
    [version, setVersion] = useState(''),
    [voice, setVoice] = useState(''),
    [model, setModel] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [text, setText] = useState(''),
    [muted, setMuted] = useState(false),
    [captions, setCaptions] = useState<Caption[]>([]),
    [dropped, setDropped] = useState(false);
  const textRevision = useRef(0);
  const audio = useRef<HTMLAudioElement>(null),
    media = useRef<RealtimeMedia | undefined>(undefined),
    native = useRef<Snapshot | undefined>(undefined),
    intent = useRef<Attempt | undefined>(undefined),
    running = useRef(false),
    wanted = useRef(false),
    mounted = useRef(false),
    inputBlocked = useRef(false),
    closing = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const owner = useRef({ key, connected });
  owner.current = { key, connected };
  const started = useRef(''),
    closed = useRef(''),
    operations = useOperations();
  const voices = useResource(
    `${epoch}:${lease}`,
    (signal) =>
      api.call<ThreadRealtimeListVoicesResponse>('thread/realtime/listVoices', {}, signal),
    connected,
  );
  const choices = voices.data?.voices,
    voiceChoices = version
      ? (choices?.[version as 'v1' | 'v2' | 'v3'] ?? [])
      : [...new Set([...(choices?.v1 ?? []), ...(choices?.v2 ?? []), ...(choices?.v3 ?? [])])];
  const current = () => mounted.current && owner.current.key === key && owner.current.connected;
  const owned = () => owner.current.key === key && owner.current.connected;
  const release = () => {
    media.current?.close();
    media.current = undefined;
  };
  const updateAttempt = (value: Attempt) => {
    intent.current = value;
    if (current()) setAttempt({ ...value });
  };
  const stoppingAttempt = () => intent.current?.method === 'thread/realtime/stop';
  const accept = (value: unknown) => {
    const next = snapshot(value, threadId),
      old = native.current;
    if (old && old.sessionHandle !== next.sessionHandle && old.state !== 'closed')
      throw new Error('语音会话标识发生冲突，已暂停输入。');
    if (old?.sessionHandle === next.sessionHandle) {
      if (old.state === 'closed') next.state = 'closed';
      else if (old.state === 'active' && next.state === 'starting') next.state = 'active';
      next.nextSequence = Math.max(old.nextSequence, next.nextSequence);
    }
    native.current = next;
    if (current()) setState({ ...next });
    // Retired owners still finish native cleanup and receipts, but cannot notify a new visit.
    if (next.state === 'closed') {
      release();
      wanted.current = false;
      if (closed.current !== next.sessionHandle) {
        closed.current = next.sessionHandle;
        if (current()) latest.current.onClosed(threadId);
      }
    } else if (started.current !== next.sessionHandle) {
      started.current = next.sessionHandle;
      if (current()) latest.current.onStarted(threadId);
    }
    if (typeof next.sdp === 'string' && media.current && next.state !== 'closed')
      void media.current.accept(next.sdp).catch((e) => {
        release();
        if (current()) {
          inputBlocked.current = true;
          setError(message(e));
        }
      });
    return next;
  };
  const read = async (handle = native.current?.sessionHandle) => {
    if (!handle || !owned()) return;
    const result = await api.call('thread/realtime/read', { sessionHandle: handle });
    if (current()) accept(result);
    return result;
  };
  const stop = async () => {
    wanted.current = false;
    release();
    inputBlocked.current = true;
    const entry = native.current;
    if (
      !entry ||
      entry.state === 'closed' ||
      !owned() ||
      closing.current ||
      (intent.current?.method === 'thread/realtime/stop' &&
        ['pending', 'unknown'].includes(intent.current.state))
    )
      return;
    closing.current = true;
    if (current()) {
      setBusy(true);
      setError('');
    }
    let request: ReturnType<Api['beginMutation']> | undefined;
    try {
      request = api.beginMutation('thread/realtime/stop', { sessionHandle: entry.sessionHandle });
      updateAttempt({
        operationId: request.operationId,
        method: 'thread/realtime/stop',
        state: 'pending',
      });
      const result = await request.result;
      if (owned()) {
        updateAttempt({
          operationId: request.operationId,
          method: 'thread/realtime/stop',
          state: 'accepted',
        });
        accept(result);
      }
    } catch (e) {
      if (owned()) {
        if (request)
          updateAttempt({
            operationId: request.operationId,
            method: 'thread/realtime/stop',
            state: e instanceof RpcError && e.delivery === 'not_sent' ? 'not_sent' : 'unknown',
          });
        if (current())
          setError(`${message(e)} 麦克风已在本机关闭，服务端是否结束请查询原回执或读取状态。`);
      }
    } finally {
      closing.current = false;
      if (current()) setBusy(false);
    }
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useLayoutEffect(() => {
    mounted.current = true;
    native.current = undefined;
    intent.current = undefined;
    wanted.current = false;
    inputBlocked.current = false;
    started.current = '';
    closed.current = '';
    setState(undefined);
    setAttempt(undefined);
    setCaptions([]);
    setDropped(false);
    setError('');
    setBusy(false);
    setMuted(false);
    return () => {
      mounted.current = false;
      wanted.current = false;
      release();
      if (owner.current.connected && owner.current.key === key) void stopRef.current();
    };
  }, [key]);
  useEffect(() => {
    if (!connected) {
      wanted.current = false;
      inputBlocked.current = true;
      release();
      setState(undefined);
      setCaptions([]);
      setError('连接已结束，麦克风已关闭。原生会话由服务端清理；不会自动恢复或重放输入。');
    }
  }, [connected]);
  useEffect(
    () =>
      api.onAuthenticationLost(() => {
        wanted.current = false;
        inputBlocked.current = true;
        release();
      }),
    [api],
  );
  useEffect(
    () =>
      events.subscribe((event) => {
        if (
          !current() ||
          event.type !== 'realtime' ||
          event.data.owned !== true ||
          event.data.threadId !== threadId ||
          (!intent.current && !native.current)
        )
          return;
        if (native.current && event.data.sessionHandle !== native.current.sessionHandle) return;
        try {
          accept(event.data);
          const params = object(event.data.params),
            method = String(event.data.method);
          if (method.endsWith('/sdp') && typeof params.sdp === 'string' && media.current)
            void media.current.accept(params.sdp).catch((e) => {
              release();
              if (current()) {
                inputBlocked.current = true;
                setError(message(e));
              }
            });
          if (method.endsWith('/error'))
            setError(String(params.message ?? '原生语音报告错误').slice(0, 4096));
          const item = object(params.item),
            delta = typeof params.delta === 'string' ? params.delta : undefined;
          if (
            method.includes('/transcript/') ||
            (method.endsWith('/item/completed') && item.type === 'transcriptSegment')
          ) {
            const id =
              typeof params.itemId === 'string'
                ? params.itemId
                : typeof item.id === 'string'
                  ? item.id
                  : `live:${String(params.role ?? 'voice')}`;
            const role = String(params.role ?? item.role ?? 'voice'),
              final =
                typeof params.text === 'string'
                  ? params.text
                  : typeof item.text === 'string'
                    ? item.text
                    : undefined;
            setCaptions((rows) => {
              const old = rows.find((row) => row.id === id),
                next = [
                  ...rows.filter((row) => row.id !== id),
                  { id, role, text: (final ?? `${old?.text ?? ''}${delta ?? ''}`).slice(-8192) },
                ];
              if ((final?.length ?? (old?.text.length ?? 0) + (delta?.length ?? 0)) > 8192)
                setDropped(true);
              while (next.length > 64 || next.reduce((n, row) => n + row.text.length, 0) > 32768) {
                next.shift();
                setDropped(true);
              }
              return next;
            });
          }
          if (!wanted.current && native.current?.state !== 'closed') void stopRef.current();
        } catch (e) {
          inputBlocked.current = true;
          release();
          setError(message(e));
        }
      }),
    [events, key],
  );
  const start = async () => {
    if (
      !connected ||
      !threadReady ||
      !threadIdle ||
      running.current ||
      (native.current && native.current.state !== 'closed') ||
      operations.error ||
      operations.operations.some((op) => ['pending', 'unknown'].includes(op.state))
    )
      return;
    running.current = true;
    wanted.current = true;
    inputBlocked.current = false;
    native.current = undefined;
    intent.current = undefined;
    setState(undefined);
    setAttempt(undefined);
    setBusy(true);
    setError('');
    setCaptions([]);
    setDropped(false);
    setMuted(false);
    let request: ReturnType<Api['beginMutation']> | undefined,
      accepted = false;
    try {
      let transport: Record<string, unknown> = { type: 'websocket' };
      if (mode === 'audio') {
        const active = new RealtimeMedia(audio.current!, (value, fatal) => {
          if (current()) {
            setError(value);
            if (fatal) {
              inputBlocked.current = true;
              void stopRef.current().finally(() => {
                if (current()) setError(value);
              });
            }
          }
        });
        media.current = active;
        transport = { type: 'webrtc', sdp: await active.offer() };
      }
      if (!current() || !wanted.current) {
        release();
        return;
      }
      request = api.beginMutation('thread/realtime/start', {
        threadId,
        outputModality: mode,
        transport,
        ...(version ? { version } : {}),
        ...(voice ? { voice } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      updateAttempt({
        operationId: request.operationId,
        method: 'thread/realtime/start',
        state: 'pending',
      });
      const result = await request.result;
      accepted = true;
      if (!owned()) {
        release();
        return;
      }
      if (!stoppingAttempt())
        updateAttempt({
          operationId: request.operationId,
          method: 'thread/realtime/start',
          state: 'accepted',
        });
      const row = accept(result);
      if (!wanted.current || !mounted.current) await stop();
      else await read(row.sessionHandle);
    } catch (e) {
      release();
      inputBlocked.current = true;
      if (owned()) {
        if (request && !accepted && !stoppingAttempt())
          updateAttempt({
            operationId: request.operationId,
            method: 'thread/realtime/start',
            state: e instanceof RpcError && e.delivery === 'not_sent' ? 'not_sent' : 'unknown',
          });
        if (current())
          setError(
            `${message(e)}${request && !accepted && !(e instanceof RpcError && e.delivery === 'not_sent') ? ' 不会再次启动；请查询原启动回执。' : ''}`,
          );
      }
    } finally {
      running.current = false;
      if (current()) setBusy(closing.current);
    }
  };
  const recover = async () => {
    if (!attempt || busy || !current()) return;
    setBusy(true);
    setError('');
    try {
      const receipt = await api.call('operation/read', { operationId: attempt.operationId });
      if (!current()) return;
      if (
        receipt.operationId !== attempt.operationId ||
        (receipt.state !== 'not_received' &&
          receipt.method !== attempt.method &&
          !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
          !isArchivedReceipt(receipt))
      )
        throw new Error('语音原操作回执不匹配。');
      reconcileOperation(attempt.operationId, receipt);
      if (receipt.state === 'accepted') {
        updateAttempt({ ...attempt, state: 'accepted' });
        const row = accept(receipt.result);
        await read(row.sessionHandle);
        if (!wanted.current) await stop();
      } else if (receipt.state === 'not_sent') {
        updateAttempt({ ...attempt, state: 'not_sent' });
        if (attempt.method === 'thread/realtime/start') wanted.current = false;
      } else setError('原操作仍待确认，未重复发送。');
    } catch (e) {
      if (current()) setError(message(e));
    } finally {
      if (current()) setBusy(false);
    }
  };
  const send = async () => {
    const row = native.current,
      input = text.trim();
    if (
      !current() ||
      busy ||
      running.current ||
      inputBlocked.current ||
      row?.state !== 'active' ||
      !input
    )
      return;
    if (new TextEncoder().encode(input).length > 16384) {
      setError('实时文字超过 16 KiB 上限。');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    const sequence = row.nextSequence,
      submittedRevision = textRevision.current;
    try {
      const result = await api.call('thread/realtime/appendText', {
        sessionHandle: row.sessionHandle,
        sequence,
        text: input,
        role: 'user',
      });
      if (!current()) return;
      if (
        result.sessionHandle !== row.sessionHandle ||
        result.sequence !== sequence ||
        result.accepted !== true ||
        !Number.isSafeInteger(result.nextSequence)
      )
        throw new Error('实时输入确认无效。');
      row.nextSequence = Math.max(row.nextSequence, Number(result.nextSequence));
      if (textRevision.current === submittedRevision) {
        textRevision.current++;
        setText('');
      }
      await read(row.sessionHandle);
    } catch (e) {
      if (current()) {
        inputBlocked.current = true;
        release();
        setError(`${message(e)} 本段文字未重发。请读取状态后明确结束本次会话。`);
      }
    } finally {
      running.current = false;
      if (current()) setBusy(false);
    }
  };
  const pending = attempt && ['pending', 'unknown'].includes(attempt.state),
    active = state && state.state !== 'closed';
  const disabled =
    !connected ||
    !threadReady ||
    !threadIdle ||
    busy ||
    Boolean(active) ||
    Boolean(pending) ||
    Boolean(operations.error) ||
    operations.operations.some((op) => ['pending', 'unknown'].includes(op.state));
  return (
    <section className="stack realtime-panel">
      <div className="section-heading">
        <h3>实时语音</h3>
        <span className="badge">{state?.state ?? '未启动'}</span>
      </div>
      <p className="small muted">
        启动后语音服务可使用当前会话上下文和已授权工具。语音期间暂停普通输入；结束并完整重读历史后恢复。关闭页面或切换会话会关闭麦克风并请求结束，不会自动重连。
      </p>
      <audio ref={audio} autoPlay controls aria-label="语音播放" />
      {!active && (
        <>
          <label className="field">
            实时会话方式
            <select
              value={mode}
              disabled={busy || Boolean(pending)}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="audio">麦克风与语音播放（WebRTC）</option>
              <option value="text">仅文字实时会话</option>
            </select>
          </label>
          {mode === 'audio' && !RealtimeMedia.supported() && (
            <p className="workspace-warning">
              此环境缺少安全上下文、WebRTC 或麦克风支持。请使用 HTTPS 支持的浏览器，或选择仅文字。
            </p>
          )}
          <details>
            <summary>语音版本、声音与模型</summary>
            <div className="stack">
              <label className="field">
                实时协议版本
                <select
                  value={version}
                  disabled={busy}
                  onChange={(event) => {
                    setVersion(event.target.value);
                    setVoice('');
                  }}
                >
                  <option value="">原生配置默认</option>
                  {(['v1', 'v2', 'v3'] as const)
                    .filter((value) => choices?.[value])
                    .map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                </select>
              </label>
              <label className="field">
                声音
                <select
                  value={voice}
                  disabled={busy || !choices}
                  onChange={(event) => setVoice(event.target.value)}
                >
                  <option value="">原生配置默认</option>
                  {voiceChoices.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                实时模型（留空使用原生配置）
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  maxLength={256}
                  disabled={busy}
                />
              </label>
              {voices.error && <p className="error">{voices.error}</p>}
              <p className="small muted">
                声音目录不代表账号或当前供应商支持实时会话；启动时显示原生返回的实际可用性。
              </p>
            </div>
          </details>
          <button
            className="button primary"
            disabled={disabled || (mode === 'audio' && !RealtimeMedia.supported())}
            onClick={() => void start()}
          >
            启动一次{mode === 'audio' ? '语音' : '实时文字'}
          </button>
        </>
      )}
      {(busy || active) && (
        <div className="inline wrap">
          <button
            className="button danger"
            disabled={!connected || closing.current}
            onClick={() => {
              wanted.current = false;
              release();
              if (native.current) void stop();
              else setError('启动已取消，麦克风已关闭；如服务端受理，将立即请求停止。');
            }}
          >
            结束本次实时会话
          </button>
          {mode === 'audio' && active && (
            <>
              <button
                className="button"
                onClick={() => {
                  const next = !muted;
                  media.current?.mute(next);
                  setMuted(next);
                }}
              >
                {muted ? '开启麦克风' : '静音麦克风'}
              </button>
              <button
                className="button"
                onClick={() => void audio.current?.play().catch((e) => setError(message(e)))}
              >
                播放语音
              </button>
            </>
          )}
        </div>
      )}
      {state && (
        <button
          className="button small"
          disabled={!connected || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await read();
            } catch (e) {
              if (current()) setError(message(e));
            } finally {
              if (current()) setBusy(false);
            }
          }}
        >
          读取当前语音状态
        </button>
      )}
      {pending && (
        <button className="button" disabled={!connected || busy} onClick={() => void recover()}>
          查询原语音操作回执
        </button>
      )}
      {state?.state === 'active' && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="field">
            发送到当前实时会话
            <textarea
              value={text}
              onChange={(event) => {
                textRevision.current++;
                setText(event.target.value);
              }}
              maxLength={16384}
              rows={2}
            />
          </label>
          <button
            className="button"
            disabled={!connected || busy || inputBlocked.current || !text.trim()}
          >
            发送一次实时文字
          </button>
        </form>
      )}
      {(error || operations.error) && (
        <p className="error" role="alert">
          {error || operations.error}
        </p>
      )}
      {captions.length > 0 && (
        <div className="stack" aria-label="本次实时转录预览">
          {captions.map((row) => (
            <p key={row.id}>
              <strong>{row.role}：</strong>
              {row.text}
            </p>
          ))}
        </div>
      )}
      {dropped && <p className="workspace-warning">实时预览已截断，结束后请以完整历史为准。</p>}
    </section>
  );
}
