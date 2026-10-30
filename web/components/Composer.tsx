import { useEffect, useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { useEnterBehavior } from '../lib/input-preference';
import { composing, message, object, type Model, type Options } from '../lib/types';
import { Icon } from './Icon';
import { ComposerOptions } from './ComposerOptions';
import { ModelPicker } from './ModelPicker';
import { AttachmentButton } from './AttachmentButton';
import { EnvironmentPicker } from './EnvironmentPicker';
import { InputContextPicker } from './InputContextPicker';
import {
  contextPayload,
  parseOutputSchema,
  type ContextNote,
  type DraftReference,
} from '../lib/input-context';
import { mediaAdmission } from '../lib/input-modalities';
import { modelSettingsIssue, type CollaborationModeMask } from '../lib/workflows';
export type Attachment = { attachmentId: string; name: string; size: number; mimeType: string };
export type SendIntent = 'send' | 'steer' | 'queue';
export function Composer({
  api,
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled,
  active,
  options,
  onOptions,
  models,
  defaults,
  defaultsLoading,
  notice,
  contextKey,
  moreModels,
  modelsLoading,
  modelsRefreshDisabled,
  onMoreModels,
  onRefreshModels,
  savedAttachments,
  onAttachmentsChange,
  onAttachmentRemoved,
  existingThread = false,
  modes = [],
  modesLoading = false,
  canSteer = false,
  projectId = '',
  threadId = '',
  epoch = '',
  references = [],
  extraContext = [],
  outputSchema = '',
  onReferences,
  onExtraContext,
  onOutputSchema,
  onFiles,
  onProviders,
}: {
  projectId?: string;
  threadId?: string;
  epoch?: string;
  references?: DraftReference[];
  extraContext?: ContextNote[];
  outputSchema?: string;
  onReferences?: (value: DraftReference[]) => void;
  onExtraContext?: (value: ContextNote[]) => void;
  onOutputSchema?: (value: string) => void;
  onFiles?: () => void;
  onProviders?: () => void;
  api: Api;
  value: string;
  onChange: (value: string) => void;
  onSend: (attachments: Attachment[], intent?: SendIntent) => Promise<boolean>;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  active: boolean;
  options: Options;
  onOptions: (o: Options) => void;
  models: Model[];
  defaults: Record<string, unknown> | undefined;
  defaultsLoading: boolean;
  notice: string;
  contextKey: string;
  moreModels?: boolean;
  modelsLoading?: boolean;
  modelsRefreshDisabled?: boolean;
  onMoreModels?: () => void;
  onRefreshModels?: () => void;
  savedAttachments?: Attachment[];
  onAttachmentsChange?: (attachments: Attachment[]) => void;
  onAttachmentRemoved?: (attachmentId: string) => void;
  existingThread?: boolean;
  modes?: CollaborationModeMask[];
  modesLoading?: boolean;
  canSteer?: boolean;
}) {
  const enterBehavior = useEnterBehavior();
  const [environmentIssue, setEnvironmentIssue] =
    useState('正在核对远端执行环境，完成前不能发送。');
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>([]),
    [uploading, setUploading] = useState(0),
    [error, setError] = useState(''),
    [expanded, setExpanded] = useState(false),
    [intent, setIntent] = useState<SendIntent>('send');
  const selectedIntent = !existingThread
    ? 'send'
    : active
      ? intent === 'send'
        ? 'queue'
        : intent
      : intent === 'steer'
        ? 'send'
        : intent;
  let contextIssue =
    options.environments?.length && selectedIntent === 'send' ? environmentIssue : '';
  try {
    contextPayload(projectId, references, extraContext);
    parseOutputSchema(outputSchema);
    if (selectedIntent !== 'send' && outputSchema.trim())
      contextIssue = '结构化输出只支持普通发送，请先切换方式或清空 Schema。';
  } catch (e) {
    contextIssue = message(e);
  }
  const hasContent = Boolean(value.trim() || references.length || extraContext.length);
  const attachments = savedAttachments ?? localAttachments,
    attachmentRef = useRef(attachments);
  attachmentRef.current = attachments;
  const setAttachments = (next: Attachment[] | ((current: Attachment[]) => Attachment[])) => {
    const value = typeof next === 'function' ? next(attachmentRef.current) : next;
    attachmentRef.current = value;
    if (onAttachmentsChange) onAttachmentsChange(value);
    else setLocalAttachments(value);
  };
  const fileInput = useRef<HTMLInputElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    generation = useRef(0),
    composition = useRef(false);
  useEffect(() => {
    generation.current++;
    setLocalAttachments([]);
    setUploading(0);
    setError('');
    setIntent('send');
    setExpanded(false);
  }, [contextKey]);
  const inherited = (key: string): string => {
    const value = defaultsLoading ? undefined : defaults?.[key];
    return defaultsLoading
      ? '正在读取…'
      : value === undefined
        ? '尚未读取'
        : value === null
          ? '未设置'
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
  };
  const inheritance = existingThread ? '沿用会话设置' : '项目默认';
  const inheritedMode = defaultsLoading ? undefined : object(defaults?.collaborationMode).mode;
  const media = mediaAdmission({
    attachments,
    intent: selectedIntent,
    models,
    modelsLoading: Boolean(modelsLoading),
    defaults,
    defaultsLoading,
    options,
    modes,
  });
  if (!contextIssue) contextIssue = media.issue;
  if (!contextIssue && selectedIntent === 'send') contextIssue = modelSettingsIssue({
    options, defaults, defaultsLoading, models, modelsLoading: Boolean(modelsLoading), modes,
  });
  const send = async () => {
    if (
      busy ||
      disabled ||
      uploading ||
      (selectedIntent === 'steer' && !canSteer) ||
      (!hasContent && !attachments.length) ||
      Boolean(contextIssue)
    )
      return;
    const gen = generation.current;
    if (
      (await onSend(attachments, selectedIntent)) &&
      gen === generation.current &&
      !onAttachmentsChange
    )
      setAttachments([]);
  };
  const upload = async (files: FileList | null) => {
    if (!files) return;
    const gen = generation.current;
    setError('');
    if (files.length + attachments.length > 8) {
      setError('最多 8 个附件；单个文件上限 4 MiB。');
      return;
    }
    for (const file of Array.from(files)) {
      if (gen !== generation.current) break;
      if (file.size > 4 * 1024 * 1024) {
        setError('单个文件上限 4 MiB。');
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buffer.length; i += 8192)
          binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
        const result = await api.mutate<Attachment>('attachment/upload', {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64: btoa(binary),
        });
        if (gen === generation.current) setAttachments((existing) => [...existing, result]);
        else
          void api
            .mutate('attachment/remove', { attachmentId: result.attachmentId })
            .catch(() => {});
      } catch (e) {
        if (gen === generation.current) setError(message(e));
      } finally {
        if (gen === generation.current) setUploading((n) => n - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };
  return (
    <div className="composer-wrap">
      <div className="composer">
        {(references.length > 0 || extraContext.length > 0 || outputSchema.trim() || options.environments?.length) && <div className="composer-context-summary">
          {references.length + extraContext.length > 0 && <button onClick={() => setExpanded(true)}>已添加 {references.length + extraContext.length} 项引用</button>}
          {outputSchema.trim() && <button onClick={() => setExpanded(true)}>结构化输出</button>}
          {!!options.environments?.length && <button onClick={() => setExpanded(true)}>远端环境 {options.environments.length}</button>}
        </div>}
        {(attachments.length > 0 || uploading > 0) && (
          <div className="attachment-list">
            {attachments.map((a) => (
              <span className="attachment-chip" key={a.attachmentId}>
                <AttachmentButton api={api} attachmentId={a.attachmentId} name={a.name} />
                <button
                  aria-label={`移除 ${a.name}`}
                  onClick={async () => {
                    const gen = generation.current;
                    try {
                      await api.mutate('attachment/remove', { attachmentId: a.attachmentId });
                      if (onAttachmentRemoved) onAttachmentRemoved(a.attachmentId);
                      else if (gen === generation.current)
                        setAttachments((list) =>
                          list.filter((x) => x.attachmentId !== a.attachmentId),
                        );
                    } catch (e) {
                      if (gen === generation.current) setError(message(e));
                    }
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span role="status" className="attachment-chip">
                正在上传 {uploading} 个附件…
              </span>
            )}
          </div>
        )}
        {media.modalities.length > 0 && (
          <div className="small muted media-admission">
            <p>
              {media.modalities.includes('audio')
                ? '音频将作为原生音频输入，格式与模型能力由服务核对；不会降级成文字文件路径。'
                : '图片按当前实际输入模型的目录能力发送。'}{' '}
              每个附件最多 4 MiB；目录支持不保证当前账户或供应商请求成功。
            </p>
            {media.issue && (
              <div className="inline">
                {onRefreshModels && (
                  <button
                    className="button small"
                    disabled={modelsLoading}
                    onClick={onRefreshModels}
                  >
                    重新核对模型能力
                  </button>
                )}
                {moreModels && (
                  <button className="button small" disabled={modelsLoading} onClick={onMoreModels}>
                    继续加载模型目录
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <label className="sr-only" htmlFor="message-input">
          给 Codex 的消息
        </label>
        <textarea
          ref={input}
          id="message-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="输入消息，或添加文件…"
          rows={3}
          onCompositionStart={() => {
            composition.current = true;
          }}
          onCompositionEnd={() => {
            composition.current = false;
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              (enterBehavior === 'send' || e.ctrlKey || e.metaKey) &&
              !e.altKey &&
              !composing(e) &&
              !composition.current
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
          <input
            ref={fileInput}
            className="sr-only"
            tabIndex={-1}
            type="file"
            multiple
            aria-label="选择附件"
            onChange={(e) => void upload(e.target.files)}
          />
          <button
            className="icon-button"
            aria-label="添加附件"
            disabled={uploading > 0 || busy}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="attach" />
          </button>
          <label className="mode-select">
            <span className="sr-only">协作模式</span>
            <select
              value={options.mode ?? ''}
              disabled={modesLoading || selectedIntent !== 'send'}
              onChange={(e) =>
                onOptions({
                  ...options,
                  mode: e.target.value ? (e.target.value as 'plan' | 'default') : undefined,
                })
              }
            >
              <option value="">
                沿用模式
                {inheritedMode === 'plan'
                  ? '（计划）'
                  : inheritedMode === 'default'
                    ? '（执行）'
                    : ''}
              </option>
              {['default', 'plan']
                .filter((mode) => modes.some((item) => item.mode === mode))
                .map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === 'plan' ? '计划' : '执行'}
                  </option>
                ))}
            </select>
          </label>
          <ModelPicker key={`model:${contextKey}`} models={models} options={options} onOptions={onOptions}
            defaults={defaultsLoading ? undefined : defaults} defaultsLoading={defaultsLoading} existingThread={existingThread}
            loading={modelsLoading} disabled={selectedIntent !== 'send' || busy}
            refreshDisabled={modelsRefreshDisabled}
            onRefresh={onRefreshModels} more={moreModels} onMore={onMoreModels} onProviders={onProviders} />
          <button
            className="button subtle small options-trigger"
            aria-expanded={expanded}
            aria-controls="composer-settings"
            aria-label="对话设置"
            onClick={() => setExpanded((v) => !v)}
          >
            设置⌄
          </button>
          </div>
          <div className="composer-send-actions">
          {active && existingThread && <label className="composer-send-mode">
            <span className="sr-only">当前发送方式</span>
            <select value={selectedIntent} onChange={(e) => setIntent(e.target.value as SendIntent)}>
              <option value="queue">排队</option><option value="steer" disabled={!canSteer}>追加指令</option>
            </select>
          </label>}
          {active && (
            <button className="stop-button" aria-label="停止当前回合" onClick={onStop}>
              ■ <span>停止</span>
            </button>
          )}
          <button
            className="send-button"
            aria-label={
              selectedIntent === 'queue'
                ? '加入队列'
                : selectedIntent === 'steer'
                  ? '追加到当前回合'
                  : '发送消息'
            }
            disabled={
              disabled ||
              busy ||
              uploading > 0 ||
              (selectedIntent === 'steer' && !canSteer) ||
              (!hasContent && !attachments.length) ||
              Boolean(contextIssue)
            }
            onClick={() => void send()}
          >
            <Icon name="arrow" />
          </button>
          </div>
        </div>

        <div className="composer-extras" id="composer-settings" hidden={!expanded} inert={!expanded}>
        {selectedIntent === 'send' && (
          <ComposerOptions
            existingThread={existingThread}
            options={options}
            onOptions={onOptions}
            inheritance={inheritance}
            inherited={inherited}
          />
        )}
        <EnvironmentPicker
          key={`environment:${contextKey}`}
          api={api}
          epoch={epoch}
          value={options.environments}
          existingThread={existingThread}
          defaults={defaults}
          disabled={selectedIntent !== 'send' || busy}
          onChange={(environments) => onOptions({ ...options, environments })}
          onProblem={setEnvironmentIssue}
        />
        {onReferences && onExtraContext && onOutputSchema && (
          <InputContextPicker
            key={`input-context:${contextKey}`}
            api={api}
            projectId={projectId}
            threadId={threadId}
            epoch={epoch}
            references={references}
            notes={extraContext}
            schema={outputSchema}
            onReferences={onReferences}
            onNotes={onExtraContext}
            onSchema={onOutputSchema}
            normalTurn={selectedIntent === 'send'}
            onFiles={onFiles}
          />
        )}
        {existingThread && (
          <div className="composer-intent">
            <label>
              发送方式
              <select
                aria-label="发送方式"
                value={selectedIntent}
                onChange={(e) => setIntent(e.target.value as SendIntent)}
              >
                {!active && <option value="send">开始下一回合</option>}
                {active && (
                  <option value="steer" disabled={!canSteer}>
                    追加到当前回合
                  </option>
                )}
                <option value="queue">加入队列（空闲时立即执行）</option>
              </select>
            </label>
            <span className="small muted">
              {selectedIntent === 'steer'
                ? '仅追加指令，不改变当前回合的模型与模式。'
                : selectedIntent === 'queue'
                  ? '由运行时排队；空闲时立即执行，沿用会话设置。'
                  : options.mode === 'plan'
                    ? '先规划任务。需要执行时可切换为执行模式。'
                    : '本次选择将用于下一回合。'}
            </span>
          </div>
        )}
        </div>
      </div>
      {(error || contextIssue) && (
        <p className="error small" role="alert">
          {error || contextIssue}
        </p>
      )}
      <p className="composer-note" role="status">
        {busy
          ? '正在提交，请保留当前页面…'
          : notice ||
            (enterBehavior === 'send'
              ? 'Enter 发送 · Shift + Enter 换行'
              : 'Enter 换行 · Ctrl / ⌘ + Enter 发送')}
      </p>
    </div>
  );
}
