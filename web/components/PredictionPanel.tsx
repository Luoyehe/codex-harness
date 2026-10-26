import { isArchivedReceipt } from '../lib/operations';
import { useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import type { Events } from '../lib/events';
import { acknowledgeOperation, reconcileOperation } from '../lib/operations';
import { message, object } from '../lib/types';
import { useOperations } from './Recovery';
type Prediction = {
  operationId: string;
  threadId: string;
  sourceTurnId: string;
  predictionId?: string;
  operationState: 'pending' | 'unknown' | 'accepted' | 'not_sent';
  state?: string;
  text?: string | null;
  error?: string;
};
type Props = {
  api: Api;
  events: Events;
  epoch: string;
  threadId: string;
  sourceTurnId: string;
  connected: boolean;
  enabled: boolean;
  draftEmpty: boolean;
  onInsert: (text: string, sourceTurnId: string) => boolean;
  onChat?: () => void;
  onServiceSettings?: () => void;
};
export function PredictionPanel(props: Props) {
  const { api, events, epoch, threadId, sourceTurnId, connected, enabled, draftEmpty } = props;
  const records = useRef(new Map<string, Prediction>()),
    [, render] = useState(0),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true),
    running = useRef(false);
  const operations = useOperations(),
    unresolved = operations.operations.some((row) => ['pending', 'unknown'].includes(row.state));
  const valid = () =>
    mounted.current && latest.current.connected && !api.externalAuthenticationRequired;
  const update = (record: Prediction, patch: Partial<Prediction>) => {
    if (!valid() || records.current.get(record.threadId) !== record) return;
    Object.assign(record, patch);
    render((value) => value + 1);
  };
  const apply = (record: Prediction, raw: unknown) => {
    const value = object(raw);
    if (
      value.predictionId !== record.predictionId ||
      value.threadId !== record.threadId ||
      value.sourceTurnId !== record.sourceTurnId ||
      !['pending', 'completed', 'failed', 'stale', 'unknown'].includes(String(value.state))
    )
      throw new Error('建议结果身份或状态不匹配。');
    if (
      record.state === 'stale' ||
      (record.state && record.state !== 'pending' && value.state === 'pending') ||
      (['completed', 'failed'].includes(record.state ?? '') && value.state === 'unknown')
    )
      return { ...value, state: record.state };
    const result = object(value.result),
      text = value.state === 'completed' ? result.text : undefined;
    if (
      value.state === 'completed' &&
      (result.type !== 'completed' || (text !== null && typeof text !== 'string'))
    )
      throw new Error('建议正文格式无效。');
    if (typeof text === 'string' && new TextEncoder().encode(text).length > 16 * 1024)
      throw new Error('建议超过本页 16 KiB 展示预算，未放入编辑框。');
    update(record, {
      state: String(value.state),
      text: text as string | null | undefined,
      error: undefined,
    });
    return value;
  };
  const read = async (record: Prediction) => {
    if (!record.predictionId || !valid()) return;
    const result = await api.call('thread/prediction/read', {
      threadId: record.threadId,
      predictionId: record.predictionId,
    });
    if (valid() && records.current.get(record.threadId) === record) return apply(record, result);
  };
  const accepted = async (record: Prediction, raw: unknown) => {
    if (!valid() || records.current.get(record.threadId) !== record) return;
    const value = object(raw);
    update(record, { operationState: 'accepted' });
    if (
      value.threadId !== record.threadId ||
      value.sourceTurnId !== record.sourceTurnId ||
      typeof value.predictionId !== 'string' ||
      !value.predictionId ||
      value.predictionId.length > 256 ||
      value.requested !== true
    ) {
      update(record, { error: '原请求已受理但缺少有效建议身份。只能查询原回执，不能重新生成。' });
      return;
    }
    update(record, { predictionId: value.predictionId });
    await read(record);
  };
  const generate = async () => {
    const p = latest.current,
      previous = records.current.get(p.threadId);
    if (
      running.current ||
      !valid() ||
      !p.enabled ||
      !p.threadId ||
      !p.sourceTurnId ||
      unresolved ||
      operations.error ||
      (previous?.sourceTurnId === p.sourceTurnId && previous.operationState !== 'not_sent')
    )
      return;
    if (!previous && records.current.size >= 20) {
      setError('本次连接已保留 20 个会话的建议身份，不能再创建新记录。已有原操作仍可查询。');
      return;
    }
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    let record: Prediction | undefined;
    try {
      const request = api.beginMutation('thread/prediction/request', {
        threadId: p.threadId,
        sourceTurnId: p.sourceTurnId,
      });
      record = {
        operationId: request.operationId,
        threadId: p.threadId,
        sourceTurnId: p.sourceTurnId,
        operationState: 'pending',
      };
      records.current.set(p.threadId, record);
      render((value) => value + 1);
      const result = await request.result;
      await accepted(record, result);
    } catch (e) {
      if (record)
        update(record, {
          operationState:
            record.operationState === 'accepted'
              ? 'accepted'
              : e instanceof RpcError && e.delivery === 'not_sent'
                ? 'not_sent'
                : 'unknown',
          error: message(e),
        });
      else if (valid()) setError(message(e));
    } finally {
      running.current = false;
      if (valid()) setBusy(false);
    }
  };
  const recover = async (record: Prediction) => {
    if (!valid() || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await api.call('operation/read', { operationId: record.operationId });
      if (!valid() || records.current.get(record.threadId) !== record) return;
      if (
        receipt.operationId !== record.operationId ||
        (receipt.state !== 'not_received' &&
          receipt.method !== 'thread/prediction/request' &&
          !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
          !isArchivedReceipt(receipt))
      )
        throw new Error('原建议操作回执身份不匹配。');
      reconcileOperation(record.operationId, receipt);
      if (receipt.state === 'accepted') {
        await accepted(record, receipt.result);
        acknowledgeOperation(record.operationId);
      } else if (receipt.state === 'not_sent')
        update(record, {
          operationState: 'not_sent',
          error: '已确认原请求未发送；重新生成需要你再次明确操作。',
        });
      else
        update(record, { operationState: 'unknown', error: '原建议请求仍待确认，不能自动重发。' });
    } catch (e) {
      update(record, { error: message(e) });
    } finally {
      running.current = false;
      if (valid()) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      records.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!connected) {
      records.current.clear();
      render((value) => value + 1);
      setBusy(false);
      setNotice('');
      setError('');
    }
  }, [connected]);
  useEffect(
    () =>
      api.onAuthenticationLost(() => {
        records.current.clear();
        render((value) => value + 1);
      }),
    [api],
  );
  useEffect(() => {
    const record = records.current.get(threadId);
    if (record?.predictionId && connected)
      void read(record).catch((e) => update(record, { error: message(e) }));
  }, [epoch, threadId, connected]);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (!valid()) return;
        if (
          event.type === 'receipt' &&
          event.data.method === 'thread/prediction/request' &&
          event.data.state === 'accepted'
        ) {
          const record = [...records.current.values()].find(
            (row) => row.operationId === event.data.operationId,
          );
          if (record && typeof object(event.data.result).predictionId === 'string')
            void accepted(record, event.data.result).catch((e) =>
              update(record, { error: message(e) }),
            );
        }
        if (event.type !== 'prediction' || event.data.owned !== true) return;
        const record = records.current.get(String(event.data.threadId));
        if (
          !record?.predictionId ||
          record.predictionId !== event.data.predictionId ||
          record.sourceTurnId !== event.data.sourceTurnId
        )
          return;
        try {
          apply(record, event.data);
        } catch (e) {
          update(record, { error: message(e) });
        }
      }),
    [events],
  );
  const record = connected ? records.current.get(threadId) : undefined,
    stale = Boolean(record && record.sourceTurnId !== sourceTurnId),
    blocked =
      !connected || !enabled || !sourceTurnId || busy || unresolved || Boolean(operations.error);
  return (
    <section className="stack">
      <div className="section-heading">
        <h2>下一步建议</h2>
        {props.onChat && (
          <button className="button small" onClick={props.onChat}>
            返回聊天
          </button>
        )}
      </div>
      <p className="small muted">
        按官方说明，生成建议不占 Codex 用量或
        credits；发送建议才按正常请求计费。是否可用仍取决于账号、模型和地区，以服务返回为准。仅针对最新已完成回合，每个回合在此运行时最多请求一次。建议不会自动发送；请先放入空白编辑框，审阅修改后再发送。结果只保留在本次连接内。
        <a
          href="https://learn.chatgpt.com/docs/features/composer-predictions"
          target="_blank"
          rel="noreferrer"
        >
          查看官方建议功能说明 ↗
        </a>
      </p>
      {!sourceTurnId && <p className="muted">需要最新回合已完成、会话已加载且空闲后才能生成。</p>}
      <button
        className="button"
        disabled={
          blocked ||
          Boolean(record?.sourceTurnId === sourceTurnId && record.operationState !== 'not_sent')
        }
        onClick={() => void generate()}
      >
        生成下一步建议
      </button>
      {(operations.error || error) && (
        <p className="error" role="alert">
          {operations.error || error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {record && (
        <article className="info-card stack">
          <p className="small path">来源回合：{record.sourceTurnId}</p>
          {record.error && (
            <p className="error" role="alert">
              {record.error}
            </p>
          )}
          {stale || record.state === 'stale' ? (
            <p className="workspace-warning">
              会话上下文已经变化，此建议已过期，不能放入当前编辑框。
            </p>
          ) : record.state === 'completed' ? (
            record.text ? (
              <pre className="raw">{record.text}</pre>
            ) : (
              <p className="muted">原生服务没有返回下一步建议。</p>
            )
          ) : record.state === 'failed' ? (
            <p className="error">原生建议生成失败。不会自动再次请求。</p>
          ) : (
            <p role="status">
              {record.operationState === 'unknown' || record.state === 'unknown'
                ? '建议结果未知，请查询原操作。'
                : record.operationState === 'not_sent'
                  ? '原请求未发送。'
                  : '正在等待原生建议结果。'}
            </p>
          )}
          {(record.operationState === 'pending' ||
            record.operationState === 'unknown' ||
            (record.operationState === 'accepted' && !record.predictionId)) && (
            <button
              className="button"
              disabled={busy || !connected}
              onClick={() => void recover(record)}
            >
              查询原建议请求回执
            </button>
          )}
          {record.state === 'unknown' && (
            <div className="workspace-warning">
              <p>
                原生建议没有取得明确终态；不会重新生成。请核对原状态，必要时在服务管理中明确重启恢复。
              </p>
              {props.onServiceSettings && (
                <button className="button small" onClick={props.onServiceSettings}>
                  前往服务管理恢复建议
                </button>
              )}
            </div>
          )}
          {record.predictionId && (
            <button
              className="button small"
              disabled={busy || !connected}
              onClick={() => void read(record).catch((e) => update(record, { error: message(e) }))}
            >
              读取原建议状态
            </button>
          )}
          {record.state === 'completed' && Boolean(record.text) && (
            <>
              <button
                className="button primary"
                disabled={blocked || stale || !draftEmpty}
                onClick={async () => {
                  if (running.current) return;
                  running.current = true;
                  setBusy(true);
                  try {
                    const result = await read(record);
                    const p = latest.current;
                    if (
                      !result ||
                      result.state !== 'completed' ||
                      !record.text ||
                      p.threadId !== record.threadId ||
                      p.sourceTurnId !== record.sourceTurnId ||
                      !p.enabled ||
                      !p.draftEmpty ||
                      !p.onInsert(record.text, record.sourceTurnId)
                    )
                      setNotice('未写入编辑框：建议已过期或当前已有草稿。原有输入保持不变。');
                    else setNotice('建议已放入编辑框，请审阅后明确发送。');
                  } catch (e) {
                    update(record, { error: message(e) });
                  } finally {
                    running.current = false;
                    if (valid()) setBusy(false);
                  }
                }}
              >
                放入空白编辑框
              </button>
              {!draftEmpty && (
                <p className="small muted">
                  当前已有文字、附件或引用，建议不会覆盖已有草稿。可手动复制需要的内容。
                </p>
              )}
            </>
          )}
        </article>
      )}
    </section>
  );
}
