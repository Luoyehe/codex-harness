import { useCallback, useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import type { Events } from '../lib/events';
import { useOperations } from '../components/Recovery';
import { message, object } from '../lib/types';
import { listOperations } from '../lib/operations';
export function useWorkflow(
  api: Api,
  threadId: string,
  enabled: boolean,
  onChanged: () => void,
  scopeKey = '',
) {
  const owner = useRef({ api, threadId, scopeKey });
  if (
    owner.current.api !== api ||
    owner.current.threadId !== threadId ||
    owner.current.scopeKey !== scopeKey
  )
    owner.current = { api, threadId, scopeKey };
  const scope = owner.current,
    initial = { owner: scope, busy: false, error: '', notice: '', submittedId: '' };
  const operations = useOperations(),
    [state, setState] = useState(initial);
  const { busy, error, notice, submittedId } = state.owner === scope ? state : initial;
  const running = useRef<object | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && owner.current === scope;
  const update = (patch: Partial<typeof initial>) => {
    if (current())
      setState((previous) => ({ ...(previous.owner === scope ? previous : initial), ...patch }));
  };
  const operation = operations.operations.find((op) => op.id === submittedId);
  const observedAccepted = useRef('');
  useEffect(() => {
    if (operation?.state === 'accepted' && observedAccepted.current !== operation.id) {
      observedAccepted.current = operation.id;
      update({ error: '', notice: '原操作回执已确认受理，正在重新读取状态。' });
      onChanged();
    }
  }, [operation?.id, operation?.state, onChanged]);
  const pending = operations.operations.some(
    (op) =>
      (op.threadId === threadId || op.id === submittedId) &&
      ['pending', 'unknown'].includes(op.state),
  );
  const run = async (
    method: string,
    params: Record<string, unknown>,
    accepted = '操作已受理，正在重新读取状态。',
  ) => {
    if (!current() || running.current === scope || !enabled || pending || operations.error)
      return undefined;
    running.current = scope;
    update({ busy: true, error: '', notice: '' });
    try {
      const result = await api.mutate(method, params);
      if (current()) {
        update({ notice: accepted });
        onChanged();
        return result;
      }
      return undefined;
    } catch (e) {
      if (!current()) return undefined;
      if (e instanceof RpcError && e.operationId) {
        update({ submittedId: e.operationId });
        try {
          const proof = (await listOperations()).find((op) => op.id === e.operationId);
          if (!current()) return undefined;
          if (proof?.state === 'accepted') {
            update({ notice: '原操作回执已确认受理，正在重新读取状态。' });
            onChanged();
            if (proof.resolvedThreadId)
              return {
                thread: { id: proof.resolvedThreadId },
                reviewThreadId: proof.resolvedThreadId,
              };
            if (!['thread/fork', 'review/startNew'].includes(method)) return {};
          }
        } catch {
          /* Preserve the original failure and visible recovery record. */
        }
      }
      update({ error: message(e) });
      return undefined;
    } finally {
      if (running.current === scope) running.current = null;
      update({ busy: false });
    }
  };
  return {
    run,
    busy,
    operation,
    scope,
    isCurrent: current,
    disabled: !enabled || busy || pending || Boolean(operations.error),
    error: operations.error || error,
    notice: pending ? '有操作结果待确认，请先查询页面上方的回执。' : notice,
  };
}
export function useWorkflowRevision(events: Events, threadId: string) {
  const [revision, setRevision] = useState(0),
    refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (event.type === 'receipt') {
          refresh();
          return;
        }
        const params = object(event.data.params),
          method = String(event.data.method ?? '');
        if (
          params.threadId === threadId &&
          (/^thread\/(queue|goal|status)\//.test(method) ||
            ['turn/started', 'turn/completed'].includes(method))
        )
          refresh();
      }),
    [events, threadId, refresh],
  );
  return { revision, refresh };
}
