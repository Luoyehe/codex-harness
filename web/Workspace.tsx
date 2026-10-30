import { uuid } from './lib/ids';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api } from './lib/api';
import { Events } from './lib/events';
import { consumeThreadOperations, listOperations, reconcileOperation } from './lib/operations';
import {
  array,
  message,
  object,
  type HarnessEvent,
  type Model,
  type Options,
  type Project,
  type Thread,
  type Turn,
} from './lib/types';
import {
  branchDraftKey,
  branchDraftSource,
  draftChanged,
  emptyDraft,
  writeDraft,
} from './lib/drafts';
import { contextPayload, parseOutputSchema } from './lib/input-context';
import {
  executionOptions,
  modelSettingsIssue,
  INPUT_METHODS,
  type CollaborationModeMask,
  type ReviewTarget,
} from './lib/workflows';
import { useEvents } from './hooks/useEvents';
import { useResource } from './hooks/useResource';
import { usePaged } from './hooks/usePaged';
import { useConversation } from './hooks/useConversation';
import { usePrompts } from './hooks/usePrompts';
import { useDraft } from './hooks/useDraft';
import { useResume } from './hooks/useResume';
import { useModelCatalogRefresh } from './hooks/useModelCatalogRefresh';
import { Sidebar } from './components/Sidebar';
import { Recovery, useOperations } from './components/Recovery';
import { ProjectDialog } from './components/ProjectDialog';
import { Welcome } from './components/Welcome';
import { Composer, type Attachment, type SendIntent } from './components/Composer';
import { Diff, Messages } from './components/Messages';
import { Prompts } from './components/Prompts';
import { Settings } from './components/Settings';
import { Dialog } from './components/Dialog';
import { Icon } from './components/Icon';
import { UsagePopover } from './components/UsagePopover';
import { RenameDialog } from './components/RenameDialog';
import { ArchiveActions } from './components/ArchiveActions';
import { RealtimePanel } from './components/RealtimePanel';
import { ProcessPanel } from './components/ProcessPanel';
import { TerminalPanel } from './components/TerminalPanel';
import { TaskPanel } from './components/TaskPanel';
import { ThreadTerminals } from './components/ThreadTerminals';
import { HookEventsProvider } from './components/HookEventsPanel';
import { LoadedThreadsPanel } from './components/LoadedThreadsPanel';
import { PredictionPanel } from './components/PredictionPanel';
import { GuardianReviewPanel } from './components/GuardianReviewPanel';
import { ThreadExecutionSettings } from './components/ThreadExecutionSettings';
import { BranchDialog, HistoryTools, ReviewDialog } from './components/HistoryTools';
import './styles-workflows.css';
import './styles-workspace.css';
import './styles-extensions.css';
import { WorkspacePanel } from './components/WorkspacePanel';
import { McpEventBridge } from './components/McpPanel';
import { OrganizationPanel } from './components/OrganizationPanel';
import { AutomationsPanel } from './components/AutomationsPanel';
import './styles-automations.css';
import './styles-input-context.css';

export function Workspace({
  api,
  logout,
  active,
}: {
  api: Api;
  logout: () => Promise<void>;
  active: boolean;
}) {
  const events = useMemo(() => new Events(), []),
    navigation = useRef(0);
  const [projectId, setProjectId] = useState(() => {
      try {
        return sessionStorage.getItem('harness.project') ?? '';
      } catch {
        return '';
      }
    }),
    [threadId, setThreadId] = useState(
      () => new URL(location.href).searchParams.get('thread') ?? '',
    );
  const contextKey = threadId || `new:${projectId}`,
    draftState = useDraft(contextKey),
    draft = draftState.text,
    options = draftState.options;
  const setOptions = draftState.setOptions;
  const [threadOrder, setThreadOrder] = useState<'recency_at' | 'section_position'>('recency_at');
  const [archived, setArchived] = useState(false),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{
      threadId: string;
      archived: boolean;
      epoch: string;
    }>(),
    [archiveBusy, setArchiveBusy] = useState(false);
  const [panel, setPanelState] = useState<
      | 'chat'
      | 'terminal'
      | 'diff'
      | 'files'
      | 'process'
      | 'voice'
      | 'thread-terminals'
      | 'prediction'
    >('chat'),
    [voiceMounted, setVoiceMounted] = useState(false),
    [processMounted, setProcessMounted] = useState(false),
    [terminalMounted, setTerminalMounted] = useState(false),
    [workspaceMounted, setWorkspaceMounted] = useState(false),
    [modal, setModal] = useState(''),
    [mobile, setMobile] = useState(false),
    [attachmentContext, setAttachmentContext] = useState(() => uuid());
  const [threadTerminalsMounted, setThreadTerminalsMounted] = useState(false),
    [predictionMounted, setPredictionMounted] = useState(false);
  const [terminalProgram, setTerminalProgram] = useState<'shell' | 'codex' | 'codex-cloud'>(
    'shell',
  );
  const threadMenu = useRef<HTMLDetailsElement>(null),
    workspaceBody = useRef<HTMLDivElement>(null),
    composerSlot = useRef<HTMLDivElement>(null);
  const [panelFocusRevision, setPanelFocusRevision] = useState(0),
    pendingPanelFocus = useRef(false);
  const setPanel = (next: typeof panel) => {
    if (threadMenu.current) threadMenu.current.open = false;
    pendingPanelFocus.current = true;
    setPanelState(next);
    setPanelFocusRevision((value) => value + 1);
  };
  useEffect(() => {
    if (!pendingPanelFocus.current) return;
    pendingPanelFocus.current = false;
    if (!active || modal) return;
    const heading = [...(workspaceBody.current?.querySelectorAll<HTMLElement>('h2,h3') ?? [])].find(
      (element) => !element.closest('[hidden]'),
    );
    const target =
      panel === 'chat'
        ? composerSlot.current?.querySelector<HTMLTextAreaElement>('textarea')
        : (heading ?? workspaceBody.current);
    if (target) {
      if (!(target instanceof HTMLTextAreaElement)) target.tabIndex = -1;
      target.focus();
    }
  }, [panel, panelFocusRevision, active, modal]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        threadMenu.current?.open &&
        event.target instanceof Node &&
        !threadMenu.current.contains(event.target)
      )
        threadMenu.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const [workspaceRequest, setWorkspaceRequest] = useState<{
      projectId: string;
      path: string;
      revision: number;
    }>(),
    [reviewTarget, setReviewTarget] = useState<ReviewTarget>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(new Set<string>());
  const [draftGuard, setDraftGuard] = useState(false),
    [discardRevision, setDiscardRevision] = useState<string>();
  const [completedHandoff, setCompletedHandoff] = useState<{
    id: string; navigation: number; message: string;
  }>();
  const [branchAction, setBranchAction] = useState<{
    turn: Turn;
    action: 'fork' | 'edit' | 'revert';
  }>();
  const branchMemory = useRef(new Map<string, string>());
  const [restoreBranch, setRestoreBranch] = useState<{ threadId: string; turnId: string }>();
  const [focusTarget, setFocusTarget] = useState<{ turnId: string; itemId: string }>();
  const [resumeRevision, setResumeRevision] = useState(0);
  const [configRevision, setConfigRevision] = useState(0),
    [debouncedOptions, setDebouncedOptions] = useState<Options>({});
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('harness.theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  const committedUrl = useRef(location.href);
  const changeContext = (nextProject: string, nextThread: string, apply: () => void, accepted?: () => boolean) => {
    if (!draftState.canNavigateTo(nextThread || `new:${nextProject}`) && !accepted?.()) {
      setDiscardRevision(undefined);
      setDraftGuard(true);
      return false;
    }
    setProjectId(nextProject);
    setThreadId(nextThread);
    apply();
    return true;
  };
  const navigate = (id: string, settings: {
    projectId?: string; preserveAttachments?: boolean; fromHistory?: boolean; accepted?: () => boolean;
  } = {}) => changeContext(settings.projectId ?? projectId, id, () => {
    navigation.current++;
    setModal('');
    setBranchAction(undefined);
    setFocusTarget(undefined);
    if (!settings.preserveAttachments && (id || `new:${settings.projectId ?? projectId}`) !== contextKey)
      setAttachmentContext(uuid());
    setPanel('chat');
    setMobile(false);
    setError('');
    const url = new URL(location.href);
    if (id) url.searchParams.set('thread', id);
    else url.searchParams.delete('thread');
    if (!settings.fromHistory) history.pushState({}, '', url);
    committedUrl.current = url.href;
  }, settings.accepted);
  const latestNavigate = useRef(navigate);
  latestNavigate.current = navigate;
  const openThread = (id: string) => {
    if (!navigate(id)) return false;
    setResumeRevision((v) => v + 1);
    return true;
  };
  // Keep drafts and receipts mounted during reauthentication, but release native
  // modal ownership immediately. A dialog under [hidden] still makes login inert.
  useEffect(() => {
    if (!active) {
      setModal('');
      setMobile(false);
      setBranchAction(undefined);
    }
  }, [active]);
  const receive = useCallback(
    (event: HarnessEvent) => {
      events.publish(event);
      if (event.type === 'receipt' && typeof event.data.operationId === 'string') {
        void reconcileOperation(event.data.operationId, event.data).catch((error) => setError(message(error)));
      }
      if (event.type === 'notification') {
        const params = object(event.data.params),
          method = event.data.method;
        if (method === 'account/updated' || method === 'account/login/completed')
          setConfigRevision((value) => value + 1);
        if (
          params.threadId === threadId &&
          (method === 'thread/settings/updated' ||
            method === 'thread/closed' ||
            (method === 'thread/status/changed' && object(params.status).type === 'notLoaded'))
        )
          setResumeRevision((value) => value + 1);
      }
    },
    [events, threadId],
  );
  const network = useEvents(api, receive, active),
    resourceEpoch = `${network.epoch}:${network.revision}:${configRevision}`;
  const projectsResource = useResource(resourceEpoch, (signal) =>
    api.call('project/list', {}, signal),
  );
  const projects = array<Project & { path?: string }>(
    projectsResource.data?.projects ?? projectsResource.data?.data,
  ).map((p) => ({ ...p, cwd: p.cwd ?? p.path ?? '' }));
  const project = projects.find((p) => p.id === projectId);
  const threadListKey = `${resourceEpoch}:${projectId}:${archived}:${search}:${threadOrder}`;
  const threads = usePaged<Thread>(
    api,
    'thread/list',
    {
      projectId,
      archived,
      sortKey: threadOrder,
      sortDirection: threadOrder === 'section_position' ? 'asc' : 'desc',
      ...(search ? { searchTerm: search } : {}),
    },
    threadListKey,
    Boolean(projectId) && !search,
  );
  const searchThreads = usePaged<{ thread: Thread; snippet: string }>(
    api,
    'thread/search',
    { projectId, archived, searchTerm: search },
    threadListKey,
    Boolean(projectId && search),
  );
  const selectedArchived =
    archiveSelection?.threadId === threadId && archiveSelection.epoch === resourceEpoch
      ? archiveSelection.archived
      : undefined;
  useEffect(() => {
    if (threads.snapshotKey !== threadListKey || !threads.items.some((t) => t.id === threadId))
      return;
    setArchiveSelection((current) =>
      current?.threadId === threadId && current.epoch === resourceEpoch
        ? current
        : { threadId, archived, epoch: resourceEpoch },
    );
  }, [threads.snapshotKey, threads.items, threadListKey, threadId, archived, resourceEpoch]);
  useEffect(
    () =>
      events.subscribe((event) => {
        if (
          event.type !== 'notification' ||
          object(event.data.params).threadId !== threadId ||
          !['thread/archived', 'thread/unarchived'].includes(String(event.data.method))
        )
          return;
        setArchiveSelection({
          threadId,
          archived: event.data.method === 'thread/archived',
          epoch: resourceEpoch,
        });
      }),
    [events, threadId, resourceEpoch],
  );
  const models = usePaged<Model>(api, 'model/list', {}, `${resourceEpoch}:models`);
  const modes = useResource(
    resourceEpoch,
    (signal) => api.call<{ data: CollaborationModeMask[] }>('collaborationMode/list', {}, signal),
    active,
  );
  const defaults = useResource(
    `${resourceEpoch}:${projectId}:${JSON.stringify(debouncedOptions)}`,
    (signal) =>
      api.call(
        'defaults/read',
        {
          projectId,
          options: Object.fromEntries(
            Object.entries(debouncedOptions).filter(
              ([key]) => key !== 'mode' && key !== 'environments',
            ),
          ),
        },
        signal,
      ),
    Boolean(projectId) && !threadId,
  );
  const [retryingDefaults, setRetryingDefaults] = useState(false);
  useEffect(() => {
    if (!defaults.loading) setRetryingDefaults(false);
  }, [defaults.loading]);
  const conversation = useConversation(api, events, threadId, resourceEpoch),
    prompts = usePrompts(api, events, resourceEpoch);
  const operations = useOperations();
  const settingsReceipts = operations.operations
    .filter(
      (op) =>
        op.state === 'accepted' &&
        [...INPUT_METHODS, 'thread/resume', 'thread/settings/update', 'thread/fork', 'review/startNew'].includes(op.method) &&
        (op.resolvedThreadId || op.threadId) === threadId,
    )
    .map((op) => op.id)
    .join(',');
  const resume = useResume(
    api,
    threadId,
    `${resourceEpoch}:${resumeRevision}:${settingsReceipts}`,
    conversation.refresh,
  );
  const { resumedThread, threadDefaults } = resume;
  const composerDefaults = threadId ? threadDefaults : defaults.data;
  const composerDefaultsLoading = threadId ? resumedThread !== threadId :
    defaults.loading || JSON.stringify(options) !== JSON.stringify(debouncedOptions);
  useEffect(() => {
    if (threadId && resumedThread === threadId && threadDefaults && settingsReceipts)
      void consumeThreadOperations(threadId, settingsReceipts.split(',')).catch((failure) => setError(message(failure)));
  }, [threadId, resumedThread, threadDefaults, settingsReceipts]);
  const effectiveProvider = options.modelProvider ?? (threadId ? threadDefaults?.modelProvider : defaults.data?.modelProvider);
  const modelCatalog = useModelCatalogRefresh(api, typeof effectiveProvider === 'string' ? effectiveProvider : undefined,
    active && network.configurationReady && network.connection === 'connected' && network.runtimeConnected);
  const isBusy = busy.has(contextKey);
  const pending = operations.operations.some(
    (op) =>
      ['pending', 'unknown'].includes(op.state) &&
      (threadId
        ? op.threadId === threadId || op.resolvedThreadId === threadId
        : op.projectId === projectId && INPUT_METHODS.includes(op.method)),
  );
  const directInputAllowed =
    !conversation.thread?.parentThreadId || conversation.thread.canAcceptDirectInput === true;
  const workflowEnabled =
    active &&
    network.connection === 'connected' &&
    network.runtimeConnected &&
    network.activityReady &&
    conversation.ready &&
    resumedThread === threadId &&
    !pending &&
    !operations.error &&
    directInputAllowed;
  useEffect(() => {
    if (restoreBranch && threadId === restoreBranch.threadId && conversation.ready) {
      const turn = conversation.turns.find((item) => item.id === restoreBranch.turnId);
      if (turn) setBranchAction({ turn, action: 'edit' });
      else setError('原回合已不在会话历史中。分支草稿仍保留，可在设置中查看和复制。');
      setRestoreBranch(undefined);
    }
  }, [restoreBranch, threadId, conversation.ready, conversation.turns]);
  const visiblePrompts = prompts.prompts.filter((p) => !p.threadId || p.threadId === threadId);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedOptions(options), 400);
    return () => clearTimeout(timer);
  }, [options]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('harness.theme', theme);
    } catch {
      /* Theme preference is optional. */
    }
  }, [theme]);
  useEffect(() => {
    if (!projects.length || threadId) return;
    if (!projects.some((p) => p.id === projectId)) changeContext(projects[0]!.id, threadId, () => {});
  }, [projectsResource.data, threadId, projectId]);
  useEffect(() => {
    if (projectId && projects.some((p) => p.id === projectId)) {
      try {
        sessionStorage.setItem('harness.project', projectId);
      } catch (e) {
        setError(`无法保存当前项目选择：${message(e)}`);
      }
    }
  }, [projectId, projectsResource.data]);
  useEffect(() => {
    if (!threadId || !conversation.thread?.cwd || !projects.length) return;
    const matching = projects.find((p) => p.cwd === conversation.thread?.cwd);
    if (matching) changeContext(matching.id, threadId, () => {});
    else setError('此会话的工作目录尚未注册。请先添加对应项目。');
  }, [conversation.thread?.cwd, projectsResource.data, threadId]);
  useEffect(() => {
    const back = () => {
      if (latestNavigate.current(new URL(location.href).searchParams.get('thread') ?? '', { fromHistory: true }))
        setResumeRevision((v) => v + 1);
      else history.pushState({}, '', committedUrl.current);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    if (network.connection !== 'connected' || !network.runtimeConnected) return;
    let disposed = false;
    const recover = async () => {
      let records;
      try {
        records = (await listOperations()).filter((o) => ['pending', 'unknown'].includes(o.state));
      } catch (e) {
        setError(message(e));
        return;
      }
      for (let i = 0; i < records.length && !disposed; i += 4)
        await Promise.allSettled(
          records.slice(i, i + 4).map(async (op) => {
            const result = await api.call('operation/read', { operationId: op.id });
            if (!disposed) await reconcileOperation(op.id, result);
          }),
        );
    };
    void recover();
    return () => {
      disposed = true;
    };
  }, [api, network.revision, network.connection, network.runtimeConnected]);
  const changeArchive = async (nextArchived: boolean) => {
    if (archiveBusy) return;
    const target = threadId,
      nav = navigation.current,
      canLeave = draftState.canLeave;
    setArchiveBusy(true);
    setError('');
    try {
      await api.mutate(nextArchived ? 'thread/archive' : 'thread/unarchive', { threadId: target });
      threads.refresh();
      if (navigation.current === nav) {
        setArchiveSelection({ threadId: target, archived: nextArchived, epoch: resourceEpoch });
        if (canLeave()) navigate('');
        else setCompletedHandoff({
          id: '', navigation: nav, message: '归档状态已更新，当前输入仍保留在这里。',
        });
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setArchiveBusy(false);
    }
  };
  const send = async (attachments: Attachment[], intent: SendIntent = 'send'): Promise<boolean> => {
    const key = contextKey,
      text = draft,
      nav = navigation.current,
      canLeaveAfterAcceptance = draftState.canLeaveAfterAcceptance;
    if (
      !projectId ||
      pending ||
      isBusy ||
      draftState.error ||
      !directInputAllowed ||
      (intent === 'steer' && !conversation.activeTurn) ||
      (intent === 'send' && conversation.active)
    )
      return false;
    if (intent === 'send') {
      const issue = modelSettingsIssue({ options, defaults: composerDefaults,
        defaultsLoading: composerDefaultsLoading, models: models.items,
        modelsLoading: models.loading || modelCatalog.refreshing, modes: modes.data?.data ?? [] });
      if (issue) { setError(issue); return false; }
    }
    setBusy((current) => new Set([...current, key]));
    setError('');
    let target = threadId;
    try {
      const context = contextPayload(projectId, draftState.references, draftState.extraContext),
        schema = parseOutputSchema(draftState.outputSchema);
      if (intent !== 'send' && schema) throw new Error('结构化输出只支持普通发送。');
      const structured = schema ? { outputSchema: schema } : {};
      if (!target) {
        const result = await api.mutate('conversation/start', {
          projectId,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
          options: {
            ...executionOptions(options, defaults.data, modes.data?.data ?? []),
            ...structured,
          },
        });
        const thread = object(result.thread);
        if (typeof thread.id !== 'string')
          throw new Error('会话已受理，但响应未包含会话 ID。请查询恢复记录。');
        target = thread.id;
        if (navigation.current === nav) {
          if (canLeaveAfterAcceptance()) navigate(target, { preserveAttachments: true, accepted: canLeaveAfterAcceptance });
          else setCompletedHandoff({
            id: target, navigation: nav, message: '新会话已创建，后续输入仍保留在这里。',
          });
        }
        threads.refresh();
      } else if (intent === 'queue')
        await api.mutate('thread/queue/add', {
          threadId: target,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
        });
      else if (intent === 'steer')
        await api.mutate('turn/steer', {
          threadId: target,
          expectedTurnId: conversation.activeTurn!.id,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
        });
      else
        await api.mutate('turn/start', {
          threadId: target,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
          options: {
            ...executionOptions(options, threadDefaults, modes.data?.data ?? []),
            ...structured,
          },
        });
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const modalNavigation = navigation.current;
  const loadThread = async () => {
    if (
      !threadId ||
      pending ||
      isBusy ||
      !resume.requiresResume ||
      !conversation.ready ||
      network.connection !== 'connected' ||
      !network.runtimeConnected ||
      !network.activityReady
    )
      return;
    const target = threadId,
      nav = navigation.current,
      key = contextKey;
    setBusy((current) => new Set([...current, key]));
    setError('');
    try {
      await api.mutate('thread/resume', { threadId: target });
      if (navigation.current === nav) setResumeRevision((v) => v + 1);
    } catch (e) {
      if (navigation.current === nav) setError(message(e));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const workflowChanged = () => {
    threads.refresh();
    if (navigation.current === modalNavigation) {
      conversation.refresh();
      setResumeRevision((v) => v + 1);
    }
  };
  const workflowOpenThread = (id: string) => {
    if (navigation.current === modalNavigation) openThread(id);
  };
  const workflowHandoff = (id: string) => {
    if (navigation.current !== modalNavigation) return;
    if (draftState.canLeave()) openThread(id);
    else setCompletedHandoff({
      id, navigation: modalNavigation, message: '新会话已创建，当前输入仍保留在这里。',
    });
  };
  const finishBranch = (id: string, text: string | undefined, automatic: boolean) => {
    if (text !== undefined) {
      try {
        writeDraft({ ...emptyDraft(id), text });
        draftChanged(id);
      } catch (e) {
        setError('分支已创建，但草稿保存失败：' + message(e));
        return false;
      }
    }
    if (automatic) workflowHandoff(id);
    else workflowOpenThread(id);
    return true;
  };
  const openWorkspace = (projectId: string, path = '') => {
    if (!navigate('', { projectId })) return;
    setWorkspaceMounted(true);
    setPanel('files');
    setWorkspaceRequest((previous) => ({
      projectId,
      path,
      revision: (previous?.revision ?? 0) + 1,
    }));
  };
  const sidebar = (
    <Sidebar
      onLoaded={() => {
        setMobile(false);
        setModal('loaded');
      }}
      onAutomations={() => {
        setMobile(false);
        setModal('automations');
      }}
      threadOrder={threadOrder}
      onThreadOrder={setThreadOrder}
      onOrganize={() => {
        setMobile(false);
        setModal('organize');
      }}
      projects={projects}
      projectId={projectId}
      threads={search ? searchThreads.items.map((hit) => hit.thread) : threads.items}
      snippets={
        search
          ? Object.fromEntries(searchThreads.items.map((hit) => [hit.thread.id, hit.snippet]))
          : undefined
      }
      threadId={threadId}
      archived={archived}
      query={query}
      loading={(search ? searchThreads.loading : threads.loading) || projectsResource.loading}
      error={(search ? searchThreads.error : threads.error) || projectsResource.error}
      more={search ? searchThreads.hasMore : threads.hasMore}
      onProject={(id) => {
        navigate('', { projectId: id });
      }}
      onThread={(id) => void openThread(id)}
      onNew={() => navigate('')}
      onQuery={setQuery}
      onArchived={() => setArchived((v) => !v)}
      onAddProject={() => {
        setMobile(false);
        setModal('project');
      }}
      onSettings={() => {
        setMobile(false);
        setModal('settings');
      }}
      onMore={() => void (search ? searchThreads.more() : threads.more())}
      onRefresh={() => {
        threads.refresh();
        searchThreads.refresh();
      }}
    />
  );
  const title =
    conversation.thread?.name ||
    threads.items.find((t) => t.id === threadId)?.name ||
    (threadId ? '会话' : '新会话');
  return (
    <HookEventsProvider
      events={events}
      lease={`${network.epoch}:${network.connectionId}`}
      connected={active && network.connection === 'connected' && network.runtimeConnected}
    >
      <div className="app-shell">
        <McpEventBridge
          api={api}
          events={events}
          lease={`${network.epoch}:${network.revision}:${active && network.runtimeConnected ? 'online' : 'offline'}`}
        />
        <div className="desktop-sidebar">{sidebar}</div>
        <main className="main-workspace">
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobile(true)}
            >
              <Icon name="menu" />
            </button>
            <div className="breadcrumb">
              <span>{project?.name ?? '工作台'}</span>
              <span className="crumb-divider">/</span>
              <strong>{title}</strong>
            </div>
            <div
              className={`connection ${network.connection}`}
              title={network.connection === 'connected' ? '实时连接正常' : '正在恢复连接'}
            >
              <span />
              {network.connection === 'connected'
                ? '已连接'
                : network.connection === 'connecting'
                  ? '连接中'
                  : '已离线'}
            </div>
            {conversation.usage !== undefined && (
              <UsagePopover usage={conversation.usage} />
            )}
            <div className="header-actions">
              <button
                className={`icon-button ${panel === 'files' ? 'selected' : ''}`}
                aria-label="打开项目文件"
                onClick={() => {
                  setWorkspaceMounted(true);
                  setPanel(panel === 'files' ? 'chat' : 'files');
                }}
              >
                <Icon name="folder" />
              </button>
              <button
                className={`icon-button ${panel === 'terminal' ? 'selected' : ''}`}
                aria-label="打开项目终端"
                onClick={() => {
                  setTerminalMounted(true);
                  setPanel(panel === 'terminal' ? 'chat' : 'terminal');
                }}
              >
                <Icon name="terminal" />
              </button>
              <button
                className="icon-button"
                aria-label="打开官方云任务界面"
                disabled={!project}
                onClick={() => {
                  setTerminalProgram('codex-cloud');
                  setTerminalMounted(true);
                  setPanel('terminal');
                }}
              >
                <Icon name="cloud" />
              </button>
              <button
                className={`icon-button ${panel === 'process' ? 'selected' : ''}`}
                aria-label="打开命令进程"
                title="直接运行命令与管理进程"
                onClick={() => {
                  setProcessMounted(true);
                  setPanel(panel === 'process' ? 'chat' : 'process');
                }}
              >
                <Icon name="play" />
              </button>
              {threadId && (
                <button
                  className={`icon-button ${panel === 'thread-terminals' ? 'selected' : ''}`}
                  aria-label="打开会话命令与后台终端"
                  onClick={() => {
                    setThreadTerminalsMounted(true);
                    setPanel(panel === 'thread-terminals' ? 'chat' : 'thread-terminals');
                  }}
                >
                  <Icon name="terminal" />
                </button>
              )}
              {threadId && (
                <details
                  ref={threadMenu}
                  className="thread-menu"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector('summary')?.focus();
                    }
                  }}
                >
                  <summary className="icon-button" aria-label="会话操作">
                    <Icon name="more" />
                  </summary>
                  <div
                    className="menu-popover"
                    onClick={(event) => {
                      if ((event.target as Element).closest('button:not(:disabled)')) {
                        if (threadMenu.current) threadMenu.current.open = false;
                        threadMenu.current?.querySelector('summary')?.focus();
                      }
                    }}
                  >
                    <button
                      onClick={() => {
                        setPredictionMounted(true);
                        setPanel('prediction');
                      }}
                    >
                      下一步建议
                    </button>
                    <button
                      onClick={() => {
                        setVoiceMounted(true);
                        setPanel('voice');
                      }}
                    >
                      实时语音与文字
                    </button>
                    <button onClick={() => setModal('organize')}>会话分组与历史管理</button>
                    <button
                      onClick={() => {
                        setThreadTerminalsMounted(true);
                        setPanel('thread-terminals');
                      }}
                    >
                      会话命令与后台终端
                    </button>
                    <button onClick={() => setModal('guardian')}>Guardian 拒绝与一次重试</button>
                    <button onClick={() => setModal('execution')}>会话与当前回合设置</button>
                    <button onClick={() => setModal('tasks')}>任务队列、目标与 Agents</button>
                    <button onClick={() => setModal('history')}>搜索与完整导出</button>
                    <button
                      disabled={!workflowEnabled || conversation.active}
                      onClick={() => {
                        setReviewTarget(undefined);
                        setModal('review');
                      }}
                    >
                      启动代码审查
                    </button>
                    <button onClick={() => setModal('rename')}>重命名会话</button>
                    <button onClick={() => setPanel('diff')}>查看修改 diff</button>
                    <button
                      disabled={conversation.active}
                      onClick={async () => {
                        try {
                          await api.mutate('thread/compact', { threadId });
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      压缩上下文
                    </button>
                    <ArchiveActions
                      archived={selectedArchived}
                      busy={archiveBusy}
                      onChange={(value) => void changeArchive(value)}
                    />
                  </div>
                </details>
              )}
            </div>
          </header>
          <div className="status-area">
            {(conversation.realtimeActive || conversation.historyStale) && (
              <p className="connection-banner" role="status">
                {conversation.realtimeActive
                  ? '语音会话正在进行，普通任务暂不可发送。结束语音后会重新同步完整历史。'
                  : '会话历史已变化，重新同步完成前不能继续任务。'}
                {conversation.realtimeActive && (
                  <button
                    className="button small"
                    onClick={() => {
                      setVoiceMounted(true);
                      setPanel('voice');
                    }}
                  >
                    打开语音控制
                  </button>
                )}
                <button
                  className="button small"
                  disabled={conversation.loading}
                  onClick={conversation.recheck}
                >
                  重新读取完整历史
                </button>
              </p>
            )}
            {threadId && resume.requiresResume && (
              <div className="resume-notice">
                <p>
                  此会话尚未加载。可以查看历史、搜索和导出；继续加载可能恢复已保存的队列或持续目标。
                </p>
                <button
                  className="button primary small"
                  disabled={
                    pending ||
                    isBusy ||
                    !conversation.ready ||
                    Boolean(operations.error) ||
                    network.connection !== 'connected' ||
                    !network.runtimeConnected ||
                    !network.activityReady
                  }
                  onClick={() => void loadThread()}
                >
                  {isBusy ? '正在加载…' : '加载并继续（可能恢复待执行任务）'}
                </button>
              </div>
            )}
            {prompts.prompts.some((p) => p.threadId && p.threadId !== threadId) && (
              <p className="connection-banner">
                <button
                  className="button small"
                  onClick={() =>
                    openThread(
                      prompts.prompts.find((p) => p.threadId && p.threadId !== threadId)!.threadId!,
                    )
                  }
                >
                  其他会话正在等待你的决定 →
                </button>
              </p>
            )}
            {network.connection !== 'connected' && (
              <p className="connection-banner" role="status">
                连接恢复后会核对任务状态；不会自动重发请求。
              </p>
            )}
            {network.connection === 'connected' &&
              (!network.runtimeConnected || !network.activityReady) && (
                <p className="connection-banner" role="status">
                  {network.restarting ? '终端已退出，正在自动刷新后台环境…' : '后台尚未就绪，正在核对任务状态。'}
                  <button className="button small" onClick={() => setModal('settings-admin')}>查看服务与恢复</button>
                </p>
              )}
            {draftState.error && (
              <p className="error-banner" role="alert">
                {draftState.error}
              </p>
            )}
            {draftState.hasUnsaved && (
              <div className="inline">
                <button className="button small" onClick={() => draftState.retrySave()}>重试保存草稿</button>
                <button className="button small" onClick={() => {
                  setDiscardRevision(draftState.revision);
                  setDraftGuard(true);
                }}>放弃未保存的修改</button>
              </div>
            )}
            {completedHandoff?.navigation === navigation.current && (
              <p className="connection-banner" role="status">
                {completedHandoff.message}
                <button className="button small" onClick={() => openThread(completedHandoff.id)}>
                  {completedHandoff.id ? '打开已创建的会话' : '打开新会话'}
                </button>
              </p>
            )}
            <Recovery
              openWorkspace={openWorkspace}
              api={api}
              operations={operations.operations}
              error={operations.error}
              warning={operations.warning}
              openThread={(id) => void openThread(id)}
              runtimeReady={
                network.connection === 'connected' &&
                network.runtimeConnected &&
                network.activityReady
              }
              recoveryEpoch={resourceEpoch}
            />
            {(error || resume.error || conversation.error || prompts.error) && (
              <div className="error-banner" role="alert">
                <span>{error || resume.error || conversation.error || prompts.error}</span>
                <button
                  className="button small"
                  onClick={() => {
                    setError('');
                    setResumeRevision((v) => v + 1);
                    conversation.refresh();
                  }}
                >
                  重新读取会话
                </button>
              </div>
            )}
          </div>
          <div ref={workspaceBody} className="workspace-body" data-panel={panel}>
            {panel !== 'chat' && (
              <nav className="tool-navigation" aria-label="工具视图导航">
                <button className="button small" onClick={() => setPanel('chat')}>
                  ← 返回聊天
                </button>
                <span className="small muted">只切换视图，已启动的终端、进程和语音保持运行。</span>
              </nav>
            )}
            {predictionMounted && (
              <div className="process-slot" hidden={panel !== 'prediction'}>
                <PredictionPanel
                  onServiceSettings={() => setModal('settings-admin')}
                  key={network.epoch + network.connectionId}
                  api={api}
                  events={events}
                  epoch={resourceEpoch}
                  threadId={threadId}
                  sourceTurnId={
                    conversation.turns.at(-1)?.status === 'completed'
                      ? conversation.turns.at(-1)!.id
                      : ''
                  }
                  connected={
                    active && network.connection === 'connected' && network.runtimeConnected
                  }
                  enabled={workflowEnabled && !conversation.active && !conversation.realtimeActive}
                  draftEmpty={
                    !draft &&
                    !draftState.attachments.length &&
                    !draftState.references.length &&
                    !draftState.extraContext.length
                  }
                  onInsert={(text, source) => {
                    if (
                      source !== conversation.turns.at(-1)?.id ||
                      !workflowEnabled ||
                      conversation.active ||
                      conversation.realtimeActive
                    )
                      return false;
                    const inserted = draftState.insertTextIfEmpty(text);
                    if (inserted) setPanel('chat');
                    return inserted;
                  }}
                />
              </div>
            )}
            {threadTerminalsMounted && threadId && (
              <div className="process-slot" hidden={panel !== 'thread-terminals'}>
                <ThreadTerminals
                  key={threadId + network.epoch + network.connectionId}
                  api={api}
                  events={events}
                  epoch={resourceEpoch}
                  threadId={threadId}
                  connected={
                    active && network.connection === 'connected' && network.runtimeConnected
                  }
                  enabled={workflowEnabled}
                  idle={!conversation.active && !conversation.realtimeActive}
                  onChanged={workflowChanged}
                  onLocate={(itemId) => {
                    const turn = conversation.turns.find((row) =>
                      row.items.some((item) => item.id === itemId),
                    );
                    setPanel('chat');
                    if (turn) setFocusTarget({ turnId: turn.id, itemId });
                    else setError('后台进程的历史条目尚未加载，请重新读取完整会话。');
                  }}
                />
              </div>
            )}
            {voiceMounted && threadId && (
              <div className="process-slot" hidden={panel !== 'voice'}>
                <div className="section-heading">
                  <h2>实时会话</h2>
                </div>
                <RealtimePanel
                  api={api}
                  events={events}
                  epoch={network.epoch}
                  lease={network.connectionId}
                  connected={
                    active && network.connection === 'connected' && network.runtimeConnected
                  }
                  threadId={threadId}
                  threadReady={workflowEnabled}
                  threadIdle={!conversation.active && !conversation.realtimeActive}
                  onStarted={conversation.voiceStarted}
                  onClosed={conversation.voiceClosed}
                />
              </div>
            )}
            {processMounted && (
              <div className="process-slot" hidden={panel !== 'process'}>
                <ProcessPanel
                  api={api}
                  events={events}
                  epoch={network.epoch}
                  connectionId={network.connectionId}
                  connected={
                    active && network.connection === 'connected' && network.runtimeConnected
                  }
                  enabled={
                    active &&
                    network.connection === 'connected' &&
                    network.runtimeConnected &&
                    network.activityReady
                  }
                  project={project}
                  onChanged={projectsResource.refresh}
                />
              </div>
            )}
            {workspaceMounted && (
              <div className="terminal-slot" hidden={panel !== 'files'}>
                <WorkspacePanel
                  visible={active && panel === 'files'}
                  idle={active && network.configurationReady}
                  onProjectsChanged={projectsResource.refresh}
                  onSelectProject={(id) => {
                    navigate('', { projectId: id });
                  }}
                  api={api}
                  project={project}
                  epoch={resourceEpoch}
                  connected={
                    active && network.connection === 'connected' && network.runtimeConnected
                  }
                  ready={
                    active &&
                    network.connection === 'connected' &&
                    network.runtimeConnected &&
                    network.activityReady
                  }
                  request={workspaceRequest}
                  onReference={(reference) => {
                    try {
                      const references = [...draftState.references, reference];
                      contextPayload(projectId, references, draftState.extraContext);
                      draftState.setReferences(references);
                      setPanel('chat');
                    } catch (e) {
                      setError(message(e));
                    }
                  }}
                  onReviewBase={(branch) => {
                    setReviewTarget({ type: 'baseBranch', branch });
                    setModal('review');
                  }}
                />
              </div>
            )}
            {terminalMounted && (
              <div className="terminal-slot" hidden={panel !== 'terminal'}>
                <TerminalPanel
                  onShell={() => setTerminalProgram('shell')}
                  program={terminalProgram}
                  runtimeEpoch={network.epoch}
                  enabled={
                    terminalProgram === 'shell' ||
                    (active &&
                      network.configurationReady &&
                      !operations.error &&
                      !operations.operations.some((op) =>
                        ['pending', 'unknown'].includes(op.state),
                      ))
                  }
                  onServiceSettings={() => setModal('settings-admin')}
                  api={api}
                  events={events}
                  projectId={projectId}
                  connected={network.connection === 'connected' && network.runtimeConnected}
                  epoch={`${network.epoch}:${network.revision}`}
                />
              </div>
            )}
            {panel === 'diff' ? (
              <section className="diff-panel">
                <div className="section-heading">
                  <h2>当前回合修改</h2>
                </div>
                {conversation.diff ? (
                  <Diff text={conversation.diff} />
                ) : (
                  <p className="muted">
                    当前没有收到修改 diff。历史文件修改可在对应工具条目中展开查看。
                  </p>
                )}
              </section>
            ) : panel === 'chat' ? (
              <>
                {threadId ? (
                  <Messages
                    key={threadId}
                    api={api}
                    threadId={threadId}
                    project={project}
                    turns={conversation.turns}
                    timeline={conversation.timeline}
                    loading={conversation.loading}
                    complete={conversation.complete}
                    onMore={() => void conversation.loadMore()}
                    focusTarget={focusTarget}
                    active={conversation.active}
                    actionsDisabled={!workflowEnabled || conversation.active}
                    onAction={(turn, action) => setBranchAction({ turn, action })}
                  />
                ) : (
                  <Welcome
                    projectName={project?.name}
                    onSuggestion={(text) => draftState.setText(draft ? `${draft}\n${text}` : text)}
                  />
                )}
              </>
            ) : null}
            {visiblePrompts.length > 0 && (
              <Prompts
                compact={panel !== 'chat'}
                onOpen={() => setPanel('chat')}
                prompts={visiblePrompts}
                onAnswer={prompts.answer}
                contextTurns={conversation.turns}
                contextThreadId={threadId}
                onRefresh={conversation.refresh}
              />
            )}
          </div>
          <div ref={composerSlot} className="composer-slot" hidden={panel !== 'chat'}>
            <Composer
              onProviders={() => setModal('settings-provider')}
              projectId={projectId}
              threadId={resumedThread === threadId ? threadId : ''}
              epoch={resourceEpoch}
              references={draftState.references}
              extraContext={draftState.extraContext}
              outputSchema={draftState.outputSchema}
              onReferences={draftState.setReferences}
              onExtraContext={draftState.setExtraContext}
              onOutputSchema={draftState.setOutputSchema}
              onFiles={() => {
                setWorkspaceMounted(true);
                setPanel('files');
              }}
              api={api}
              contextKey={attachmentContext}
              value={draft}
              onChange={draftState.setText}
              savedAttachments={draftState.attachments}
              onAttachmentsChange={draftState.setAttachments}
              onAttachmentRemoved={draftState.removeAttachment}
              onSend={send}
              onStop={async () => {
                try {
                  await api.call('turn/interrupt', {
                    threadId,
                    ...(conversation.activeTurn ? { turnId: conversation.activeTurn.id } : {}),
                  });
                } catch (e) {
                  setError(message(e));
                }
              }}
              busy={isBusy}
              active={conversation.active}
              canSteer={Boolean(conversation.activeTurn)}
              modes={modes.data?.data ?? []}
              modesLoading={modes.loading}
              disabled={
                !directInputAllowed ||
                !project ||
                network.connection !== 'connected' ||
                !network.runtimeConnected ||
                !network.activityReady ||
                pending ||
                Boolean(operations.error) ||
                Boolean(draftState.error) ||
                (Boolean(threadId) && (!conversation.ready || resumedThread !== threadId))
              }
              options={options}
              onOptions={setOptions}
              models={models.items}
              moreModels={models.hasMore}
              modelsLoading={models.loading || modelCatalog.refreshing}
              modelsRefreshDisabled={!active || !network.configurationReady}
              onMoreModels={() => void models.more()}
              onRefreshModels={() => {
                void modelCatalog.refresh().then(() => {
                  models.refresh(); defaults.refresh(); modes.refresh();
                }).catch(() => {});
              }}
              defaults={composerDefaults}
              defaultsLoading={composerDefaultsLoading}
              existingThread={Boolean(threadId)}
              notice={
                modelCatalog.error || draftState.error ||
                (!directInputAllowed
                  ? '此子 Agent 尚未明确允许直接输入，可以查看结果。'
                  : !project
                    ? '请选择或添加一个项目'
                    : pending
                      ? '有一笔结果待确认的操作，请先查看上方回执'
                      : defaults.error
                        ? `默认值读取失败：${defaults.error}`
                        : models.error
                          ? `模型目录读取失败：${models.error}`
                          : models.warning
                            ? models.warning
                          : modes.error
                            ? `协作模式目录读取失败：${modes.error}`
                            : '')
              }
            />
            {Boolean(projectId) && !threadId && (defaults.error || retryingDefaults) && (
              <button
                type="button"
                className="button small"
                disabled={defaults.loading}
                onClick={() => {
                  if (defaults.loading) return;
                  setRetryingDefaults(true);
                  defaults.refresh();
                }}
              >
                {defaults.loading ? '正在读取模型设置…' : '重新读取模型设置'}
              </button>
            )}
          </div>
        </main>
        {active && (
          <>
            {mobile && (
              <Dialog title="导航" onClose={() => setMobile(false)}>
                {sidebar}
              </Dialog>
            )}
            {modal === 'loaded' && (
              <LoadedThreadsPanel
                api={api}
                epoch={resourceEpoch}
                connected={active && network.connection === 'connected' && network.runtimeConnected}
                enabled={active && network.activityReady}
                onOpenThread={(id) => {
                  openThread(id);
                }}
                onChanged={workflowChanged}
                onClose={() => setModal('')}
              />
            )}{' '}
            {modal === 'automations' && (
              <AutomationsPanel
                api={api}
                epoch={resourceEpoch}
                projects={projects}
                projectId={projectId}
                models={models.items}
                modelCatalog={models}
                modes={modes.data?.data ?? []}
                enabled={
                  active &&
                  network.connection === 'connected' &&
                  network.runtimeConnected &&
                  network.activityReady
                }
                idle={active && network.configurationReady}
                onOpenThread={(id) => {
                  void openThread(id);
                }}
                onChanged={workflowChanged}
                onClose={() => setModal('')}
              />
            )}{' '}
            {modal === 'organize' && (
              <OrganizationPanel
                api={api}
                epoch={resourceEpoch}
                projects={projects}
                projectId={projectId}
                threadId={threadId}
                enabled={
                  active &&
                  network.connection === 'connected' &&
                  network.runtimeConnected &&
                  network.activityReady
                }
                threadReady={workflowEnabled}
                threadIdle={!conversation.active}
                globalIdle={network.configurationReady}
                onChanged={workflowChanged}
                onDeleted={() => {
                  navigate('');
                  threads.refresh();
                }}
                onOpenThread={(id) => {
                  void openThread(id);
                }}
                onClose={() => setModal('')}
              />
            )}{' '}
            {modal === 'project' && (
              <ProjectDialog
                api={api}
                onClose={() => setModal('')}
                onAdded={projectsResource.refresh}
                onOpen={(id) => {
                  if (navigation.current !== modalNavigation) return;
                  if (!draftState.canLeave()) {
                    setError('项目已添加。当前草稿尚未安全保存，请先复制或保存草稿，再从项目列表打开新项目。');
                    return;
                  }
                  if (!navigate('', { projectId: id })) return;
                  setArchived(false);
                  setQuery('');
                  setSearch('');
                }}
              />
            )}{' '}
            {modal === 'rename' && (
              <RenameDialog
                api={api}
                threadId={threadId}
                name={title}
                onClose={() => setModal('')}
                onSaved={() => {
                  threads.refresh();
                  conversation.refresh();
                }}
              />
            )}{' '}
            {(modal === 'settings' || modal === 'settings-admin' || modal === 'settings-provider') && (
              <Settings
                initialTab={modal === 'settings-admin' ? 'admin' : modal === 'settings-provider' ? 'provider' : 'general'}
                onOpenNativeTerminal={(id) => {
                  if (!navigate('', { projectId: id })) return;
                  setTerminalProgram('codex');
                  setTerminalMounted(true);
                  setPanel('terminal');
                }}
                runtimeEpoch={network.epoch}
                connectionId={network.connectionId}
                threadId={threadId}
                threadReady={
                  active &&
                  network.connection === 'connected' &&
                  network.runtimeConnected &&
                  conversation.ready &&
                  resumedThread === threadId &&
                  directInputAllowed
                }
                threadIdle={!conversation.active}
                lease={`${network.epoch}:${network.revision}:${active && network.runtimeConnected ? 'online' : 'offline'}`}
                connected={active && network.connection === 'connected' && network.runtimeConnected}
                projectId={projectId}
                configurationReady={active && network.configurationReady}
                api={api}
                epoch={resourceEpoch}
                events={events}
                projects={projects}
                theme={theme}
                onTheme={setTheme}
                onClose={() => setModal('')}
                onChanged={() => setConfigRevision((v) => v + 1)}
                onProjectsChanged={projectsResource.refresh}
                onOpenThread={(id) => { void openThread(id); }}
                onOpenDraft={(key) => {
                  const branch = branchDraftSource(key);
                  if (branch) {
                    if (openThread(branch.threadId)) setRestoreBranch(branch);
                    return;
                  }
                  if (key.startsWith('new:')) {
                    navigate('', { projectId: key.slice(4) });
                  } else openThread(key);
                }}
                onLogout={logout}
              />
            )}{' '}
            {modal === 'guardian' && threadId && (
              <GuardianReviewPanel
                key={threadId + resourceEpoch}
                api={api}
                events={events}
                epoch={resourceEpoch}
                threadId={threadId}
                enabled={workflowEnabled}
                idle={!conversation.active && !conversation.realtimeActive}
                onChanged={workflowChanged}
                onLocate={(turnId, itemId) => {
                  setModal('');
                  setPanel('chat');
                  setFocusTarget({ turnId, itemId });
                }}
                onClose={() => setModal('')}
              />
            )}{' '}
            {modal === 'execution' && threadId && (
              <ThreadExecutionSettings
                key={threadId + resourceEpoch}
                api={api}
                events={events}
                threadId={threadId}
                projectId={projectId}
                epoch={resourceEpoch}
                enabled={workflowEnabled && !conversation.realtimeActive}
                activeTurnId={conversation.activeTurn?.id}
                models={models.items}
                moreModels={models.hasMore}
                modelsLoading={models.loading}
                onMoreModels={() => void models.more()}
                onChanged={() => setResumeRevision((v) => v + 1)}
                onClose={() => setModal('')}
              />
            )}{' '}
            {modal === 'tasks' && threadId && (
              <TaskPanel
                key={threadId + resourceEpoch}
                api={api}
                threadId={threadId}
                epoch={resourceEpoch}
                enabled={workflowEnabled}
                active={conversation.active}
                events={events}
                onOpenThread={workflowOpenThread}
                onChanged={workflowChanged}
                onClose={() => setModal('')}
              />
            )}{' '}
            {modal === 'history' && threadId && (
              <HistoryTools
                key={threadId + resourceEpoch}
                api={api}
                threadId={threadId}
                epoch={resourceEpoch}
                turns={conversation.turns}
                onClose={() => setModal('')}
                onLocate={(turnId, itemId) => {
                  setPanel('chat');
                  setFocusTarget({ turnId, itemId });
                }}
              />
            )}{' '}
            {modal === 'review' && project && (
              <ReviewDialog
                key={threadId + resourceEpoch}
                api={api}
                threadId={threadId}
                projectId={projectId}
                initialTarget={reviewTarget}
                initialSeparate={Boolean(reviewTarget) || !threadId}
                enabled={
                  active &&
                  network.connection === 'connected' &&
                  network.runtimeConnected &&
                  network.activityReady
                }
                inlineEnabled={workflowEnabled && !conversation.active}
                onClose={() => setModal('')}
                onChanged={workflowChanged}
                onOpenThread={workflowOpenThread}
                onCreatedThread={workflowHandoff}
              />
            )}{' '}
            {branchAction && threadId && (
              <BranchDialog
                key={threadId + resourceEpoch + branchAction.turn.id + branchAction.action}
                api={api}
                threadId={threadId}
                enabled={
                  workflowEnabled && (branchAction.action !== 'revert' || !conversation.active)
                }
                turn={branchAction.turn}
                action={branchAction.action}
                onChanged={workflowChanged}
                onClose={() => setBranchAction(undefined)}
                memoryDraft={branchMemory.current.get(
                  branchDraftKey(threadId, branchAction.turn.id),
                )}
                onDraft={(text) => {
                  const key = branchDraftKey(threadId, branchAction.turn.id);
                  branchMemory.current.delete(key);
                  branchMemory.current.set(key, text);
                  while (branchMemory.current.size > 20)
                    branchMemory.current.delete(branchMemory.current.keys().next().value!);
                }}
                onFork={(id, text) => finishBranch(id, text, false)}
                onCreatedFork={(id, text) => finishBranch(id, text, true)}
              />
            )}
            {draftGuard && (
              <Dialog title="草稿尚未保存" onClose={() => { setDraftGuard(false); setDiscardRevision(undefined); }}>
                <p>当前输入只保留在页面中。请先保存，或明确放弃未保存的修改，再切换项目或会话。</p>
                {discardRevision ? <>
                  <p>确认放弃这次未保存的修改，并恢复本页最近保存的版本？其他草稿不会改变。</p>
                  {discardRevision !== draftState.revision && <p role="status">输入已变化，请重新确认当前修改。</p>}
                  <button className="button danger" disabled={discardRevision !== draftState.revision}
                    onClick={() => {
                      if (draftState.discardUnsaved(discardRevision)) {
                        setDraftGuard(false);
                      }
                      setDiscardRevision(undefined);
                    }}>确认放弃未保存的修改</button>
                  {discardRevision !== draftState.revision && <button className="button"
                    onClick={() => setDiscardRevision(draftState.revision)}>重新确认当前修改</button>}
                </> : <>
                  <button className="button" onClick={() => {
                    if (draftState.retrySave()) setDraftGuard(false);
                  }}>重试保存草稿</button>
                  <button className="button" onClick={() => setDiscardRevision(draftState.revision)}>放弃未保存的修改</button>
                </>}
                <button className="button" onClick={() => { setDraftGuard(false); setDiscardRevision(undefined); }}>返回继续编辑</button>
              </Dialog>
            )}
          </>
        )}
      </div>
    </HookEventsProvider>
  );
}
