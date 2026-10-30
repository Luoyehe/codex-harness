import { isArchivedReceipt } from '../lib/operations';
import { useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import {
  displayTime,
  localTime,
  zonedTime,
  type Automation,
  type AutomationSpec,
  type Schedule,
} from '../lib/automations';
import { message, object, type Model, type Options, type Project } from '../lib/types';
import { executionOptions, type CollaborationModeMask } from '../lib/workflows';
import { useResource } from '../hooks/useResource';
import { reconcileOperation } from '../lib/operations';
import { useOperations } from './Recovery';
import { modelSelection } from './ModelPicker';
import { ModelDirectoryStatus, type ModelPagination } from './ModelDirectoryStatus';

const matchesProvider = (model: Model, provider: unknown) =>
  !provider ||
  !model.modelProvider ||
  model.modelProvider === provider ||
  (typeof provider === 'string' && model.providerAliases?.includes(provider));
type Submission = {
  operationId: string;
  revision: number;
  spec: AutomationSpec;
  original?: Automation;
  method: 'automation/create' | 'automation/update';
  at: number;
};
type Draft = {
  revision: number;
  pending?: Submission;
  notice?: string;
  original?: Automation;
  name: string;
  text: string;
  projectId: string;
  kind: Schedule['kind'];
  timeZone: string;
  when: string;
  time: string;
  hours: string;
  days: number[];
  maxRunMinutes: string;
  overrides: Options;
  modeChanged: boolean;
};
type Props = {
  api: Api;
  epoch?: string;
  projects: Project[];
  projectId: string;
  record?: Automation;
  models: Model[];
  modelCatalog?: ModelPagination;
  modes: CollaborationModeMask[];
  enabled: boolean;
  onChanged: () => void;
  onSaved: (id?: string) => void;
  onRetained?: (record: Automation) => void;
  onCancel: () => void;
};
const drafts = new WeakMap<Api, Map<string, Draft>>();
function acceptedPlan(submission: Submission, result: Record<string, unknown>) {
  const id = result.id,
    revision = result.revision;
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 256 ||
    /[\x00-\x1f\x7f]/u.test(id) ||
    !Number.isSafeInteger(revision) ||
    revision !== (submission.original?.revision ?? 0) + 1 ||
    (submission.original && id !== submission.original.id)
  )
    throw new Error('自动化回执缺少有效的计划标识或版本。请继续查询原回执，草稿不会重新创建计划。');
  return { id, revision: revision as number };
}
function initial(projectId: string, original?: Automation): Draft {
  const schedule = original?.schedule,
    timeZone = schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    revision: 0,
    original,
    projectId: original?.projectId ?? projectId,
    name: original?.name ?? '',
    text: original?.text ?? '',
    kind: schedule?.kind ?? 'weekly',
    timeZone,
    when: localTime(
      schedule?.kind === 'once'
        ? schedule.at
        : schedule?.kind === 'interval'
          ? schedule.anchor
          : Date.now() + 3_600_000,
      timeZone,
    ),
    time: schedule?.kind === 'weekly' ? schedule.time : '09:00',
    hours: schedule?.kind === 'interval' ? String(schedule.hours) : '24',
    days: schedule?.kind === 'weekly' ? schedule.days : [1, 2, 3, 4, 5],
    maxRunMinutes: String(original?.maxRunMinutes ?? 30),
    overrides: {},
    modeChanged: false,
  };
}
export function AutomationForm(props: Props) {
  const key = props.record?.id ?? 'new',
    owner = useRef({ api: props.api, epoch: props.epoch, key, visit: 0 });
  if (
    owner.current.api !== props.api ||
    owner.current.epoch !== props.epoch ||
    owner.current.key !== key
  )
    owner.current = { api: props.api, epoch: props.epoch, key, visit: owner.current.visit + 1 };
  // A -> B -> A is a new visit, even when the saved draft and operation are the same.
  return <AutomationEditor key={owner.current.visit} {...props} />;
}
function AutomationEditor({
  api,
  projects,
  projectId,
  record,
  models,
  modelCatalog,
  modes,
  enabled,
  onChanged,
  onSaved,
  onRetained,
  onCancel,
}: Props) {
  const key = useRef(record?.id ?? 'new');
  if (!drafts.has(api)) drafts.set(api, new Map());
  const cache = drafts.get(api)!;
  const [draft, setDraft] = useState(() => cache.get(key.current) ?? initial(projectId, record)),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false);
  const current = useRef(draft),
    mounted = useRef(true),
    running = useRef(false);
  current.current = draft;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const publish = (next: Draft) => {
    cache.set(key.current, next);
    current.current = next;
    setDraft(next);
  };
  const [preview, setPreview] = useState<{ key: string; next: number[] }>(),
    [previewBusy, setPreviewBusy] = useState(false),
    request = useRef(0);
  const operations = useOperations(),
    original = draft.original,
    conflict = Boolean(
      original && record && record.id === original.id && record.revision > original.revision,
    );
  const unresolved = operations.operations.some((operation) =>
    ['pending', 'unknown'].includes(operation.state),
  );
  const disabled =
    !enabled ||
    busy ||
    Boolean(draft.pending) ||
    conflict ||
    unresolved ||
    Boolean(operations.error);
  const update = (value: Partial<Draft>) => {
    if (!cache.has(key.current) && cache.size >= 64) {
      setError('已保留 64 份计划草稿，请先保存已有草稿。');
      return;
    }
    publish({ ...current.current, ...value, revision: current.current.revision + 1 });
    setConfirmed(false);
  };
  const accepted = (submission: Submission, result: Record<string, unknown>) => {
    if (!mounted.current || current.current.pending !== submission) return;
    const { id, revision } = acceptedPlan(submission, result);
    const latest = current.current;
    if (latest.revision === submission.revision) {
      current.current = { ...latest, pending: undefined };
      setDraft(current.current);
      cache.delete(key.current);
      onSaved(id);
    } else {
      if (key.current !== id && cache.has(id))
        throw new Error(
          '此计划已有另一份未保存草稿。两份输入均已保留，请先保存该计划的草稿，再回到此表单查询原回执。',
        );
      const baseline: Automation = {
        ...submission.spec,
        text: submission.spec.text.trim(),
        id,
        revision,
        state: submission.original?.state ?? 'paused',
        nextAt: submission.original?.nextAt ?? null,
        createdAt: submission.original?.createdAt ?? submission.at,
        updatedAt: submission.at,
      };
      const next = {
        ...latest,
        original: baseline,
        pending: undefined,
        notice: '原版本已保存；之后编辑的新草稿尚未提交。请核对后保存计划修改。',
      };
      cache.delete(key.current);
      key.current = id;
      publish(next);
      setConfirmed(false);
      onRetained?.(baseline);
    }
    setError('');
    onChanged();
  };
  const recover = async () => {
    const submission = current.current.pending;
    if (!submission || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const receipt = await api.call('operation/read', { operationId: submission.operationId });
      if (!mounted.current || current.current.pending !== submission) return;
      if (
        receipt.operationId !== submission.operationId ||
        (receipt.state !== 'not_received' &&
          receipt.method !== submission.method &&
          !(receipt.method === 'operation/retire' && receipt.state === 'not_sent') &&
          !isArchivedReceipt(receipt))
      )
        throw new Error('操作回执身份不匹配。');
      if (receipt.state === 'accepted') {
        const result = object(receipt.result);
        acceptedPlan(submission, result);
        await reconcileOperation(submission.operationId, receipt);
        if (!mounted.current || current.current.pending !== submission) return;
        accepted(submission, result);
      } else {
        await reconcileOperation(submission.operationId, receipt);
        if (!mounted.current || current.current.pending !== submission) return;
        if (receipt.state === 'not_sent') {
          publish({ ...current.current, pending: undefined });
          setConfirmed(false);
          setError('已确认原操作未发送。草稿已保留，请重新核对后保存。');
        } else setError('原操作结果仍未确认。没有重复发送，也没有丢弃草稿。');
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const plan = (): Schedule =>
    draft.kind === 'weekly'
      ? { kind: 'weekly', days: draft.days, time: draft.time, timeZone: draft.timeZone }
      : draft.kind === 'interval'
        ? {
            kind: 'interval',
            hours: Number(draft.hours),
            anchor: zonedTime(draft.when, draft.timeZone),
            timeZone: draft.timeZone,
          }
        : { kind: 'once', at: zonedTime(draft.when, draft.timeZone), timeZone: draft.timeZone };
  let planKey = '';
  try {
    planKey = JSON.stringify(plan());
  } catch {
    /* Render the user's invalid input; report on preview. */
  }
  const owner = useRef(planKey);
  owner.current = planKey;
  const currentPreview =
    preview?.key === planKey && preview.next.some((at) => at > Date.now()) ? preview : undefined;
  const nativeOptions = original?.options ?? {},
    model = draft.overrides.model ?? String(nativeOptions.model ?? ''),
    provider = draft.overrides.modelProvider ?? String(nativeOptions.modelProvider ?? ''),
    mode = draft.modeChanged
      ? (draft.overrides.mode ?? '')
      : String(object(nativeOptions.collaborationMode).mode ?? '');
  const defaults = useResource(
    JSON.stringify([draft.projectId, provider, model]),
    (signal) =>
      api.call(
        'defaults/read',
        {
          projectId: draft.projectId,
          options: {
            ...(model ? { model } : {}),
            ...(provider ? { modelProvider: provider } : {}),
          },
        },
        signal,
      ),
    enabled && Boolean(draft.projectId),
  );
  const candidates = models.filter(
    (entry) => (entry.model ?? entry.id) === (model || defaults.data?.model) &&
      matchesProvider(entry, provider || defaults.data?.modelProvider),
  );
  const selectedModel = candidates.length === 1 ? candidates[0] : undefined;
  const efforts = selectedModel?.supportedReasoningEfforts ?? [];
  const option = (name: keyof Options) =>
    String(draft.overrides[name] ?? nativeOptions[name] ?? '');
  const selection = model
    ? selectedModel ? modelSelection(selectedModel) : '__unavailable__'
    : provider ? '__provider_default__' : '';
  const modelChanged = 'model' in draft.overrides || 'modelProvider' in draft.overrides;
  const defaultsMatch =
    (!model || model === defaults.data?.model) &&
    (!provider || provider === defaults.data?.modelProvider || Boolean(
      selectedModel?.modelProvider && defaults.data?.modelProvider &&
      matchesProvider(selectedModel, defaults.data.modelProvider),
    ));
  const settingsIssue = defaults.loading || modelCatalog?.loading
    ? '正在核对模型设置，完成后即可保存计划。'
    : defaults.error
      ? `无法核对模型默认设置：${defaults.error}`
      : !defaults.data || !defaultsMatch
        ? '模型默认设置尚未确认，请重新读取。'
        : modelChanged && model && !selectedModel
          ? modelCatalog?.hasMore || modelCatalog?.error || modelCatalog?.warning
            ? '尚未在已加载目录中找到所选模型，请继续加载或重新读取模型目录；原选择仍已保留。'
            : '所选供应商或模型已不在当前目录，请重新选择；原选择仍已保留。'
          : option('effort') && !efforts.some(entry => entry.reasoningEffort === option('effort'))
            ? '所选推理强度不适用于当前供应商的模型，请重新选择或恢复默认强度。'
            : '';
  const setOption = (name: keyof Options, value: string) =>
    update({ overrides: { ...draft.overrides, [name]: value } });
  const buildOptions = () => {
    const result = { ...nativeOptions };
    for (const [field, value] of Object.entries(draft.overrides))
      if (field !== 'mode') {
        if (value) result[field] = value;
        else delete result[field];
      }
    if (draft.modeChanged) {
      if (draft.overrides.mode) {
        const collaboration = object(object(
          executionOptions(
            {
              model: typeof result.model === 'string' ? result.model : undefined,
              modelProvider: typeof result.modelProvider === 'string' ? result.modelProvider : undefined,
              effort: typeof result.effort === 'string' ? result.effort : undefined,
              mode: draft.overrides.mode,
            },
            defaults.data,
            modes,
          ),
        ).collaborationMode);
        result.collaborationMode = { ...collaboration, settings: {
          ...object(collaboration.settings),
          reasoning_effort: result.effort ?? defaults.data?.reasoningEffort ?? null,
        } };
      } else delete result.collaborationMode;
    } else if (
      result.collaborationMode &&
      (modelChanged || 'effort' in draft.overrides)
    ) {
      const collaboration = object(result.collaborationMode),
        settings = object(collaboration.settings),
        selectedModel = result.model || defaults.data?.model;
      if (typeof selectedModel !== 'string' || !selectedModel)
        throw new Error('请先读取项目默认模型。');
      result.collaborationMode = {
        ...collaboration,
        settings: {
          ...settings,
          model: selectedModel,
          reasoning_effort: result.effort ?? defaults.data?.reasoningEffort ?? null,
        },
      };
    }
    return result as AutomationSpec['options'];
  };
  const previewPlan = async () => {
    const generation = ++request.current;
    setError('');
    setPreviewBusy(true);
    setPreview(undefined);
    try {
      const schedule = plan(),
        expected = JSON.stringify(schedule);
      const result = await api.call<{ next: number[] }>('automation/preview', { schedule });
      if (mounted.current && request.current === generation && owner.current === expected) {
        if (
          !Array.isArray(result.next) ||
          result.next.length > 5 ||
          result.next.some((at) => !Number.isSafeInteger(at))
        )
          throw new Error('计划预览响应无效。');
        setPreview({ key: expected, next: result.next });
      }
    } catch (e) {
      if (mounted.current && request.current === generation) setError(message(e));
    } finally {
      if (mounted.current && request.current === generation) setPreviewBusy(false);
    }
  };
  const save = async () => {
    if (!confirmed || !currentPreview || disabled || settingsIssue || running.current || current.current.pending)
      return;
    setError('');
    let submission: Submission | undefined;
    try {
      if (!cache.has(key.current) && cache.size >= 64)
        throw new Error('已保留 64 份计划草稿，请先保存已有草稿。');
      if (
        !draft.name.trim() ||
        !draft.text.trim() ||
        new TextEncoder().encode(draft.text).length > 16_384
      )
        throw new Error('名称和指令不能为空，指令最多 16 KiB。');
      if (!projects.some((project) => project.id === draft.projectId))
        throw new Error('请选择已注册的工作目录。');
      const maxRunMinutes = Number(draft.maxRunMinutes);
      if (!Number.isInteger(maxRunMinutes) || maxRunMinutes < 1 || maxRunMinutes > 120)
        throw new Error('运行时限必须为 1 至 120 分钟。');
      const spec: AutomationSpec = {
        name: draft.name.trim(),
        text: draft.text,
        projectId: draft.projectId,
        schedule: plan(),
        options: buildOptions(),
        maxRunMinutes,
      };
      running.current = true;
      setBusy(true);
      const method = original ? 'automation/update' : 'automation/create';
      const mutation = api.beginMutation(
        method,
        original
          ? { id: original.id, expectedRevision: original.revision, spec }
          : { spec, enabled: false },
        (operationId) => {
          submission = {
            operationId,
            revision: current.current.revision,
            spec,
            original,
            method,
            at: Date.now(),
          };
          publish({ ...current.current, pending: submission, notice: undefined });
        },
      );
      const result = await mutation.result;
      if (submission) accepted(submission, result);
    } catch (e) {
      if (!mounted.current) return;
      if (
        e instanceof RpcError &&
        e.delivery === 'not_sent' &&
        current.current.pending === submission
      )
        publish({ ...current.current, pending: undefined });
      setError(message(e));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="stack automation-form">
      <div className="section-heading">
        <h3>{original ? '编辑计划' : '新建计划'}</h3>
        <button className="button small" onClick={onCancel}>
          返回计划列表（保留草稿）
        </button>
      </div>
      <p className="small muted">
        每次执行都会新建会话，使用项目权限与模型。浏览器关闭后仍会执行；需要审批时等待你的决定。未覆盖的选项在执行时使用项目默认值。
      </p>
      {operations.error && (
        <p className="error" role="alert">
          {operations.error}
        </p>
      )}
      {draft.notice && (
        <p role="status" className="small muted">
          {draft.notice}
        </p>
      )}
      {draft.pending && (
        <div className="workspace-warning">
          <p>原请求结果待核对。可以继续编辑草稿；确认原回执前不会再次保存或创建计划。</p>
          <button className="button small" disabled={busy} onClick={() => void recover()}>
            查询原自动化操作回执
          </button>
        </div>
      )}
      {unresolved && !draft.pending && (
        <p role="status" className="small muted">
          有操作结果待确认，请先查询页面上方的回执。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {original && record && conflict && (
        <div className="workspace-conflict">
          <p>
            计划已被修改，草稿仍基于版本 {original.revision}。请核对最新版本后再决定是否应用草稿。
          </p>
          <p>
            最新：{record.name} · {record.state === 'active' ? '已启用' : '已暂停'} · {record.text}
          </p>
          <button
            className="button small"
            disabled={busy || Boolean(draft.pending)}
            onClick={() => update({ original: record })}
          >
            保留草稿并以最新版本为基准
          </button>
        </div>
      )}
      <fieldset disabled={busy} className="stack">
        <div className="config-fields">
          <label className="field">
            计划名称
            <input
              maxLength={128}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label className="field">
            工作目录
            <select value={draft.projectId} onChange={(e) => update({ projectId: e.target.value })}>
              <option value="">选择项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field config-wide">
            自动执行的指令
            <textarea
              rows={5}
              maxLength={16_384}
              value={draft.text}
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          <label className="field">
            计划类型
            <select
              value={draft.kind}
              onChange={(e) => update({ kind: e.target.value as Schedule['kind'] })}
            >
              <option value="once">仅执行一次</option>
              <option value="interval">按固定小时数间隔</option>
              <option value="weekly">每周指定日期</option>
            </select>
          </label>
          <label className="field">
            时区
            <input
              list="automation-timezones"
              value={draft.timeZone}
              onChange={(e) => update({ timeZone: e.target.value })}
            />
            <datalist id="automation-timezones">
              {[
                'Asia/Shanghai',
                'UTC',
                'America/New_York',
                'America/Los_Angeles',
                'Europe/London',
              ].map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </label>
          {draft.kind === 'weekly' ? (
            <>
              <fieldset className="config-wide">
                <legend>星期</legend>
                <div className="inline">
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                    <label className="check" key={day}>
                      <input
                        type="checkbox"
                        checked={draft.days.includes(day)}
                        onChange={(e) =>
                          update({
                            days: e.target.checked
                              ? [...draft.days, day].sort()
                              : draft.days.filter((value) => value !== day),
                          })
                        }
                      />
                      周{'日一二三四五六'[day]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="field">
                执行时间
                <input
                  type="time"
                  value={draft.time}
                  onChange={(e) => update({ time: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="field">
              {draft.kind === 'once' ? '执行日期与时间' : '间隔起点日期与时间'}
              <input
                type="datetime-local"
                value={draft.when}
                onChange={(e) => update({ when: e.target.value })}
              />
            </label>
          )}
          {draft.kind === 'interval' && (
            <label className="field">
              间隔小时数
              <input
                type="number"
                min={1}
                max={168}
                value={draft.hours}
                onChange={(e) => update({ hours: e.target.value })}
              />
            </label>
          )}
          <label className="field">
            每次运行时限（分钟）
            <input
              type="number"
              min={1}
              max={120}
              value={draft.maxRunMinutes}
              onChange={(e) => update({ maxRunMinutes: e.target.value })}
            />
          </label>
        </div>
        <details>
          <summary>模型、模式与权限</summary>
          <div className="config-fields">
            <label className="field">
              自动化模型
              <select
                value={selection}
                onChange={(e) => {
                  const next = models.find(entry => modelSelection(entry) === e.target.value);
                  if (e.target.value && !next) return;
                  update({ overrides: { ...draft.overrides, model: next?.model ?? next?.id ?? '',
                    modelProvider: next?.modelProvider ?? '', effort: '' } });
                }}
              >
                <option value="">执行时使用项目默认值</option>
                {selection === '__unavailable__' && (
                  <option value="__unavailable__" disabled>原模型不在目录：{provider ? `${provider} / ` : ''}{model}（保留）</option>
                )}
                {selection === '__provider_default__' && (
                  <option value="__provider_default__" disabled>沿用供应商 {provider} 的默认模型</option>
                )}
                {[...new Set(models.map(entry => entry.modelProvider ?? ''))].map(group => (
                  <optgroup key={group} label={models.find(entry => (entry.modelProvider ?? '') === group)?.providerName ?? (group || '模型')}>
                    {models.filter(entry => (entry.modelProvider ?? '') === group).map(entry => (
                      <option key={modelSelection(entry)} value={modelSelection(entry)}>
                        {entry.displayName ?? entry.id}
                        {entry.providerName || entry.modelProvider ? ` · ${entry.providerName ?? entry.modelProvider}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field">
              自动化推理强度
              <select
                value={option('effort')}
                onChange={(e) => setOption('effort', e.target.value)}
              >
                <option value="">执行时使用项目默认值</option>
                {option('effort') &&
                  !efforts.some((entry) => entry.reasoningEffort === option('effort')) && (
                    <option value={option('effort')} disabled>{option('effort')}（原强度已不可用）</option>
                  )}
                {efforts.map((entry) => (
                  <option key={entry.reasoningEffort}>{entry.reasoningEffort}</option>
                ))}
              </select>
            </label>
            <label className="field">
              自动化协作模式
              <select
                value={mode}
                onChange={(e) =>
                  update({
                    modeChanged: true,
                    overrides: { ...draft.overrides, mode: e.target.value as Options['mode'] },
                  })
                }
              >
                <option value="">沿用项目模式</option>
                {['default', 'plan']
                  .filter((value) => value === mode || modes.some((entry) => entry.mode === value))
                  .map((value) => (
                    <option key={value} value={value}>
                      {value === 'plan' ? '计划' : '执行'}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              自动化审批策略
              <select
                value={option('approvalPolicy')}
                onChange={(e) => setOption('approvalPolicy', e.target.value)}
              >
                <option value="">执行时使用项目默认值</option>
                <option value="untrusted">仅信任安全操作</option>
                <option value="on-request">模型请求时审批</option>
                <option value="never">不请求审批</option>
              </select>
            </label>
            <label className="field">
              自动化文件访问
              <select
                value={option('sandbox')}
                onChange={(e) => setOption('sandbox', e.target.value)}
              >
                <option value="">执行时使用项目默认值</option>
                <option value="read-only">只读</option>
                <option value="workspace-write">工作目录可写</option>
                <option value="danger-full-access">完整访问</option>
              </select>
            </label>
          </div>
          <ModelDirectoryStatus directory={modelCatalog} enabled={enabled} />
        </details>
        {settingsIssue && <p className="small muted" role="status">{settingsIssue}</p>}
        {(defaults.error || defaults.data && !defaultsMatch) && (
          <button className="button small" disabled={!enabled || defaults.loading}
            onClick={() => { setConfirmed(false); defaults.refresh(); }}>重新读取模型默认设置</button>
        )}
        <button
          className="button"
          disabled={previewBusy || !enabled}
          onClick={() => void previewPlan()}
        >
          {previewBusy ? '正在计算…' : '预览接下来五次执行时间'}
        </button>
        {currentPreview && (
          <div className="info-card">
            <strong>执行时间 · {draft.timeZone}</strong>
            <ol>
              {currentPreview.next.map((at) => (
                <li key={at}>{displayTime(at, draft.timeZone)}</li>
              ))}
            </ol>
            {draft.kind === 'once' && <p className="small">一次性计划只有一个执行时间。</p>}
          </div>
        )}
        <p className="small muted">
          延误超过 5
          分钟将跳过。每周计划遇夏令时缺失时间会跳过，重复时间只执行第一次；小时间隔按实际经过时间计算。最多同时执行
          4 个自动化任务。
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          {original?.state === 'active'
            ? '确认应用到已启用计划：后续会自动执行，可能使用模型额度并按权限修改文件'
            : '确认保存计划：默认暂停，启用后会自动执行并可能使用模型额度、修改文件'}
        </label>
        <div className="inline file-editor-actions">
          <button
            className="button primary"
            disabled={disabled || Boolean(settingsIssue) || !currentPreview || !confirmed}
            onClick={() => void save()}
          >
            {original ? '保存计划修改' : '创建暂停的计划'}
          </button>
          <span className="small muted">
            {currentPreview ? '执行时间已预览' : '保存前请先预览有效的未来执行时间'}
          </span>
        </div>
      </fieldset>
    </section>
  );
}
