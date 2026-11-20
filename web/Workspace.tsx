import { modelSupportsEffort, providerModels, providerRelation } from './lib/provider-models';
import { uuid } from './lib/ids';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api, RpcError } from './lib/api';
import { Events } from './lib/events';
import { consumeThreadOperations, listOperations, reconcileOperation, retireOldTerminalHandoffs } from './lib/operations';
import {
  array,
  composing,
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
  readDraft,
  clearDraftSnapshot,
  executionDraftContext,
  executionDraftKey,
  writeDraft,
  type DraftMode,
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
import { timelineView } from './lib/timeline';
import { useConversation } from './hooks/useConversation';
import { usePrompts } from './hooks/usePrompts';
import { useDraft } from './hooks/useDraft';
import { useResume } from './hooks/useResume';
import { useModelCatalogRefresh } from './hooks/useModelCatalogRefresh';
import { useSidebarRefresh } from './hooks/useSidebarRefresh';
import { ModelDirectoryContext } from './hooks/useModelDirectory';
import { Sidebar } from './components/Sidebar';
import type { ThreadSearchSortKey } from '../protocol/ts/v2/ThreadSearchSortKey';
import { Recovery, useOperations } from './components/Recovery';
import { ProjectDialog } from './components/ProjectDialog';
import { SidebarManagementDialog, type SidebarAction } from './components/SidebarManagementDialog';
import { Welcome } from './components/Welcome';
import { Composer, type Attachment, type SendIntent } from './components/Composer';
import { Diff, Messages } from './components/Messages';
import { Prompts } from './components/Prompts';
import { SettingsOnDemand, TerminalOnDemand } from './components/DeferredPanel';
import { EmergencyRecovery } from './components/EmergencyRecovery';
import { RootExecutionNotice } from './components/ExecutionModeSettings';
import { Dialog } from './components/Dialog';
import { ThreadConversionDialog } from './components/ThreadConversionDialog';
import { Icon } from './components/Icon';
import { UsagePopover } from './components/UsagePopover';
import { RenameDialog } from './components/RenameDialog';
import { ArchiveActions } from './components/ArchiveActions';
import { RealtimePanel } from './components/RealtimePanel';
import { ProcessPanel } from './components/ProcessPanel';
import { TaskPanel } from './components/TaskPanel';
import { ThreadTerminals } from './components/ThreadTerminals';
import { HookEventsProvider } from './components/HookEventsPanel';
import { LoadedThreadsPanel } from './components/LoadedThreadsPanel';
import { PredictionPanel } from './components/PredictionPanel';
import { GuardianReviewPanel } from './components/GuardianReviewPanel';
import { ThreadExecutionSettings } from './components/ThreadExecutionSettings';
import { BranchDialog, HistoryTools, ReviewDialog } from './components/HistoryTools';
import { WorkspacePanel } from './components/WorkspacePanel';
import { McpEventBridge } from './components/McpPanel';
import { OrganizationPanel } from './components/OrganizationPanel';
import { AutomationsPanel } from './components/AutomationsPanel';

const terminalHistoryMissing = '后台进程的历史条目尚未加载，请重新读取完整会话。';
const terminalHistoryAmbiguous = '多个回合含有相同的历史条目标识，请在会话中搜索该命令。';
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
  const [recoveryOpen, setRecoveryOpen] = useState(false);
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
  const [draftMode, setDraftMode] = useState<DraftMode>(() => {
    const url = new URL(location.href);
    if (url.searchParams.has('thread') || url.searchParams.has('executionMode')) return url.searchParams.get('executionMode') === 'root' ? 'root' : 'native';
    try { return sessionStorage.getItem('harness.execution-mode') === 'root' ? 'root' : 'native'; } catch { return 'native'; }
  });
  const latestDraftMode = useRef(draftMode); latestDraftMode.current = draftMode;
  const contextKey = executionDraftKey(threadId || `new:${projectId}`, draftMode),
    draftState = useDraft(contextKey),
    draft = draftState.text,
    options = draftState.options;
  const [threadOrder, setThreadOrder] = useState<'recency_at' | 'section_position'>('recency_at');
  const [searchOrder, setSearchOrder] = useState<ThreadSearchSortKey>('recency_at');
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
  const [sidebarManagement, setSidebarManagement] = useState<{
    selection: SidebarAction; key: string; navigation: number; canLeave: () => boolean; returnToProjects?: boolean;
  }>();
  const [threadTerminalsMounted, setThreadTerminalsMounted] = useState(false),
    [predictionMounted, setPredictionMounted] = useState(false);
  const [terminalProgram, setTerminalProgram] = useState<'shell' | 'codex' | 'codex-cloud'>(
    'shell',
  );
  const threadMenu = useRef<HTMLDetailsElement>(null),
    workspaceBody = useRef<HTMLDivElement>(null),
    composerSlot = useRef<HTMLDivElement>(null);
  const [ownsTerminal, setOwnsTerminal] = useState(false);
  const [terminalSwitch, setTerminalSwitch] = useState<typeof terminalProgram>();
  const openTerminalProgram = (next: typeof terminalProgram) => {
    if (next !== terminalProgram && ownsTerminal) { setTerminalSwitch(next); return; }
    setTerminalProgram(next); setTerminalMounted(true); setPanel('terminal');
  };
  const [panelFocusRevision, setPanelFocusRevision] = useState(0),
    pendingPanelFocus = useRef(false);
  const setPanel = (next: typeof panel, focus = true) => {
    if (threadMenu.current) threadMenu.current.open = false;
    pendingPanelFocus.current = focus;
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
    const target = panel === 'chat' ? workspaceBody.current : (heading ?? workspaceBody.current);
    if (target) {
      if (!(target instanceof HTMLTextAreaElement)) target.tabIndex = -1;
      target.focus({ preventScroll: true });
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
  const newlyAddedProject = useRef<{ id: string; before: unknown } | undefined>(undefined);
  const [draftGuard, setDraftGuard] = useState(false),
    [discardRevision, setDiscardRevision] = useState<string>();
  const pendingNavigation = useRef<{ projectId: string; threadId: string; key: string; mode: DraftMode; apply: () => void } | undefined>(undefined)
  const compacting = useRef(new Set<string>());
  const [completedHandoff, setCompletedHandoff] = useState<{
    id: string; navigation: number; message: string;
  }>();
  const [branchAction, setBranchAction] = useState<{
    turn: Turn;
    action: 'fork' | 'edit' | 'revert';
    restoredText?: string;
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
  const committedIndex = useRef<number>(Number.isSafeInteger(history.state?.harnessIndex) ? history.state.harnessIndex : 0);
  const restoringIndex = useRef<number | undefined>(undefined);
  useEffect(() => {
    history.replaceState({ ...history.state, harnessIndex: committedIndex.current }, '', location.href);
  }, []);
  const changeContext = (nextProject: string, nextThread: string, apply: () => void, accepted?: () => boolean) => {
    if (executionBlocked) { setError('执行身份已变化或尚未确认。请先保留当前草稿并完成身份切换。'); return false; }
    if (!draftState.canNavigateTo(executionDraftKey(nextThread || `new:${nextProject}`, draftMode)) && !accepted?.()) {
      pendingNavigation.current ??= { projectId: nextProject, threadId: nextThread, key: contextKey, mode: draftMode, apply };
      setDiscardRevision(undefined);
      setDraftGuard(true);
      return false;
    }
    setProjectId(nextProject);
    setThreadId(nextThread);
    pendingNavigation.current = undefined;
    apply();
    return true;
  };
  const navigate = (id: string, settings: {
    afterNavigate?: () => void; keepDrawer?: boolean; historyIndex?: number; historyUrl?: string; projectId?: string; preserveAttachments?: boolean; fromHistory?: boolean; accepted?: () => boolean;
  } = {}) => changeContext(settings.projectId ?? projectId, id, () => {
    navigation.current++;
    setModal('');
    setBranchAction(undefined);
    setFocusTarget(undefined);
    if (!settings.preserveAttachments && executionDraftKey(id || `new:${settings.projectId ?? projectId}`, draftMode) !== contextKey)
      setAttachmentContext(uuid());
    setPanel('chat');
    if (!settings.keepDrawer) setMobile(false);
    setError('');
    const url = new URL(settings.historyUrl ?? location.href);
    if (id) url.searchParams.set('thread', id);
    else url.searchParams.delete('thread');
    if (draftMode === 'root') url.searchParams.set('executionMode', 'root');
    else url.searchParams.delete('executionMode');
    if (!settings.fromHistory) {
      const index = committedIndex.current + 1;
      history.pushState({ harnessIndex: index }, '', url);
      committedIndex.current = index;
    } else if (settings.historyIndex !== undefined) {
      const offset = settings.historyIndex - (history.state?.harnessIndex ?? committedIndex.current);
      if (offset) { restoringIndex.current = settings.historyIndex; history.go(offset); }
      committedIndex.current = settings.historyIndex;
    }
    committedUrl.current = url.href;
    settings.afterNavigate?.();
  }, settings.accepted);
  const latestNavigate = useRef(navigate);
  const continueNavigation = () => {
    const pending = pendingNavigation.current;
    pendingNavigation.current = undefined;
    if (!pending || pending.key !== contextKey || pending.mode !== draftMode) return;
    if (!pending.threadId && pending.projectId && !projects.some(project => project.id === pending.projectId)) {
      setError('原先选择的项目已不可用，草稿已保留，请重新选择。'); return;
    }
    changeContext(pending.projectId, pending.threadId, pending.apply);
  };
  latestNavigate.current = navigate;
  const openThread = (id: string, afterNavigate?: () => void) => navigate(id, { afterNavigate: () => {
    setResumeRevision(v => v + 1);
    afterNavigate?.();
  } });
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
      if (event.type === 'resync') {
        setConfigRevision(value => value + 1);
        setResumeRevision(value => value + 1);
        setArchiveSelection(undefined);
      }
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
  const runtimeNetwork = useEvents(api, receive, active);
  const modeChanged = runtimeNetwork.executionModeConfirmed && runtimeNetwork.executionMode?.mode !== draftMode;
  const executionBlocked = modeChanged || ((draftMode === 'root' || Boolean(runtimeNetwork.executionMode)) && !runtimeNetwork.executionModeConfirmed);
  // Keep the old draft owner until it is durable. All native consumers see the
  // closed gate immediately, before the passive effect releases the old thread.
  const network = executionBlocked ? { ...runtimeNetwork, runtimeConnected: false, activityReady: false, configurationReady: false } : runtimeNetwork;
  const resourceEpoch = `${network.epoch}:${network.revision}:${configRevision}`;
  useEffect(() => {
    if (!modeChanged || !runtimeNetwork.executionMode) return;
    const next = runtimeNetwork.executionMode.mode;
    if (!draftState.canNavigateTo(executionDraftKey(`new:${projectId}`, next))) return;
    navigation.current++;
    setDraftMode(next); setThreadId(''); setBranchAction(undefined); setRestoreBranch(undefined); setFocusTarget(undefined);
    setArchiveSelection(undefined); setCompletedHandoff(undefined); setAttachmentContext(uuid()); setError('');
    setPanelState('chat'); setVoiceMounted(false); setProcessMounted(false); setTerminalMounted(false);
    setThreadTerminalsMounted(false); setPredictionMounted(false); setWorkspaceMounted(false);
    setModal(current => current === 'settings-admin' ? current : '');
    const url = new URL(location.href); url.searchParams.delete('thread');
    if (next === 'root') url.searchParams.set('executionMode', 'root'); else url.searchParams.delete('executionMode');
    history.replaceState({ ...history.state, harnessIndex: committedIndex.current }, '', url); committedUrl.current = url.href;
    try { sessionStorage.setItem('harness.execution-mode', next); } catch { /* The URL also identifies this draft namespace. */ }
  }, [modeChanged, runtimeNetwork.executionMode?.mode, draftState.hasUnsaved, draftState.revision, projectId]);
  const projectsResource = useResource(resourceEpoch, (signal) =>
    api.call('project/list', {}, signal), true, true,
  );
  const projects = useMemo(() => array<Project & { path?: string }>(
    projectsResource.data?.projects ?? projectsResource.data?.data,
  ).map((p) => ({ ...p, cwd: p.cwd ?? p.path ?? '' })), [projectsResource.data]);
  const threadListKey = JSON.stringify([resourceEpoch, projectId, archived, search, search ? searchOrder : threadOrder]);
  const threads = usePaged<Thread>(
    api,
    'thread/list',
    {
      projectId,
      archived,
      sortKey: threadOrder,
      sortDirection: threadOrder === 'section_position' ? 'asc' : 'desc',
    },
    threadListKey,
    Boolean(projectId) && !search,
  );
  const searchThreads = usePaged<{ thread: Thread; snippet: string }>(
    api,
    'thread/search',
    { projectId, archived, searchTerm: search, sortKey: searchOrder, sortDirection: 'desc' },
    threadListKey,
    Boolean(projectId && search),
  );
  const refreshSidebar = useSidebarRefresh(events, resourceEpoch, {
    projects: projectsResource.refresh, threads: threads.refresh, search: searchThreads.refresh,
  });
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
  const models = usePaged<Model>(api, 'model/list', {},
    JSON.stringify([api.csrf, resourceEpoch, runtimeNetwork.executionMode?.mode, runtimeNetwork.executionMode?.effectiveUid]),
    active && network.connection === 'connected' && network.runtimeConnected && !network.restarting);
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
  const conversation = useConversation(api, events, network.runtimeConnected ? threadId : '', resourceEpoch),
    prompts = usePrompts(api, events, resourceEpoch);
  const displayedHistory = useMemo(() => timelineView(conversation.turns, conversation.timeline), [conversation.turns, conversation.timeline]);
  // A historical thread owns its cwd. A remembered sidebar selection must never
  // authorize file or terminal actions in another project while history loads.
  const project = threadId ? projects.find(p => p.cwd === conversation.thread?.cwd) : projects.find(p => p.id === projectId);
  const [showOfflineRecovery, setShowOfflineRecovery] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState('');
  const wasOffline = useRef(false);
  useEffect(() => {
    if (network.connection === 'connected' && network.runtimeConnected && network.activityReady) {
      if (wasOffline.current) setConnectionNotice('连接已恢复。');
      wasOffline.current = false;
      setShowOfflineRecovery(false);
      return;
    }
    if (network.connection === 'offline' || (network.connection === 'connected' && !network.runtimeConnected)) wasOffline.current = true;
    setConnectionNotice('');
    const timer = setTimeout(() => setShowOfflineRecovery(true), 3000);
    return () => clearTimeout(timer);
  }, [network.connection, network.runtimeConnected, network.activityReady]);
  const missingThreadProject = Boolean(threadId && conversation.thread?.cwd && !project);
  const operations = useOperations();
  useEffect(() => {
    if (network.connection === 'connected' && network.runtimeConnected && network.connectionId)
      void retireOldTerminalHandoffs({ clientId: api.clientId, connectionId: `${network.epoch}:${network.revision}` })
        .catch(failure => setError(message(failure)));
  }, [api, network.connection, network.runtimeConnected, network.connectionId, network.epoch, network.revision]);
  const settingsReceipts = operations.operations
    .filter(
      (op) =>
        op.state === 'accepted' &&
        [...INPUT_METHODS, 'thread/resume', 'thread/settings/update', 'thread/fork', 'review/startNew', 'thread/convert'].includes(op.method) &&
        (op.resolvedThreadId || op.threadId) === threadId,
    )
    .map((op) => op.id)
    .join(',');
  const modelReceiptKey = operations.operations.filter(op => op.state === 'accepted' &&
    (!INPUT_METHODS.includes(op.method) || op.settingsOverride !== false) && (op.resolvedThreadId || op.threadId) === threadId).map(op => op.id).join(',');
  const resume = useResume(
    api,
    network.runtimeConnected ? threadId : '',
    `${resourceEpoch}:${resumeRevision}:${settingsReceipts}`,
    conversation.refresh, resourceEpoch, `${resourceEpoch}:${resumeRevision}:${modelReceiptKey}`,
  );
  const { resumedThread, threadDefaults } = resume;
  const composerDefaults = threadId ? threadDefaults : defaults.data;
  const composerDefaultsLoading = threadId ? resumedThread !== threadId :
    defaults.loading || JSON.stringify(options) !== JSON.stringify(debouncedOptions);
  useEffect(() => {
    if (threadId && resumedThread === threadId && threadDefaults && !resume.loading && settingsReceipts)
      void consumeThreadOperations(threadId, settingsReceipts.split(',')).catch((failure) => setError(message(failure)));
  }, [threadId, resumedThread, threadDefaults, resume.loading, settingsReceipts]);
  const effectiveProvider = options.modelProvider ?? (threadId ? threadDefaults?.modelProvider : defaults.data?.modelProvider);
  const modelCatalog = useModelCatalogRefresh(api, typeof effectiveProvider === 'string' ? effectiveProvider : undefined,
    active && network.configurationReady && network.connection === 'connected' && network.runtimeConnected, resourceEpoch,
    !active || network.connection !== 'connected' || !network.runtimeConnected ? '连接恢复后可同步模型目录。' :
      executionBlocked ? '执行身份确认后可同步模型目录。' : '请先结束正在运行的任务，再同步供应商模型目录。');
  const isBusy = busy.has(contextKey);
  const pending = operations.operations.some(
    (op) =>
      ['pending', 'unknown'].includes(op.state) &&
      (threadId
        ? op.threadId === threadId || op.resolvedThreadId === threadId
        : op.projectId === projectId && INPUT_METHODS.includes(op.method)),
  );
  const sourceProvider = typeof threadDefaults?.modelProvider === 'string' ? threadDefaults.modelProvider :
    typeof object(conversation.thread).modelProvider === 'string' ? object(conversation.thread).modelProvider as string : undefined;
  const directoryComplete = !models.hasMore && !models.loading && !models.error && !models.warning;
  const sameProvider = (target: string) => sourceProvider !== undefined &&
    providerRelation(models.items, sourceProvider, target, directoryComplete) === 'same';
  // The shared catalog remains complete. Only the current conversation's controls are scoped.
  const composerModels = !threadId ? models.items : sourceProvider
    ? providerModels(models.items, sourceProvider, directoryComplete) : [];
  const setOptions = (next: Options) => {
    const modelChanged = next.model !== options.model || next.modelProvider !== options.modelProvider;
    if (threadId && modelChanged && (!sourceProvider || next.modelProvider && !sameProvider(next.modelProvider))) {
      setError(sourceProvider ? '如需使用其他供应商，请从会话操作中选择“切换供应商 / 转换会话”。' :
        '会话供应商尚未读取，请等待会话读取完成后再选择模型。');
      return;
    }
    draftState.setOptions(next);
  };
  const draftProviderRelation = threadId && options.modelProvider
    ? sourceProvider ? providerRelation(models.items, sourceProvider, options.modelProvider, directoryComplete) : 'unknown' : 'same';
  const foreignDraftModel = draftProviderRelation !== 'same';
  useEffect(() => {
    if (draftProviderRelation !== 'different') return;
    const { model: _model, modelProvider: _provider, effort: _effort, ...retained } = options;
    draftState.setOptions(retained);
    setError('已移除草稿中其他供应商的模型和强度选择，正文、附件及其他设置均保留。切换供应商请使用会话操作中的转换入口。');
  }, [threadId, sourceProvider, options.modelProvider, draftProviderRelation]);
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
  const fullHistoryWorkflowEnabled = workflowEnabled && conversation.complete;
  useEffect(() => {
    if (restoreBranch && threadId === restoreBranch.threadId && conversation.loadedThreadId === threadId && conversation.ready) {
      const row = displayedHistory.rows.find(row => row.type === 'turn' && row.turn.id === restoreBranch.turnId);
      if (row?.type === 'turn' && row.turn.itemsView === 'summary') {
        const key = branchDraftKey(threadId, row.turn.id, draftMode);
        try {
          const text = branchMemory.current.get(key) ?? readDraft(key).text;
          if (!['completed', 'failed', 'interrupted'].includes(row.turn.status))
            setError('原回合尚未确认结束，请稍后恢复分支草稿。');
          else if (text) setBranchAction({ turn: row.turn, action: 'edit', restoredText: text });
          else setError('当前窗口只包含部分回合，无法从中恢复原始消息。请在设置中查看分支草稿。');
        } catch (error) { setError(message(error)); }
      } else if (row?.type === 'turn') setBranchAction({ turn: row.turn, action: 'edit' });
      else setError(conversation.truncated ? '最近的会话窗口没有显示原回合。分支草稿仍保留，可在设置中查看和复制，或在会话中搜索原消息。' :
        '原回合已不在会话历史中。分支草稿仍保留，可在设置中查看和复制。');
      setRestoreBranch(undefined);
    }
  }, [restoreBranch, threadId, conversation.loadedThreadId, conversation.ready, displayedHistory, draftMode]);
  const visiblePrompts = executionBlocked ? [] : prompts.prompts.filter((p) => !p.threadId || p.threadId === threadId);
  useEffect(() => {
    const term = query.trim();
    if (!term) return;
    const timer = setTimeout(() => setSearch(term), 250);
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
    if (executionBlocked || !projectsResource.data || threadId) return;
    if (newlyAddedProject.current?.id === projectId) {
      if (projectsResource.data === newlyAddedProject.current.before && !projects.some(p => p.id === projectId)) return;
      newlyAddedProject.current = undefined;
    }
    if (projects.some(p => p.id === projectId)) return;
    const next = projects[0]?.id ?? '';
    if (!next && !projectId) return;
    if (!projectId && draftState.key === contextKey && (draft || draftState.attachments.length ||
        draftState.references.length || draftState.extraContext.length || draftState.outputSchema || Object.keys(options).length)) {
      try {
        if (!draftState.flush()) return;
        const targetKey = executionDraftKey('new:' + next, draftMode), target = readDraft(targetKey);
        if (!target.text && !target.attachments.length && !target.references.length && !target.extraContext.length &&
            !target.outputSchema && !Object.keys(target.options).length) {
          writeDraft({ key: targetKey, text: draft, attachments: draftState.attachments, options,
            references: draftState.references, extraContext: draftState.extraContext, outputSchema: draftState.outputSchema,
            revision: uuid(), updatedAt: Date.now() });
          clearDraftSnapshot(contextKey, draftState.revision);
        } else setError('项目已有独立草稿，欢迎页的输入已留存在设置的本地草稿中。');
      } catch (e) { setError('草稿尚未安全交接：' + message(e)); return; }
    } else if (projectId) setError('当前项目已从项目列表移除。原草稿仍保留，请选择可用项目。');
    changeContext(next, threadId, () => {});
  }, [executionBlocked, projectsResource.data, threadId, projectId]);
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
    if (executionBlocked || !threadId || !conversation.thread?.cwd || !projects.length) return;
    const matching = projects.find((p) => p.cwd === conversation.thread?.cwd);
    if (matching) changeContext(matching.id, threadId, () => {});

  }, [executionBlocked, conversation.thread?.cwd, projectsResource.data, threadId]);
  useEffect(() => {
    const back = () => {
      const url = new URL(location.href), mode = url.searchParams.get('executionMode') === 'root' ? 'root' : 'native';
      const index = history.state?.harnessIndex;
      if (restoringIndex.current !== undefined && index === restoringIndex.current) { restoringIndex.current = undefined; return; }
      if (mode !== latestDraftMode.current) setError('此历史位置属于另一执行模式，请先切换模式。');
      else if (latestNavigate.current(url.searchParams.get('thread') ?? '', { fromHistory: true,
        historyIndex: Number.isSafeInteger(index) ? index : undefined, historyUrl: url.href,
        afterNavigate: () => setResumeRevision(v => v + 1) })) return;
      if (Number.isSafeInteger(index) && index !== committedIndex.current) {
        restoringIndex.current = committedIndex.current;
        history.go(committedIndex.current - index);
      } else history.replaceState({ ...history.state, harnessIndex: committedIndex.current }, '', committedUrl.current);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  useEffect(() => {
    if (runtimeNetwork.connection !== 'connected' || !runtimeNetwork.runtimeConnected) return;
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
  }, [api, runtimeNetwork.revision, runtimeNetwork.connection, runtimeNetwork.runtimeConnected]);
  const changeArchive = async (nextArchived: boolean) => {
    if (archiveBusy || executionBlocked) return;
    const target = threadId,
      nav = navigation.current,
      canLeave = draftState.canLeave;
    setArchiveBusy(true);
    setError('');
    try {
      await api.mutate(nextArchived ? 'thread/archive' : 'thread/unarchive', { threadId: target });
      refreshSidebar();
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
  const manageSidebar = (selection: SidebarAction) => {
    setSidebarManagement({ selection, key: uuid(), navigation: navigation.current, canLeave: draftState.canLeave, returnToProjects: modal.startsWith('settings') });
    setMobile(false);
    setModal('sidebar-management');
  };
  const send = async (attachments: Attachment[], intent: SendIntent = 'send'): Promise<boolean> => {
    if (!draftState.flush()) return false;
    const submit = (method: string, params: Record<string, unknown>) => draftMode === 'root'
      ? api.mutate(method, params, 'root') : api.mutate(method, params);
    const key = contextKey,
      text = draft,
      nav = navigation.current,
      canLeaveAfterAcceptance = draftState.canLeaveAfterAcceptance;
    if (
      !project || executionBlocked || foreignDraftModel ||
      pending ||
      isBusy ||
      draftState.error ||
      !directInputAllowed ||
      (intent === 'queue' && !conversation.complete) ||
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
      const context = contextPayload(project!.id, draftState.references, draftState.extraContext),
        schema = parseOutputSchema(draftState.outputSchema);
      if (intent !== 'send' && schema) throw new Error('结构化输出只支持普通发送。');
      const structured = schema ? { outputSchema: schema } : {};
      if (!target) {
        const result = await submit('conversation/start', {
          projectId,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
          options: {
            ...executionOptions(options, defaults.data, modes.data?.data ?? [], models.items),
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
        refreshSidebar();
      } else if (intent === 'queue')
        await submit('thread/queue/add', {
          threadId: target,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
        });
      else if (intent === 'steer')
        await submit('turn/steer', {
          threadId: target,
          expectedTurnId: conversation.activeTurn!.id,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
        });
      else
        await submit('turn/start', {
          threadId: target,
          text,
          ...context,
          attachmentIds: attachments.map((a) => a.attachmentId),
          options: {
            ...executionOptions(options, threadDefaults, modes.data?.data ?? [], models.items),
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
  const afterProjectCreated = useRef<(id: string) => void>(() => {});
  afterProjectCreated.current = id => {
    newlyAddedProject.current = { id, before: projectsResource.data };
    if (!navigate('', { projectId: id, afterNavigate: () => {
      setArchived(false); setQuery(''); setSearch('');
    } })) setError('项目已添加。当前草稿尚未安全保存，请保留或复制输入后再切换。');
  };
  const loadThread = async (automatic = false) => {
    if (
      !threadId || foreignDraftModel ||
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
      let modelOptions: Record<string, unknown> | undefined;
      if (options.model) {
        const provider = options.modelProvider ?? sourceProvider;
        if (!provider) throw new Error('会话供应商尚未确认，请先重新读取会话。');
        const matches = providerModels(models.items, provider, directoryComplete).filter(row => (row.model ?? row.id) === options.model);
        const selected = matches.length === 1 ? matches[0] : undefined;
        if (!selected || models.loading) throw new Error('请从当前模型目录选择可用模型，再加载会话。');
        if (options.effort && !modelSupportsEffort(selected, options.effort))
          throw new Error('所选思考强度已不适用于当前模型，请重新选择或清除本次强度设置。');
        modelOptions = { modelProvider: selected.modelProvider ?? provider, model: options.model, ...(options.effort ? { effort: options.effort } : {}) };
      }
      await api.mutate('thread/resume', { threadId: target, ...(automatic ? { automatic: true } : {}), ...(modelOptions ? { options: modelOptions } : {}) }, draftMode);
      if (navigation.current === nav) setResumeRevision((v) => v + 1);
    } catch (e) {
      if (navigation.current === nav) {
        if (e instanceof RpcError && e.code === 'continuation_confirmation_required')
          resume.requireContinuationConfirmation();
        setError(message(e));
      }
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const autoLoadAttempt = useRef('');
  useEffect(() => {
    const attempt = JSON.stringify([threadId, resourceEpoch, resumeRevision, options.modelProvider, options.model, options.effort]);
    if (!active || !threadId || selectedArchived === true || !resume.requiresResume || resume.requiresContinuationConfirmation ||
      autoLoadAttempt.current === attempt || foreignDraftModel || pending || isBusy || !conversation.ready || operations.error ||
      Boolean(options.model && options.modelProvider && models.loading) ||
      network.connection !== 'connected' || !network.runtimeConnected || !network.activityReady) return;
    autoLoadAttempt.current = attempt;
    void loadThread(true);
  }, [threadId, resourceEpoch, resumeRevision, active, selectedArchived, resume.requiresResume, resume.requiresContinuationConfirmation,
    options.modelProvider, options.model, options.effort, models.loading,
    foreignDraftModel, pending, isBusy, conversation.ready, operations.error, network.connection, network.runtimeConnected, network.activityReady]);
  const workflowChanged = () => {
    refreshSidebar();
    if (navigation.current === modalNavigation) {
      conversation.refresh();
      setResumeRevision((v) => v + 1);
    }
  };
  const currentOpenThread = useRef(openThread);
  currentOpenThread.current = openThread;
  const workflowOpenThread = useCallback((id: string) => {
    if (navigation.current === modalNavigation) currentOpenThread.current(id);
  }, [modalNavigation]);
  const clearFocusTarget = useCallback(() => setFocusTarget(undefined), []);
  const onMessageAction = useCallback((turn: Turn, action: 'fork' | 'edit' | 'revert') => setBranchAction({ turn, action }), []);
  const workflowHandoff = (id: string) => {
    refreshSidebar();
    if (navigation.current !== modalNavigation) return;
    if (draftState.canLeave()) openThread(id);
    else setCompletedHandoff({
      id, navigation: modalNavigation, message: '新会话已创建，当前输入仍保留在这里。',
    });
  };
  const finishBranch = (id: string, text: string | undefined, automatic: boolean) => {
    if (text !== undefined) {
      try {
        const key = executionDraftKey(id, draftMode);
        writeDraft({ ...emptyDraft(key), text });
        draftChanged(key);
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
    navigate('', { projectId, afterNavigate: () => {
    setWorkspaceMounted(true);
    setPanel('files');
    setWorkspaceRequest((previous) => ({
      projectId,
      path,
      revision: (previous?.revision ?? 0) + 1,
    }));
    } });
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
      searchSort={search ? { value: searchOrder, change: setSearchOrder } : undefined}
      onOrganize={() => {
        setMobile(false);
        setModal('organize');
      }}
      projects={projects}
      projectId={projectId}
      threads={search ? searchThreads.items.map((hit) => hit.thread) : threads.items}
      threadsProjectId={(search ? searchThreads.snapshotKey : threads.snapshotKey) === threadListKey ? projectId : ''}
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
      warning={search ? searchThreads.warning : threads.warning}
      more={search ? searchThreads.hasMore : threads.hasMore}
      onProject={(id) => {
        navigate('', { projectId: id, keepDrawer: mobile });
      }}
      onThread={(id) => void openThread(id)}
      onProjectAction={(target, action) => manageSidebar({ kind: 'project', target: { ...target }, action })}
      onThreadAction={(target, action) => manageSidebar({ kind: 'thread', target: { ...target }, action })}
      onNew={() => {
        navigate('', { afterNavigate: () => {
          setArchived(false); setQuery(''); setSearch(''); refreshSidebar();
        } });
      }}
      onQuery={next => {
        setQuery(next);
        if (!next.trim()) setSearch('');
      }}
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
      onRefresh={() => refreshSidebar(true)}
    />
  );
  const title =
    conversation.thread?.name ||
    threads.items.find((t) => t.id === threadId)?.name ||
    (threadId ? '会话' : '新会话');
  return (
    <ModelDirectoryContext.Provider value={{ api, csrf: api.csrf, directory: models }}>
    <HookEventsProvider
      events={events}
      lease={`${network.epoch}:${network.connectionId}`}
      connected={active && network.connection === 'connected' && network.runtimeConnected}
    >
      <div className="app-shell" onKeyDownCapture={event => {
        if (event.key === 'Enter' && composing(event) && event.target instanceof HTMLInputElement && event.target.form)
          event.preventDefault();
      }}>
        <McpEventBridge
          api={api}
          events={events}
          lease={`${network.epoch}:${network.revision}:${active && network.runtimeConnected ? 'online' : 'offline'}`}
        />
        <div className="desktop-sidebar">{!mobile && sidebar}</div>
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
            <RootExecutionNotice identity={runtimeNetwork.executionMode} confirmed={runtimeNetwork.executionModeConfirmed}
              onSettings={() => setModal('settings-admin')} />
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
                disabled={!project}
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
                disabled={!project}
                onClick={() => {
                  if (panel === 'terminal') setPanel('chat'); else openTerminalProgram('shell');
                }}
              >
                <Icon name="terminal" />
              </button>
              <button
                className="icon-button desktop-header-action"
                aria-label="打开官方云任务界面"
                disabled={!project}
                onClick={() => {
                  openTerminalProgram('codex-cloud');
                }}
              >
                <Icon name="cloud" />
              </button>
              <button
                className={`icon-button desktop-header-action ${panel === 'process' ? 'selected' : ''}`}
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
                  className={`icon-button desktop-header-action ${panel === 'thread-terminals' ? 'selected' : ''}`}
                  aria-label="打开会话命令与后台终端"
                  onClick={() => {
                    setThreadTerminalsMounted(true);
                    setPanel(panel === 'thread-terminals' ? 'chat' : 'thread-terminals');
                  }}
                >
                  <Icon name="backgroundTerminal" />
                </button>
              )}
                <details
                  ref={threadMenu}
                  className={`thread-menu${threadId ? '' : ' workspace-menu'}`}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector('summary')?.focus();
                    }
                  }}
                >
                  <summary className="icon-button" aria-label={threadId ? '会话操作' : '工作区操作'}>
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
                    <button className="mobile-header-action" disabled={!project} onClick={() => {
                      openTerminalProgram('codex-cloud');
                    }}>官方云任务</button>
                    <button className="mobile-header-action" onClick={() => {
                      setProcessMounted(true); setPanel('process');
                    }}>直接运行命令与管理进程</button>
                    {threadId && <>
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
                    <button onClick={() => setModal('guardian')}>守护审查（Guardian）与重试</button>
                    <button onClick={() => setModal('execution')}>会话与当前回合设置</button>
                    <button onClick={() => setModal('tasks')}>任务队列、目标与子智能体</button>
                    <button onClick={() => setModal('history')}>搜索与完整导出</button>
                    <button onClick={() => setModal('convert-thread')}>切换供应商 / 转换会话</button>
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
                      disabled={!workflowEnabled || conversation.active || conversation.realtimeActive || isBusy}
                      onClick={async () => {
                        if (!workflowEnabled || conversation.active || conversation.realtimeActive || isBusy || compacting.current.has(contextKey)) return;
                        const key = contextKey;
                        compacting.current.add(key);
                        setBusy(current => new Set([...current, key]));
                        try {
                          await api.mutate('thread/compact', { threadId });
                        } catch (e) {
                          setError(message(e));
                        } finally {
                          compacting.current.delete(key);
                          setBusy(current => { const next = new Set(current); next.delete(key); return next; });
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
                    </>}
                  </div>
                </details>
            </div>
          </header>
          <div className="status-area">
            {executionBlocked && <p className="connection-banner" role="status">
              {modeChanged ? '执行身份已切换。当前草稿仍属于原模式；安全保存后将退出原会话，并打开新模式的独立草稿。' : '正在确认实际执行身份，当前输入保留，暂不发送或继续原会话。'}
              {modeChanged && draftState.hasUnsaved && <button className="button small" onClick={() => draftState.retrySave()}>保存原模式草稿并继续</button>}
            </p>}
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
                  {resume.requiresContinuationConfirmation
                    ? `此会话有待确认的队列或持续目标。历史仍可查看；确认后将${options.model && options.modelProvider ? `使用所选模型 ${options.model}` : '沿用会话模型'}恢复执行。`
                    : '正在自动加载会话。若原模型已不可用，可在输入框选择其它模型继续，历史会保留。'}
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
                  onClick={() => void loadThread(!resume.requiresContinuationConfirmation)}
                >
                  {isBusy ? '正在加载…' : resume.requiresContinuationConfirmation ? '加载并继续（可能恢复待执行任务）' : '重新加载会话'}
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
            <span role="status" aria-live="polite" className="sr-only">{connectionNotice}</span>
            {network.connection !== 'connected' && (
              <div className="connection-banner" role="status">
                连接恢复后会核对任务状态；不会自动重发请求。
                {showOfflineRecovery && <button className="button small" onClick={() => setRecoveryOpen(true)}>强制停止并恢复</button>}
              </div>
            )}
            {network.connection === 'connected' &&
              (!network.runtimeConnected || !network.activityReady) && (
                <div className="connection-banner" role="status">
                  {network.restarting ? '终端已退出，正在自动刷新后台环境…' : '后台尚未就绪，正在核对任务状态。'}
                  <button className="button small" onClick={() => setModal('settings-admin')}>查看服务与恢复</button>
                  {showOfflineRecovery && <button className="button small" onClick={() => setRecoveryOpen(true)}>强制停止并恢复</button>}
                </div>
              )}
            {draftProviderRelation === 'unknown' && <button className="button small" onClick={() => {
              const { model, modelProvider, effort, ...rest } = options;
              draftState.setOptions(rest);
            }}>清除草稿模型选择，沿用会话设置</button>}
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
            {missingThreadProject && <p className="connection-banner" role="status">此会话的工作目录尚未注册。文件、终端及项目写入已停用；请添加对应项目。草稿与会话历史保留。</p>}
            {network.error && <p className="connection-banner" role="status">{network.error} <button className="button small" onClick={() => { conversation.recheck(); prompts.refresh(); network.clearError(); }}>重新读取并核对</button></p>}
            {(error || resume.error || conversation.error || prompts.error) && (
              <div className="error-banner" role="alert">
                <span>{error || resume.error || conversation.error || prompts.error}</span>
                {prompts.error && <button className="button small" onClick={prompts.refresh}>重新读取审批请求</button>}
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
                  historyComplete={conversation.complete}
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
                  enabled={active && network.connection === 'connected' && network.runtimeConnected &&
                    network.activityReady && !pending && !operations.error && !conversation.realtimeActive}
                  shellEnabled={fullHistoryWorkflowEnabled}
                  idle={!conversation.active && !conversation.realtimeActive}
                  onChanged={workflowChanged}
                  onLocate={(itemId) => {
                    const turnId = displayedHistory.commandTurns.get(itemId);
                    setPanel('chat', false);
                    if (turnId) {
                      setError(previous => [terminalHistoryMissing, terminalHistoryAmbiguous].includes(previous) ? '' : previous);
                      setFocusTarget({ turnId, itemId });
                    } else {
                      setFocusTarget(undefined);
                      setError(turnId === null ? terminalHistoryAmbiguous : terminalHistoryMissing);
                    }
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
                  threadReady={fullHistoryWorkflowEnabled}
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
                  onChanged={() => refreshSidebar(true)}
                />
              </div>
            )}
            {workspaceMounted && (
              <div className="terminal-slot" hidden={panel !== 'files'}>
                <WorkspacePanel
                  visible={active && panel === 'files'}
                  idle={active && network.activityReady}
                  onProjectsChanged={() => refreshSidebar(true)}
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
                      contextPayload(project?.id ?? '', references, draftState.extraContext);
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
                <TerminalOnDemand
                  loadingFallback={(failed, retry) => <section className="panel stack" aria-label="终端">
                    <h2>终端</h2>
                    <p role={failed ? 'alert' : 'status'}>{failed ? '终端暂时无法加载，请检查连接后重试。对话与草稿仍然保留。' : '正在加载终端…'}</p>
                    <div className="actions">
                      {failed && <button className="button" onClick={retry}>重新加载终端</button>}
                      <button className="button" onClick={() => setPanel('chat')}>返回对话</button>
                    </div>
                  </section>}
                  onShell={() => openTerminalProgram('shell')}
                  onOwnershipChange={setOwnsTerminal}
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
                  projectId={project?.id ?? ''}
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
                    onOpenThread={workflowOpenThread}
                    key={threadId}
                    api={api}
                    threadId={threadId}
                    project={project}
                    turns={conversation.turns}
                    timeline={conversation.timeline}
                    view={displayedHistory}
                    loading={conversation.loading}
                    complete={conversation.complete}
                    truncated={conversation.truncated}
                    onMore={conversation.loadMore}
                    focusTarget={focusTarget}
                    onLocateConsumed={clearFocusTarget}
                    active={conversation.active}
                    actionsDisabled={!workflowEnabled || conversation.active}
                    onAction={onMessageAction}
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
                getContextItem={displayedHistory.getItem}
                contextThreadId={conversation.loadedThreadId}
                onRefresh={conversation.refresh}
              />
            )}
          </div>
          <div ref={composerSlot} className="composer-slot" hidden={panel !== 'chat'}>
            <Composer
              onProviders={() => setModal('settings-provider')}
              projectId={project?.id ?? ''}
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
              historyComplete={conversation.complete}
              modes={modes.data?.data ?? []}
              modesLoading={modes.loading}
              disabled={
                !directInputAllowed ||
                !project ||
                network.connection !== 'connected' ||
                !network.runtimeConnected ||
                !network.activityReady ||
                pending || foreignDraftModel ||
                Boolean(operations.error) ||
                Boolean(draftState.error) ||
                (Boolean(threadId) && (!conversation.ready || resumedThread !== threadId))
              }
              options={options}
              onOptions={setOptions}
              models={composerModels}
              directoryComplete={directoryComplete}
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
              threadProvider={sourceProvider}
              notice={
                draftState.error || modelCatalog.error ||
                (draftProviderRelation === 'unknown' ? '正在核对草稿模型的供应商归属，请完成模型目录读取后再发送。' : '') ||
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
            {terminalSwitch && <Dialog title="切换终端程序" onClose={() => setTerminalSwitch(undefined)}>
              <p>当前终端仍可能接受输入。切换后，原终端将暂停输入，需先关闭它才能打开新程序。</p>
              <button className="button" onClick={() => setTerminalSwitch(undefined)}>取消</button>
              <button className="button" onClick={() => { setTerminalProgram(terminalSwitch); setTerminalSwitch(undefined); setTerminalMounted(true); setPanel('terminal'); }}>确认切换</button>
            </Dialog>}
            {mobile && (
              <Dialog title="导航" onClose={() => setMobile(false)}>
                {executionBlocked && <p role="status">执行身份尚未确认，请在连接恢复后核对身份再切换会话。</p>}
                {sidebar}
              </Dialog>
            )}
            {modal === 'loaded' && (
              <LoadedThreadsPanel
                knownThreads={threads.items}
                navigationError={error}
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
                projectId={project?.id ?? ''}
                threadId={threadId}
                enabled={
                  active &&
                  network.connection === 'connected' &&
                  network.runtimeConnected &&
                  network.activityReady
                }
                threadReady={fullHistoryWorkflowEnabled}
                threadIdle={!conversation.active}
                globalIdle={network.configurationReady}
                onChanged={workflowChanged}
                onDeleted={() => {
                  navigate('');
                  refreshSidebar();
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
                epoch={`${runtimeNetwork.epoch}:${runtimeNetwork.revision}`}
                executionMode={runtimeNetwork.executionMode}
                executionModeConfirmed={runtimeNetwork.executionModeConfirmed}
                enabled={active && network.connection === 'connected' && network.runtimeConnected && !network.restarting}
                onClose={() => setModal('')}
                onAdded={() => refreshSidebar(true)}
                onOpen={(id) => {
                  if (navigation.current !== modalNavigation) return;
                  afterProjectCreated.current(id);
                }}
              />
            )}{' '}
            {modal === 'sidebar-management' && sidebarManagement && (
              <SidebarManagementDialog
                key={sidebarManagement.key}
                api={api}
                epoch={resourceEpoch}
                selection={sidebarManagement.selection}
                enabled={active && network.connection === 'connected' &&
                  (sidebarManagement.selection.kind === 'project' || (network.runtimeConnected && network.activityReady))}
                unavailableReason={network.connection !== 'connected' ? '当前已离线。连接恢复后会重新核对，再确认操作。' : '后台正在恢复，请等待会话状态就绪。'}
                beforeSubmit={() => {
                  const { selection, navigation: started, canLeave } = sidebarManagement;
                  const leavesCurrent = selection.kind === 'project'
                    ? selection.action === 'remove' && selection.target.id === projectId
                    : selection.action !== 'rename' && selection.target.id === threadId;
                  return !leavesCurrent || navigation.current !== started || canLeave();
                }}
                onAccepted={() => {
                  const { selection, navigation: started, canLeave } = sidebarManagement;
                  refreshSidebar(true);
                  setModal(current => current === 'sidebar-management' ? (sidebarManagement.returnToProjects ? 'settings-projects' : '') : current);
                  if (navigation.current !== started) return;
                  if (selection.kind === 'project') {
                    if (selection.action !== 'remove' || selection.target.id !== projectId) return;
                    if (!canLeave()) {
                      setError('项目已移除，当前输入仍保留。请先保存或复制草稿，再切换项目。');
                      return;
                    }
                    navigate('', { projectId: projects.find(item => item.id !== selection.target.id)?.id ?? '',
                      afterNavigate: () => { if (sidebarManagement.returnToProjects) setModal('settings-projects'); } });
                  } else if (selection.target.id === threadId) {
                    if (selection.action === 'rename') { conversation.refresh(); return; }
                    if (!canLeave()) {
                      setError('会话管理操作已完成，当前输入仍保留。请先保存或复制草稿，再切换会话。');
                      return;
                    }
                    navigate('');
                  }
                }}
                onClose={() => setModal(sidebarManagement.returnToProjects ? 'settings-projects' : '')}
              />
            )}{' '}
            {modal === 'rename' && (
              <RenameDialog
                api={api}
                threadId={threadId}
                name={title}
                onClose={() => setModal('')}
                onSaved={() => {
                  refreshSidebar();
                  conversation.refresh();
                }}
              />
            )}{' '}
            {recoveryOpen && <EmergencyRecovery api={api} onClose={() => setRecoveryOpen(false)} />}
            {(modal === 'settings' || modal === 'settings-admin' || modal === 'settings-provider' || modal === 'settings-projects') && (
              <SettingsOnDemand
                loadingFallback={(failed, retry) => <Dialog title="设置" onClose={() => setModal('')} wide>
                  <p role={failed ? 'alert' : 'status'}>{failed ? '设置暂时无法加载，请检查连接后重试。对话与草稿仍然保留。' : '正在加载设置…'}</p>
                  {failed && <button className="button" onClick={retry}>重新加载设置</button>}
                </Dialog>}
                navigationError={error}
                onRecover={() => setRecoveryOpen(true)}
                initialTab={modal === 'settings-admin' ? 'admin' : modal === 'settings-provider' ? 'provider' : modal === 'settings-projects' ? 'projects' : 'general'}
                onOpenNativeTerminal={(id) => {
                  navigate('', { projectId: id, afterNavigate: () => openTerminalProgram('codex') });
                }}
                runtimeEpoch={network.epoch}
                connectionId={network.connectionId}
                threadId={threadId}
                historyComplete={conversation.complete}
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
                projectId={project?.id}
                configurationReady={active && network.configurationReady}
                managementReady={active && runtimeNetwork.configurationReady && runtimeNetwork.connection === 'connected' && runtimeNetwork.runtimeConnected}
                api={api}
                epoch={resourceEpoch}
                events={events}
                projects={projects}
                theme={theme}
                onTheme={setTheme}
                onClose={() => setModal('')}
                onChanged={() => setConfigRevision((v) => v + 1)}
                onProjectAction={(target, action) => manageSidebar({ kind: 'project', target: { ...target }, action })}
                onOpenThread={(id) => { void openThread(id); }}
                onOpenDraft={(key) => {
                  const context = executionDraftContext(key);
                  if (context.mode !== draftMode || executionBlocked) { setError('此草稿属于另一执行模式，请先确认并切换到对应模式。'); return; }
                  const branch = branchDraftSource(context.key);
                  if (branch) {
                    openThread(branch.threadId, () => setRestoreBranch(branch));
                    return;
                  }
                  if (context.key.startsWith('new:')) {
                    if (!projects.some(project => project.id === context.key.slice(4))) { setError('此草稿的项目已被移除。草稿仍保留，可在本地草稿中导出，或重新添加原项目后打开。'); return; }
                    navigate('', { projectId: context.key.slice(4) });
                  } else openThread(context.key);
                }}
                draftMode={draftMode}
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
                enabled={fullHistoryWorkflowEnabled}
                idle={!conversation.active && !conversation.realtimeActive}
                onChanged={workflowChanged}
                onLocate={(turnId, itemId) => {
                  setModal('');
                  setPanel('chat', false);
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
                projectId={project?.id ?? ''}
                epoch={resourceEpoch}
                enabled={workflowEnabled && !conversation.realtimeActive}
                activeTurnId={conversation.activeTurn?.id}
                models={composerModels}
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
                historyComplete={conversation.complete}
                queueManagementEnabled={active && network.connection === 'connected' && network.runtimeConnected && network.activityReady && !pending && !operations.error && directInputAllowed}
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
                getItem={displayedHistory.getItem}
                onClose={() => setModal('')}
                onLocate={(turnId, itemId) => {
                  setPanel('chat', false);
                  setFocusTarget({ turnId, itemId });
                }}
              />
            )}{' '}
            {modal === 'convert-thread' && threadId && (
              <ThreadConversionDialog
                key={JSON.stringify([threadId, resourceEpoch, draftMode, sourceProvider])}
                api={api} threadId={threadId} sourceProvider={sourceProvider ?? ''} epoch={resourceEpoch}
                models={models.items} loading={models.loading || modelCatalog.refreshing}
                more={models.hasMore} onMore={() => void models.more()}
                enabled={active && !executionBlocked && network.activityReady && network.connection === 'connected' &&
                  network.runtimeConnected && resumedThread === threadId && !pending && !isBusy &&
                  !conversation.active && !conversation.realtimeActive}
                onBusy={(working) => setBusy(current => {
                  const next = new Set(current);
                  if (working) next.add(contextKey); else next.delete(contextKey);
                  return next;
                })}
                onCreated={(id) => { workflowHandoff(id); setModal(''); }}
                onClose={() => setModal('')}
              />
            )}
            {modal === 'review' && project && (
              <ReviewDialog
                key={threadId + resourceEpoch}
                api={api}
                threadId={threadId}
                projectId={project?.id ?? ''}
                initialTarget={reviewTarget}
                initialSeparate={Boolean(reviewTarget) || !threadId}
                enabled={
                  active &&
                  network.connection === 'connected' &&
                  network.runtimeConnected &&
                  network.activityReady
                }
                inlineEnabled={fullHistoryWorkflowEnabled && !conversation.active}
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
                draftMode={draftMode}
                onChanged={workflowChanged}
                onClose={() => setBranchAction(undefined)}
                memoryDraft={branchAction.restoredText ?? branchMemory.current.get(
                  branchDraftKey(threadId, branchAction.turn.id, draftMode),
                )}
                onDraft={(text) => {
                  const key = branchDraftKey(threadId, branchAction.turn.id, draftMode);
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
              <Dialog title="草稿尚未保存" onClose={() => { pendingNavigation.current = undefined; setDraftGuard(false); setDiscardRevision(undefined); }}>
                <p>当前输入只保留在页面中。请先保存，或明确放弃未保存的修改，再切换项目或会话。</p>
                {discardRevision ? <>
                  <p>确认放弃这次未保存的修改，并恢复本页最近保存的版本？其他草稿不会改变。</p>
                  {discardRevision !== draftState.revision && <p role="status">输入已变化，请重新确认当前修改。</p>}
                  <button className="button danger" disabled={discardRevision !== draftState.revision}
                    onClick={() => {
                      if (draftState.discardUnsaved(discardRevision)) {
                        setDraftGuard(false);
                        continueNavigation();
                      }
                      setDiscardRevision(undefined);
                    }}>确认放弃未保存的修改</button>
                  {discardRevision !== draftState.revision && <button className="button"
                    onClick={() => setDiscardRevision(draftState.revision)}>重新确认当前修改</button>}
                </> : <>
                  <button className="button" onClick={() => {
                    if (draftState.retrySave()) { setDraftGuard(false); continueNavigation(); }
                  }}>重试保存草稿</button>
                  <button className="button" onClick={() => setDiscardRevision(draftState.revision)}>放弃未保存的修改</button>
                </>}
                <button className="button" onClick={() => { pendingNavigation.current = undefined; setDraftGuard(false); setDiscardRevision(undefined); }}>返回继续编辑</button>
              </Dialog>
            )}

          </>
        )}
      </div>
    </HookEventsProvider>
    </ModelDirectoryContext.Provider>
  );
}
