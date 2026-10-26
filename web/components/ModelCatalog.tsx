import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { useExtensionAction } from './ExtensionControls';
import { isArchivedReceipt, reconcileOperation } from '../lib/operations';
import { array, message, object } from '../lib/types';
type CatalogRow = {
  id: string;
  defaultEffort: string | null;
  efforts: string[];
  effortsText: string;
  inputModalities: string[];
  contextWindow: number | null;
  supportsTools: boolean;
  instructions: string;
  selected: boolean;
};
const defaultInstructions =
  'Assist the user with the requested task. Follow their instructions and respect tool approval decisions.';
const unchanged = () => {};
type CatalogIntent = {
  kind: 'discover' | 'apply';
  scope: object;
  previousOperationId?: string;
  resolved: boolean;
};
const row = (value: unknown): CatalogRow => {
  const v = object(value);
  return {
    id: String(v.id ?? ''),
    defaultEffort: typeof v.defaultEffort === 'string' ? v.defaultEffort : null,
    efforts: array<string>(v.efforts),
    effortsText: array<string>(v.efforts).join(', '),
    inputModalities: array<string>(v.inputModalities).length
      ? array<string>(v.inputModalities)
      : ['text'],
    contextWindow: typeof v.contextWindow === 'number' ? v.contextWindow : null,
    supportsTools: v.supportsTools === true,
    instructions: typeof v.instructions === 'string' ? v.instructions : defaultInstructions,
    selected: false,
  };
};
export function ModelCatalog({
  api,
  provider,
  onApplied,
  enabled = true,
}: {
  api: Api;
  provider: Record<string, unknown>;
  onApplied: () => void;
  enabled?: boolean;
}) {
  const [rows, setRows] = useState<CatalogRow[]>([]),
    [manual, setManual] = useState(''),
    [query, setQuery] = useState(''),
    [visible, setVisible] = useState(30),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  // Discovery is a preview. Refreshing the provider here would unmount this editor.
  const action = useExtensionAction(
    api,
    enabled,
    unchanged,
    JSON.stringify([provider.kind, provider.revision]),
  );
  const intent = useRef<CatalogIntent | undefined>(undefined),
    running = useRef<CatalogIntent | undefined>(undefined);
  const current = (request: CatalogIntent) =>
    intent.current === request && request.scope === action.scope && action.isCurrent();
  const accept = (request: CatalogIntent, result: Record<string, unknown>) => {
    if (!current(request) || request.resolved) return;
    if (result.kind !== provider.kind || typeof result.revision !== 'string')
      throw new Error('目录回执缺少匹配的供应商身份。');
    if (request.kind === 'apply') {
      if (result.applied !== true || result.requiresConfirmation !== false)
        throw new Error('目录应用尚未取得明确的应用证明，未刷新供应商配置。');
      request.resolved = true;
      setRows([]);
      setConfirmed(false);
      setStatus('已应用确认的模型目录。');
      onApplied();
      return;
    }
    if (
      result.revision !== provider.revision ||
      result.applied !== false ||
      !['native', 'provider'].includes(String(result.source)) ||
      result.requiresConfirmation !== (result.source === 'provider')
    )
      throw new Error('发现结果与当前配置版本不匹配，请重新读取供应商配置。');
    if (result.source === 'native') {
      request.resolved = true;
      setStatus('当前使用原生模型目录，无需应用自定义目录。');
      return;
    }
    if (!Array.isArray(result.models) || result.models.length > 1000)
      throw new Error('发现目录无效或超过 1,000 个模型的界面上限。');
    const existing = new Map(
      array<unknown>(provider.models).map((v) => [String(object(v).id), v]),
    );
    setRows(result.models.map((v) => row(existing.get(String(object(v).id)) ?? v)));
    setConfirmed(false);
    setStatus(`发现 ${result.models.length} 个模型 ID，尚未应用。`);
    request.resolved = true;
  };
  const operation = action.operation,
    recoverable = Boolean(
      intent.current &&
        !intent.current.resolved &&
        intent.current.scope === action.scope &&
        operation &&
        operation.id !== intent.current.previousOperationId &&
        ['pending', 'unknown', 'accepted'].includes(operation.state),
    );
  const run = async (kind: CatalogIntent['kind'], models?: Record<string, unknown>[]) => {
    if (running.current || action.disabled || recoverable) return;
    const request: CatalogIntent = {
      kind,
      scope: action.scope,
      previousOperationId: operation?.id,
      resolved: false,
    };
    intent.current = request;
    running.current = request;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await action.run(
        'system/models/refresh',
        {
          expectedRevision: provider.revision,
          ...(kind === 'apply' ? { models, confirmCapabilities: true } : {}),
        },
        '目录请求已受理，正在核对结果。',
      );
      if (result) accept(request, result);
    } catch (e) {
      if (current(request)) setError(message(e));
    } finally {
      if (running.current === request) running.current = undefined;
      if (current(request)) setBusy(false);
    }
  };
  const recover = async () => {
    const request = intent.current;
    if (!request || !operation || !recoverable || running.current || !current(request)) return;
    running.current = request;
    setBusy(true);
    setError('');
    try {
      const receipt = await api.call('operation/read', { operationId: operation.id });
      if (
        receipt.operationId !== operation.id ||
        (receipt.state !== 'not_received' &&
          receipt.method !== 'system/models/refresh' &&
          !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
          !isArchivedReceipt(receipt))
      )
        throw new Error('目录操作回执身份不匹配。');
      reconcileOperation(operation.id, receipt);
      if (!current(request)) return;
      if (receipt.state === 'accepted') accept(request, object(receipt.result));
      else if (receipt.state === 'not_sent') {
        request.resolved = true;
        setStatus('已确认原目录请求未发送；再次操作需要你明确选择。');
      } else setStatus('原目录请求仍待确认，不能重复发现或应用。');
    } catch (e) {
      if (current(request)) setError(message(e));
    } finally {
      if (running.current === request) running.current = undefined;
      if (current(request)) setBusy(false);
    }
  };
  const editingDisabled = busy || action.disabled || recoverable,
    selected = rows.filter((r) => r.selected),
    matching = rows.filter((r) => r.id.toLowerCase().includes(query.toLowerCase()));
  const change = (id: string, patch: Partial<CatalogRow>) => {
    if (editingDisabled) return;
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setConfirmed(false);
  };
  return (
    <section className="stack">
      <h3>模型目录与能力</h3>
      {action.notice && (
        <p className="small muted" role="status">
          {action.notice}
        </p>
      )}
      {recoverable && (
        <div className="workspace-warning">
          <p>原目录结果待核对。查询只读取原回执，不会重复发现或应用。</p>
          <button className="button small" disabled={busy} onClick={() => void recover()}>
            查询原目录操作回执
          </button>
        </div>
      )}
      <p className="muted">
        从已保存配置读取模型
        ID。目录发现不会证明工具调用、图片、音频或推理参数可用；请按供应商文档核对后再应用。
      </p>
      <div className="inline">
        <button
          type="button"
          className="button"
          disabled={editingDisabled}
          onClick={() => void run('discover')}
        >
          {busy ? '正在读取…' : '发现模型'}
        </button>
      </div>
      {['responses', 'zhipu-coding'].includes(String(provider.kind)) && (
        <>
          <div className="field">
            <label htmlFor="catalog-manual-id">手动添加模型 ID</label>
            <div className="inline">
              <input
                id="catalog-manual-id"
                disabled={editingDisabled}
                value={manual}
                onChange={(e) => {
                  if (!editingDisabled) setManual(e.target.value);
                }}
              />
              <button
                className="button"
                type="button"
                disabled={editingDisabled || !manual.trim() || rows.length >= 1000}
                onClick={() => {
                  if (!rows.some((r) => r.id === manual.trim()))
                    setRows((current) => [...current, row({ id: manual.trim() })]);
                  setManual('');
                }}
              >
                添加
              </button>
            </div>
          </div>
          {rows.length > 0 && (
            <label className="field">
              筛选目录
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisible(30);
                }}
              />
            </label>
          )}
          {matching.slice(0, visible).map((r) => (
            <fieldset key={r.id} disabled={editingDisabled}>
              <legend>
                <label className="check-row">
                  <input
                    type="checkbox"
                    disabled={editingDisabled}
                    checked={r.selected}
                    onChange={(e) => change(r.id, { selected: e.target.checked })}
                  />
                  {r.id}
                </label>
              </legend>
              {r.selected && (
                <div className="stack">
                  <label className="field">
                    {r.id}：原生默认推理强度
                    <input
                      value={r.defaultEffort ?? ''}
                      onChange={(e) => change(r.id, { defaultEffort: e.target.value || null })}
                      placeholder="未知或不支持时留空"
                    />
                  </label>
                  <label className="field">
                    {r.id}：允许覆盖的推理强度
                    <input
                      value={r.effortsText}
                      onChange={(e) => change(r.id, { effortsText: e.target.value })}
                      placeholder="按逗号分隔；不支持时留空"
                    />
                  </label>
                  <label className="field">
                    {r.id}：上下文窗口
                    <input
                      type="number"
                      min={4096}
                      max={10000000}
                      value={r.contextWindow ?? ''}
                      onChange={(e) =>
                        change(r.id, {
                          contextWindow: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      placeholder="未知时留空"
                    />
                  </label>
                  <div className="inline">
                    {['image', 'audio'].map((modality) => (
                      <label className="check-row" key={modality}>
                        <input
                          type="checkbox"
                          checked={r.inputModalities.includes(modality)}
                          onChange={(e) =>
                            change(r.id, {
                              inputModalities: e.target.checked
                                ? [...r.inputModalities, modality]
                                : r.inputModalities.filter((v) => v !== modality),
                            })
                          }
                        />
                        {modality === 'image' ? '支持图片输入' : '支持音频输入'}
                      </label>
                    ))}
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={r.supportsTools}
                      onChange={(e) => change(r.id, { supportsTools: e.target.checked })}
                    />
                    支持工具调用
                  </label>
                  <label className="field">
                    {r.id}：模型基础指令
                    <textarea
                      value={r.instructions}
                      onChange={(e) => change(r.id, { instructions: e.target.value })}
                      rows={3}
                    />
                  </label>
                </div>
              )}
            </fieldset>
          ))}
          {matching.length > visible && (
            <button
              className="button small"
              type="button"
              onClick={() => setVisible((v) => v + 30)}
            >
              显示更多模型
            </button>
          )}
          {rows.length > 0 && (
            <>
              <label className="check-row">
                <input
                  type="checkbox"
                  disabled={editingDisabled}
                  checked={confirmed}
                  onChange={(e) => {
                    if (!editingDisabled) setConfirmed(e.target.checked);
                  }}
                />
                我已核对选中模型的能力；应用后将重启运行时。
              </label>
              <button
                className="button primary"
                type="button"
                disabled={!confirmed || !selected.length || editingDisabled}
                onClick={() => {
                  const models = selected.map(
                    ({ selected: _selected, effortsText, ...model }) => ({
                      ...model,
                      efforts: effortsText
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    }),
                  );
                  void run('apply', models);
                }}
              >
                应用 {selected.length} 个确认的模型
              </button>
            </>
          )}
        </>
      )}
      {(error || action.error) && (
        <p className="error" role="alert">
          {error || action.error}
        </p>
      )}
      {status && (
        <p className="success" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
