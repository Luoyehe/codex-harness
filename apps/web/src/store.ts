import { create } from "zustand";
import { gateway, type ServerRequestMsg } from "./api/ws";
import { type ApprovalRequest, type GatewayNotification, type TimelineItem } from "./api/protocol";
import type { Thread } from "../../../protocol/v2/Thread";
import type { ThreadListParams } from "../../../protocol/v2/ThreadListParams";
import type { ThreadListResponse } from "../../../protocol/v2/ThreadListResponse";
import type { ThreadStartParams } from "../../../protocol/v2/ThreadStartParams";
import type { GetAccountResponse } from "../../../protocol/v2/GetAccountResponse";
import type { McpServerStatus } from "../../../protocol/v2/McpServerStatus";
import type { PermissionsRequestApprovalResponse } from "../../../protocol/v2/PermissionsRequestApprovalResponse";
import type { CommandExecutionRequestApprovalResponse } from "../../../protocol/v2/CommandExecutionRequestApprovalResponse";
import { describePermissions } from "./utils/permissions";
import { operationId } from "./utils/operation-id";
import { validateResponse, type InputRequest } from "./utils/input-forms";
import { budgetTimeline } from "./utils/timeline-budget";
import { normalizeManagement, type ManagementSnapshot } from "./utils/management";
export type { TimelineItem } from "./api/protocol";

/**
 * Times are normalized app-server payloads (see protocol/ generated types,
 * codex 0.149.0): items by thread, pending approvals, aggregated turn diff,
 * the per-project session list, and browser-local settings.
 */

export interface SessionInfo {
  threadId: string;
  title: string;
  updatedAt: number;
}

export interface ProjectEntry {
  path: string;
  addedAt: number;
  lastUsedAt: number;
  available?: boolean;
}

export type ApprovalPolicy = "" | "untrusted" | "on-request" | "never";
export type SandboxPreset = "" | "network" | "full";
// The pinned protocol intentionally leaves this extensible. Only a bounded
// identifier advertised by the selected model is admissible for a turn.
export type ReasoningEffort = string;
export type ProviderMode = "openai" | "zhipu" | "custom";

/**
 * Which timeline item categories to render. Unlike Settings (per-browser,
 * localStorage), these live on the gateway so every browser sees the same
 * choice — displayPrefs/get|set in the gateway API.
 */
export interface Display {
  reasoning: boolean;
  commands: boolean;
  fileChanges: boolean;
  mcpCalls: boolean;
  webSearch: boolean;
  /** Auto-compact trigger threshold (0-1). 0 = disabled. */
  autoCompactThreshold: number;
}

const DEFAULT_DISPLAY: Display = {
  reasoning: true,
  commands: true,
  fileChanges: true,
  mcpCalls: true,
  webSearch: true,
  autoCompactThreshold: 0.9,
};

export interface Settings {
  theme: "system" | "light" | "dark";
  enterBehavior: "send" | "newline";
  /** Last-used per-turn selections (applied immediately, remembered as the
   * starting point for the next session — not "defaults" locked in settings). */
  selectedModel: string; // "" = codex config default
  selectedApprovalPolicy: ApprovalPolicy;
  /** Sandbox preset: "" = server default, "network" = read-only + LAN/NET
   * access, "full" = no sandbox. Sent with every turn (turn/start
   * sandboxPolicy override). */
  selectedSandbox: SandboxPreset;
  /** Per-turn reasoning effort ("" = catalog default). */
  selectedEffort: ReasoningEffort;
}

export type PendingServerRequest = ApprovalRequest;

export interface DeviceLogin {
  status: "waiting" | "error";
  userCode?: string;
  verificationUrl?: string;
  error?: string;
}

const SETTINGS_KEY = "codex-harness-settings";
const PROJECT_KEY = "codex-harness-current-project";

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  enterBehavior: "send",
  selectedModel: "",
  selectedApprovalPolicy: "",
  selectedSandbox: "",
  selectedEffort: "",
};

const APPROVAL_POLICIES = new Set<ApprovalPolicy>(["", "untrusted", "on-request", "never"]);
const SANDBOX_PRESETS = new Set<SandboxPreset>(["", "network", "full"]);
const EFFORT_IDENTIFIER = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_MODEL_ID_LENGTH = 256;
/** 25MiB file cap encoded as base64. Keep the exact transport bound here as
 * a second line of defense for non-Composer callers. */
const MAX_ATTACHMENT_BASE64_CHARS = 4 * Math.ceil((25 * 1024 * 1024) / 3);

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** localStorage and gateway data are runtime input even though the React
 * callers are typed. Normalize them before they can become selector values or
 * be sent back to the server. */
function normalizeSettings(value: unknown): Settings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const theme = source.theme === "light" || source.theme === "dark" || source.theme === "system"
    ? source.theme
    : DEFAULT_SETTINGS.theme;
  const enterBehavior = source.enterBehavior === "newline" || source.enterBehavior === "send"
    ? source.enterBehavior
    : DEFAULT_SETTINGS.enterBehavior;
  const approval = APPROVAL_POLICIES.has(source.selectedApprovalPolicy as ApprovalPolicy)
    ? source.selectedApprovalPolicy as ApprovalPolicy
    : "";
  const sandbox = SANDBOX_PRESETS.has(source.selectedSandbox as SandboxPreset)
    ? source.selectedSandbox as SandboxPreset
    : "";
  const effort = typeof source.selectedEffort === "string" && EFFORT_IDENTIFIER.test(source.selectedEffort)
    ? source.selectedEffort
    : "";
  return {
    theme,
    enterBehavior,
    selectedModel: boundedString(source.selectedModel, MAX_MODEL_ID_LENGTH),
    selectedApprovalPolicy: approval,
    selectedSandbox: sandbox,
    selectedEffort: effort,
  };
}

function normalizeProviderMode(value: unknown): ProviderMode {
  return value === "zhipu" || value === "custom" ? value : "openai";
}

function normalizeReasoningEfforts(value: unknown): Exclude<ReasoningEffort, "">[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter(
      (entry): entry is Exclude<ReasoningEffort, ""> =>
        typeof entry === "string" && EFFORT_IDENTIFIER.test(entry),
    ),
  )].slice(0, 128);
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  reasoningEfforts?: Exclude<ReasoningEffort, "">[];
  defaultReasoningEffort?: ReasoningEffort;
  isDefault?: boolean;
}

export function selectedModelEfforts(models: ModelInfo[], selected: string): Exclude<ReasoningEffort, "">[] {
  const model = selected ? models.find((entry) => entry.id === selected) : models.find((entry) => entry.isDefault);
  return model?.reasoningEfforts ?? [];
}

export interface SendOperation {
  clientOperationId: string;
  threadId: string;
  state: "unknown" | "accepted" | "not_received" | "rejected" | "acknowledged_unknown";
  error?: string;
}
export type SendIdentity = Pick<SendOperation, "threadId" | "clientOperationId">;
const OPERATIONS_KEY = "codex-harness-pending-operation-v1:";
function loadSendOperations(): Record<string, SendOperation> {
  try {
    const entries: any[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(OPERATIONS_KEY)) continue;
      try { entries.push(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { /* Ignore unrelated corrupt storage entries. */ }
    }
    const valid = entries.filter((entry) => entry && ["unknown", "acknowledged_unknown"].includes(entry.state) &&
      typeof entry.threadId === "string" && entry.threadId.length <= 256 &&
      typeof entry.clientOperationId === "string" && /^[a-z0-9-]{36}$/i.test(entry.clientOperationId));
    // Unresolved records take precedence over historical acknowledgments.
    valid.sort((a, b) => Number(a.state === "unknown") - Number(b.state === "unknown"));
    return Object.fromEntries(valid.slice(-100).map((entry) => [entry.threadId, {
      threadId: entry.threadId, clientOperationId: entry.clientOperationId, state: entry.state as SendOperation["state"],
    }]));
  } catch { return {}; }
}
function saveSendOperation(operation: SendOperation): void {
  // No prompts, paths, attachments or credentials are written to browser storage.
  // One key per operation avoids read/modify/write races between browser tabs.
  // Save only the changed operation; stale snapshots from another tab must
  // not rewrite an acknowledgment of a different operation back to unknown.
  const key = `${OPERATIONS_KEY}${operation.clientOperationId}`;
  if (operation.state === "unknown" || operation.state === "acknowledged_unknown") localStorage.setItem(key, JSON.stringify({ clientOperationId: operation.clientOperationId, threadId: operation.threadId, state: operation.state }));
  else localStorage.removeItem(key);
}

function normalizeDisplay(value: unknown, base: Display = DEFAULT_DISPLAY): Display {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = { ...base };
  for (const key of ["reasoning", "commands", "fileChanges", "mcpCalls", "webSearch"] as const) {
    if (typeof source[key] === "boolean") next[key] = source[key];
  }
  const threshold = source.autoCompactThreshold;
  if (typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
    next.autoCompactThreshold = threshold;
  }
  return next;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

function loadCurrentProject(): string {
  try {
    return (localStorage.getItem(PROJECT_KEY) ?? "").slice(0, 4096);
  } catch {
    return "";
  }
}

function applyTheme(theme: Settings["theme"]): void {
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
}

/** Session list query race protection: only the latest request may write state. */
let sessionRequestSeq = 0;
/** #4: on FIRST load with no ?threadId, land in the most recent session. */
let initialThreadSelected = false;
/** Provider the current models[] was fetched under — a fetch failure under a
 * NEW provider must drop the stale list instead of keeping the old one. */
let modelsLoadedFor: string | null = null;
let sessionSearchTimer: number | null = null;
/** Model list race protection: drop stale responses on provider switch. */
let modelRequestSeq = 0;
/** Full refresh and smaller catalogs also need generation protection. A
 * response that was already queued as a microtask when the socket dropped can
 * otherwise overwrite data loaded by the replacement connection. */
let refreshRequestSeq = 0;
let projectRequestSeq = 0;
let mcpRequestSeq = 0;
let openThreadRequestSeq = 0;
let newThreadRequestSeq = 0;
let managementRequestSeq = 0;
let managementNotificationVersion = 0;

interface AppStore {
  connection: "connecting" | "open" | "closed";
  connectionError: string | null;
  management: ManagementSnapshot;
  managementError: string | null;
  codexState: string;
  gatewayVersion: string;
  workspaceRoot: string;
  /** Active provider preset. Model capabilities come from model/list. */
  providerMode: ProviderMode;
  account: GetAccountResponse | null;
  projects: ProjectEntry[];
  currentProject: string;
  models: ModelInfo[];
  mcpServers: McpServerStatus[];
  settings: Settings;
  display: Display;
  displayError: string | null;
  sendOperations: Record<string, SendOperation>;
  sessions: SessionInfo[];
  /** Pagination cursor from the last thread/list response (null = no more). */
  sessionCursor: string | null;
  sessionLoading: boolean;
  sessionLoadingMore: boolean;
  /** Search filter for the session sidebar (server-side title search). */
  sessionSearch: string;
  /** Show archived sessions instead of current ones. */
  sessionArchived: boolean;
  activeThreadId: string | null;
  items: Record<string, TimelineItem[]>;
  historyLoaded: Record<string, boolean>;
  historyLoading: Record<string, boolean>;
  turnActive: Record<string, boolean>;
  activeTurnId: Record<string, string | null>;
  turnDiff: Record<string, string>;
  tokenUsage: Record<string, { total: number; window: number | null }>;
  compacting: Record<string, boolean>;
  plan: Record<string, { explanation: string | null; steps: Array<{ step: string; status: string }> } | null>;
  approvals: PendingServerRequest[];
  inputRequests: InputRequest[];
  inputRequestErrors: Record<string, string>;
  deviceLogin: DeviceLogin | null;
  drawerTab: "diff" | "terminal" | null;
  sidebarOpen: boolean;

  bootstrap(): void;
  refresh(): Promise<void>;
  refreshManagement(): Promise<void>;
  refreshSessions(): Promise<void>;
  loadMoreSessions(): Promise<void>;
  setSessionSearch(term: string): void;
  setSessionArchived(archived: boolean): void;
  unarchiveThread(threadId: string): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshModels(): Promise<void>;
  refreshMcp(): Promise<void>;
  addProject(path: string, create: boolean): Promise<void>;
  removeProject(path: string): Promise<void>;
  selectProject(path: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): void;
  updateDisplay(patch: Partial<Display>): void;
  checkSendOperation(threadId: string, clientOperationId?: string): Promise<SendOperation | undefined>;
  acknowledgeUnknownSend(threadId: string, clientOperationId: string): boolean;
  uploadAttachment(name: string, base64: string, kind?: "image" | "file"): Promise<{ path: string; size: number }>;
  readAttachment(path: string): Promise<{ base64: string; mime: string }>;
  deleteAttachment(path: string): Promise<void>;
  openThread(threadId: string): Promise<void>;
  newThread(): Promise<string | null>;
  sendMessage(text: string, attachments?: Array<{ kind: "image" | "file"; name: string; path: string; previewUrl?: string }>, onOperation?: (identity: SendIdentity) => void): Promise<void>;
  sendTurn(text: string, attachments?: Array<{ kind: "image" | "file"; name: string; path: string }>, onOperation?: (identity: SendIdentity) => void): Promise<void>;
  interruptTurn(): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  decideApproval(requestId: number | string, decision: "accept" | "acceptForSession" | "decline"): void;
  respondInputRequest(requestId: number | string, payload: unknown): boolean;
  compactThread(): Promise<void>;
  startDeviceLogin(): Promise<void>;
  setDrawerTab(tab: "diff" | "terminal" | null): void;
  setSidebarOpen(open: boolean): void;
}

function upsertItem(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const idx = items.findIndex((it) => it.id === item.id);
  if (idx === -1) return [...items, item];
  const next = items.slice();
  next[idx] = { ...next[idx], ...item };
  return next;
}

function patchItem(items: TimelineItem[], itemId: string, patch: (item: TimelineItem) => TimelineItem): TimelineItem[] {
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = patch(next[idx]);
  return next;
}

/** ThreadItems come back nested per-turn (Thread.turns[].items[]). */
function flattenTurns(thread: Thread): TimelineItem[] {
  const turns = thread.turns;
  return turns.flatMap((t) => t?.items ?? []);
}

/** Upstream has no snapshot sequence/cut. Only a complete live item, or a
 * stream whose item/started was observed during this read, can supersede a
 * snapshot. Content overlap is not evidence of identity ("abc" may repeat). */
function mergeHistory(snapshot: TimelineItem[], live: TimelineItem[], started: Set<string>): TimelineItem[] {
  const result = new Map(snapshot.map((item) => [item.id, item]));
  const acceptedOperations = new Set(snapshot.filter((item) => item.type === "userMessage").map((item) => item.clientOperationId).filter(Boolean));
  for (const item of live) {
    if (item.type === "localUserMessage" && item.clientOperationId && acceptedOperations.has(item.clientOperationId)) continue;
    const saved = result.get(item.id);
    if (!saved) { result.set(item.id, item); continue; }
    if (item.completed || started.has(item.id)) result.set(item.id, item);
  }
  return [...result.values()];
}

function makeErrorItem(message: string, willRetry = false): Extract<TimelineItem, { type: "errorItem" }> {
  return {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "errorItem",
    message: boundedString(message, 20_000) || "unknown error",
    willRetry,
  };
}

/** Sync the active thread into the URL so refresh/back restores the view. */
function syncUrl(threadId: string | null): void {
  try {
    const url = new URL(location.href);
    if (threadId) url.searchParams.set("threadId", threadId);
    else url.searchParams.delete("threadId");
    history.replaceState(null, "", url);
  } catch {
    /* non-http context */
  }
}

export const useStore = create<AppStore>((rawSet, get) => {
  const overflowThreads = new Set<string>();
  const set = (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => rawSet((state) => {
    const patch = { ...(typeof partial === "function" ? partial(state) : partial) };
    const active = patch.activeThreadId === undefined ? state.activeThreadId : patch.activeThreadId;
    // Lifecycle/diff dictionaries otherwise retain every session ever seen,
    // even when its actual timeline was evicted from the bounded cache.
    const keys = ["turnActive", "activeTurnId", "turnDiff", "tokenUsage", "compacting", "plan", "historyLoaded", "historyLoading"] as const;
    for (const key of keys) {
      const value = patch[key];
      if (!value) continue;
      const entries = Object.entries(value).reverse().sort(([a], [b]) => a === active ? -1 : b === active ? 1 : 0).slice(0, key === "turnDiff" || key === "plan" ? 8 : 128);
      (patch as Record<string, unknown>)[key] = Object.fromEntries(entries);
    }
    if (patch.turnDiff) patch.turnDiff = Object.fromEntries(Object.entries(patch.turnDiff).map(([id, diff]) => [id, diff.length > 1024 * 1024 ? `${diff.slice(0, 1024 * 1024)}\n[浏览器 Diff 显示预算已达到，剩余内容请在服务器查看。]` : diff]));
    if (!patch.items) return patch;
    const budget = budgetTimeline(patch.items, active);
    for (const threadId of budget.overflow) overflowThreads.add(threadId);
    const historyLoaded = { ...state.historyLoaded, ...patch.historyLoaded };
    for (const threadId of [...budget.evicted, ...budget.overflow]) delete historyLoaded[threadId];
    return { ...patch, items: budget.items, historyLoaded };
  });
  let sessionsRefreshTimer: number | null = null;
  let bootstrapped = false;
  let runtimeVersion = 0;
  const submittedInputs = new Set<string | number>();
  const activityVersions = new Map<string, number>();
  const deletedThreads = new Set<string>();
  // Only sessions actually created here may bridge delayed server indexing.
  const localSessions = new Map<string, { session: SessionInfo; cwd: string | null }>();
  let sessionWindowContext = "";
  let sessionWindowPages = 1;

  function forgetThread(threadId: string, deleted = false) {
    localSessions.delete(threadId);
    if (deleted) deletedThreads.add(threadId);
    if (get().activeThreadId === threadId) openThreadRequestSeq += 1;
    const drop = <T,>(record: Record<string, T>) => {
      const next = { ...record };
      delete next[threadId];
      return next;
    };
    set((s) => ({
      sessions: s.sessions.filter((entry) => entry.threadId !== threadId),
      activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      items: drop(s.items), historyLoaded: drop(s.historyLoaded), historyLoading: drop(s.historyLoading),
      turnActive: drop(s.turnActive), activeTurnId: drop(s.activeTurnId),
      compacting: drop(s.compacting), plan: drop(s.plan), turnDiff: drop(s.turnDiff), tokenUsage: drop(s.tokenUsage),
      approvals: s.approvals.filter((a) => a.params.threadId !== threadId),
      inputRequests: s.inputRequests.filter((request) => request.params.threadId !== threadId),
    }));
    if (!get().activeThreadId) syncUrl(null);
  }

  function clearRuntimeState() {
    runtimeVersion += 1;
    invalidateAsyncWork();
    activityVersions.clear();
    overflowThreads.clear();
    submittedInputs.clear();
    set({
      items: {}, historyLoaded: {}, historyLoading: {}, turnActive: {}, activeTurnId: {},
      compacting: {}, plan: {}, turnDiff: {}, tokenUsage: {}, approvals: [], inputRequests: [], inputRequestErrors: {}, deviceLogin: null,
    });
  }

  function finishCompaction(threadId: string, status: "completed" | "failed", message: string) {
    set((s) => ({
      compacting: { ...s.compacting, [threadId]: false },
      items: { ...s.items, [threadId]: (s.items[threadId] ?? []).map((item) =>
        item.type === "compactionProgress" && item.status === "inProgress" ? { ...item, status, message } : item) },
    }));
  }

  function scheduleSessionsRefresh() {
    if (sessionsRefreshTimer !== null) return;
    sessionsRefreshTimer = window.setTimeout(() => {
      sessionsRefreshTimer = null;
      void get().refreshSessions();
    }, 300);
  }

  function appendToThread(threadId: string, item: TimelineItem) {
    set((s) => ({ items: { ...s.items, [threadId]: [...(s.items[threadId] ?? []), item] } }));
  }

  // ---- streaming delta batching (#2/#12) -----------------------------------
  // High-frequency deltas (text/reasoning/command output) each cost an O(n)
  // array copy + full-list render. Buffer them and flush coalesced at most
  // ~8×/second; non-delta notifications flush first so ordering is preserved.
  const DELTA_METHODS = [
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta",
  ] as const;
  type Delta = Extract<GatewayNotification, { method: typeof DELTA_METHODS[number] }>;
  function isDelta(event: GatewayNotification): event is Delta {
    return DELTA_METHODS.some((method) => method === event.method);
  }
  let deltaBuffer: Delta[] = [];
  let deltaBufferChars = 0;
  const pendingHistoryDeltas = new Map<string, Set<string>>();
  const historyStarts = new Map<string, Set<string>>();
  const pausedStreams = new Map<string, Set<string>>();
  let deltaFlushTimer: number | null = null;

  function invalidateAsyncWork(): void {
    refreshRequestSeq += 1;
    sessionRequestSeq += 1;
    modelRequestSeq += 1;
    projectRequestSeq += 1;
    mcpRequestSeq += 1;
    openThreadRequestSeq += 1;
    newThreadRequestSeq += 1;
    deltaBuffer = [];
    deltaBufferChars = 0;
    pendingHistoryDeltas.clear();
    historyStarts.clear();
    pausedStreams.clear();
    if (deltaFlushTimer !== null) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = null;
    }
    if (sessionsRefreshTimer !== null) {
      clearTimeout(sessionsRefreshTimer);
      sessionsRefreshTimer = null;
    }
  }

  function flushDeltas() {
    if (deltaFlushTimer !== null) {
      clearTimeout(deltaFlushTimer);
      deltaFlushTimer = null;
    }
    if (deltaBuffer.length === 0) return;
    const batch = deltaBuffer;
    deltaBuffer = [];
    deltaBufferChars = 0;
    set((s) => {
      const nextItems = { ...s.items };
      for (const delta of batch) {
        const { method, params } = delta;
        if (overflowThreads.has(params.threadId)) continue;
        if (pausedStreams.get(params.threadId)?.has(params.itemId)) continue;
        if (s.historyLoading[params.threadId] && !historyStarts.get(params.threadId)?.has(params.itemId)) {
          const pending = pendingHistoryDeltas.get(params.threadId) ?? new Set<string>();
          if (pending.size < 2000) pending.add(params.itemId);
          pendingHistoryDeltas.set(params.threadId, pending);
          continue;
        }
        const list = nextItems[params.threadId];
        if (!list?.some((item) => item.id === params.itemId)) {
          if (s.historyLoading[params.threadId]) {
            const pending = pendingHistoryDeltas.get(params.threadId) ?? new Set<string>();
            if (pending.size < 2000) pending.add(params.itemId);
            pendingHistoryDeltas.set(params.threadId, pending);
          }
          continue;
        }
        nextItems[params.threadId] = patchItem(list, params.itemId, (it) => {
          switch (method) {
            case "item/agentMessage/delta":
              return it.type === "agentMessage" ? { ...it, text: it.text + params.delta } : it;
            case "item/plan/delta":
              return it.type === "plan" ? { ...it, text: it.text + params.delta } : it;
            case "item/reasoning/textDelta": {
              if (it.type !== "reasoning") return it;
              const content: string[] = [...(it.content ?? [])];
              const idx = typeof params.contentIndex === "number" ? params.contentIndex : 0;
              while (content.length <= idx) content.push("");
              content[idx] = (content[idx] ?? "") + (params.delta ?? "");
              return { ...it, content, streaming: true };
            }
            case "item/reasoning/summaryTextDelta": {
              if (it.type !== "reasoning") return it;
              const summary: string[] = [...(it.summary ?? [])];
              const idx = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
              while (summary.length <= idx) summary.push("");
              summary[idx] = (summary[idx] ?? "") + (params.delta ?? "");
              return { ...it, summary, streaming: true };
            }
            default: {
              if (it.type !== "commandExecution") return it;
              return {
                ...it,
                aggregatedOutput: (it.aggregatedOutput ?? "") + (params.delta ?? ""),
              };
            }
          }
        });
      }
      return { items: nextItems };
    });
  }

  function applyNotification(event: GatewayNotification): void {
    if (isDelta(event)) {
      if (overflowThreads.has(event.params.threadId)) return;
      if (event.params.delta.length > 1024 * 1024) {
        overflowThreads.add(event.params.threadId);
        appendToThread(event.params.threadId, makeErrorItem("单次流片段超过浏览器预算，显示已暂停；请通过完整历史核对结果。"));
        set((state) => ({ historyLoaded: { ...state.historyLoaded, [event.params.threadId]: false } }));
        return;
      }
      deltaBuffer.push(event);
      deltaBufferChars += event.params.delta.length;
      if (deltaBuffer.length >= 512 || deltaBufferChars >= 1024 * 1024) { flushDeltas(); return; }
      if (deltaFlushTimer === null) {
        deltaFlushTimer = window.setTimeout(() => {
          deltaFlushTimer = null;
          flushDeltas();
        }, 120);
      }
      return;
    }
    // Non-delta notifications must observe all prior deltas — flush first.
    flushDeltas();
    const { method, params } = event;
    if (params && typeof params === "object" && "threadId" in params && typeof params.threadId === "string") {
      if (deletedThreads.has(params.threadId) && method !== "thread/unarchived") return;
      if (["turn/started", "turn/completed", "thread/status/changed", "error"].includes(method)) {
        activityVersions.set(params.threadId, (activityVersions.get(params.threadId) ?? 0) + 1);
      }
    }
    switch (method) {
      case "serverRequest/answerRejected": {
        const requestId = params.serverRequestId ?? params.requestId;
        if (requestId === undefined) return;
        if (!get().inputRequests.some((request) => request.requestId === requestId)) return;
        submittedInputs.delete(requestId);
        set((state) => ({ inputRequestErrors: { ...state.inputRequestErrors, [String(requestId)]: boundedString(params.error, 2000) || "服务器拒绝了此回答，请检查后重试。" } }));
        return;
      }
      case "harness/turnAccepted": {
        const operation = get().sendOperations[params.threadId];
        if (operation?.clientOperationId === params.clientOperationId && operation.state !== "acknowledged_unknown") {
          const sendOperations = { ...get().sendOperations, [params.threadId]: { ...operation, state: "accepted" as const } };
          try { saveSendOperation(sendOperations[params.threadId]); } catch { /* Durable unknown remains recoverable. */ }
          set({ sendOperations });
        }
        set((state) => {
          let items = (state.items[params.threadId] ?? []).map((item) => item.type === "userMessage" && item.turnId === params.turnId
            ? { ...item, harnessAttachments: params.attachments, clientOperationId: params.clientOperationId } : item);
          if (items.some((item) => item.type === "userMessage" && item.clientOperationId === params.clientOperationId)) {
            items = items.filter((item) => {
              if (item.type !== "localUserMessage" || item.clientOperationId !== params.clientOperationId) return true;
              for (const attachment of item.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
              return false;
            });
          }
          return { items: { ...state.items, [params.threadId]: items } };
        });
        return;
      }
      case "management/stateChanged":
        managementNotificationVersion++;
        set({ management: normalizeManagement(params), managementError: null });
        return;
      case "item/started":
      case "item/completed": {
        if (!params?.item?.id || !params?.threadId) return;
        if (overflowThreads.has(params.threadId)) return;
        // upsertItem merges, so explicitly drop the local streaming marker —
        // otherwise a completed reasoning item keeps "思考中…" forever.
        const item: TimelineItem = { ...params.item, threadId: params.threadId, turnId: params.turnId, streaming: false, completed: method === "item/completed" };
        if (method === "item/started" && get().historyLoading[params.threadId]) historyStarts.get(params.threadId)?.add(item.id);
        if (method === "item/completed") {
          pendingHistoryDeltas.get(params.threadId)?.delete(item.id);
          pausedStreams.get(params.threadId)?.delete(item.id);
        }
        set((s) => {
          let items = s.items[params.threadId] ?? [];
          // Match the gateway's durable operation ID, not natural language.
          if (item.type === "userMessage") {
            for (const it of items) {
              if (it.type === "localUserMessage" && item.clientOperationId && it.clientOperationId === item.clientOperationId) {
                for (const att of it.attachments ?? []) {
                  if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
                }
              }
            }
            items = items.filter(
              (it) =>
                !(
                  it.type === "localUserMessage" &&
                  !!item.clientOperationId && it.clientOperationId === item.clientOperationId
                ),
            );
          }
          return { items: { ...s.items, [params.threadId]: upsertItem(items, item) } };
        });
        if (item.type === "contextCompaction") {
          if (method === "item/started") set((s) => ({ compacting: { ...s.compacting, [params.threadId]: true } }));
          else finishCompaction(params.threadId, "completed", "上下文压缩完成");
        }
        return;
      }
      case "item/fileChange/patchUpdated": {
        set((s) => ({ items: { ...s.items, [params.threadId]: patchItem(s.items[params.threadId] ?? [], params.itemId,
          (item) => item.type === "fileChange" ? { ...item, changes: params.changes } : item) } }));
        return;
      }
      case "turn/started": {
        set((s) => ({
          turnActive: { ...s.turnActive, [params.threadId]: true },
          activeTurnId: { ...s.activeTurnId, [params.threadId]: params.turn?.id ?? null },
        }));
        return;
      }
      case "turn/completed": {
        const active = get().activeTurnId[params.threadId];
        if (active && active !== params.turn.id) return;
        set((s) => ({
          turnActive: { ...s.turnActive, [params.threadId]: false },
          activeTurnId: { ...s.activeTurnId, [params.threadId]: null },
        }));
        // Titles (first-message preview) and timestamps settle server-side
        // only after rollout indexing; refresh once the turn is done.
        scheduleSessionsRefresh();
        if (pausedStreams.get(params.threadId)?.size && get().activeThreadId === params.threadId && !get().historyLoading[params.threadId]) {
          pausedStreams.delete(params.threadId);
          set((state) => ({ historyLoaded: { ...state.historyLoaded, [params.threadId]: false } }));
          void get().openThread(params.threadId);
        }
        return;
      }
      case "turn/diff/updated": {
        set((s) => ({ turnDiff: { ...s.turnDiff, [params.threadId]: params.diff ?? "" } }));
        return;
      }
      case "thread/tokenUsage/updated": {
        const u = params?.tokenUsage;
        if (!params?.threadId || !u) return;
        // `total.totalTokens` is CUMULATIVE across all turns (including cached
        // hits) — it grows forever and is NOT the context window occupancy.
        // `last.totalTokens` is the most recent turn's total, which represents
        // the conversation's current size vs the model window.
        const rawTotal = u.last?.totalTokens;
        const rawWindow = u.modelContextWindow;
        const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : 0;
        const window = typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : null;
        set((s) => ({
          tokenUsage: {
            ...s.tokenUsage,
            [params.threadId]: { total, window },
          },
        }));
        return;
      }
      case "thread/autoCompacting": {
        // Gateway-triggered auto-compaction (user comfort threshold, between turns).
        if (!params?.threadId) return;
        set((s) => ({ compacting: { ...s.compacting, [params.threadId]: true } }));
        const pct = params.windowTokens ? Math.round((params.usedTokens / params.windowTokens) * 100) : "?";
        appendToThread(params.threadId, {
          id: `auto-compact-${Date.now()}`,
          type: "compactionProgress",
          threadId: params.threadId,
          status: "inProgress",
          message: `上下文占用 ${pct}%（达到舒适阈值），正在自动压缩…`,
        });
        return;
      }
      case "thread/autoCompactFailed": {
        if (!params?.threadId) return;
        finishCompaction(params.threadId, "failed", `自动压缩失败: ${params.error}`);
        appendToThread(params.threadId, makeErrorItem(`自动压缩失败: ${params.error ?? "unknown"}`));
        return;
      }
      case "thread/compacted": {
        finishCompaction(params.threadId, "completed", "上下文压缩完成");
        scheduleSessionsRefresh();
        return;
      }
      case "thread/unarchived": {
        // Multi-tab sync: remove from the archived list if we're viewing it;
        // otherwise refresh so the restored thread reappears in the list.
        if (!params?.threadId) return;
        deletedThreads.delete(params.threadId);
        if (get().sessionArchived) {
          set((s) => ({ sessions: s.sessions.filter((x) => x.threadId !== params.threadId) }));
        } else {
          scheduleSessionsRefresh();
        }
        return;
      }
      case "turn/plan/updated": {
        set((s) => ({
          plan: {
            ...s.plan,
            [params.threadId]: { explanation: params.explanation ?? null, steps: params.plan ?? [] },
          },
        }));
        return;
      }
      case "error": {
        if (!params?.threadId) return;
        // A failed turn also ends any pending compaction; otherwise the
        // button would stay stuck on "压缩中…" forever. Same for the
        // turnActive flag — without this the composer keeps showing 停止.
        const active = get().activeTurnId[params.threadId];
        if (!params.willRetry && (!active || active === params.turnId)) {
          finishCompaction(params.threadId, "failed", "上下文压缩未完成");
          set((s) => ({ turnActive: { ...s.turnActive, [params.threadId]: false }, activeTurnId: { ...s.activeTurnId, [params.threadId]: null } }));
        }
        appendToThread(params.threadId, makeErrorItem(params.error?.message ?? "unknown error", !!params.willRetry));
        return;
      }
      case "thread/started":
      case "thread/name/updated": {
        scheduleSessionsRefresh();
        return;
      }
      case "thread/archived":
      case "thread/deleted": {
        // Remove immediately — the refresh merge keeps unknown tail items
        // (pagination), so a gone thread must be dropped explicitly.
        const gone = params?.threadId;
        if (gone) forgetThread(gone, method === "thread/deleted");
        scheduleSessionsRefresh();
        return;
      }
      case "account/updated":
      case "account/login/completed": {
        // The notification carries success/error — surface failures instead
        // of silently clearing the waiting state.
        if (method === "account/login/completed" && params.success === false) {
          set({ deviceLogin: { status: "error", error: boundedString(params?.error, 1_000) || "登录失败" } });
          return;
        }
        const generation = gateway.generation;
        const runtime = runtimeVersion;
        void gateway.request("account/read", undefined).then((account) => {
          if (generation === gateway.generation && runtime === runtimeVersion) set({ account });
        }).catch(() => {});
        if (get().deviceLogin?.status === "waiting") set({ deviceLogin: null });
        return;
      }
      case "appServer/stateChanged": {
        set({ codexState: params?.state ?? "unknown" });
        // App-server restart kills all its terminal sessions and may change
        // model/account state. Force a full refresh + clear caches when it
        // comes back to ready, even if our WebSocket never dropped.
        clearRuntimeState();
        if (params.state === "ready" && get().connection === "open") void get().refresh();
        return;
      }
      case "displayPrefs/updated": {
        // Broadcast from the gateway when ANY browser changes display prefs.
        if (params) set({ display: normalizeDisplay(params, get().display) });
        return;
      }
      case "warning": {
        // Server-side warnings (deprecated config keys, sandbox hints, etc.)
        // — surface in the active thread instead of silently dropping.
        if (params?.threadId) {
          appendToThread(params.threadId, makeErrorItem(`⚠ ${params.message ?? JSON.stringify(params).slice(0, 200)}`));
        } else {
          console.warn("[codex]", params);
        }
        return;
      }
      case "configWarning": {
        console.warn("[codex config]", params.summary, params.details);
        return;
      }
      case "thread/status/changed": {
        // Update the session's turn activity hint if we have the thread.
        if (params.threadId) {
          const active = params.status.type === "active";
          set((s) => ({
            turnActive: { ...s.turnActive, [params.threadId]: active },
            ...(!active ? { activeTurnId: { ...s.activeTurnId, [params.threadId]: null } } : {}),
          }));
        }
        return;
      }
      case "thread/queue/changed": {
        // Queue changes do not imply that the currently running turn ended.
        return;
      }
      case "serverRequest/resolved": {
        // The gateway broadcasts with serverRequestId (matching its own
        // auto-decline path); accept both spellings defensively.
        const rid = params?.requestId ?? params?.serverRequestId;
        if (rid === undefined) return;
        submittedInputs.delete(rid);
        set((s) => {
          const inputRequestErrors = { ...s.inputRequestErrors }; delete inputRequestErrors[String(rid)];
          return { approvals: s.approvals.filter((a) => a.requestId !== rid), inputRequests: s.inputRequests.filter((request) => request.requestId !== rid), inputRequestErrors };
        });
        return;
      }
      default:
        return;
    }
  }

  function handleServerRequest(msg: ServerRequestMsg): void {
    // Prompts remain pending until explicit user action or server timeout.
    if (msg.method === "item/commandExecution/requestApproval" || msg.method === "item/fileChange/requestApproval" || msg.method === "item/permissions/requestApproval") {
      set((s) => ({
        approvals: [
          ...s.approvals.filter((a) => a.requestId !== msg.requestId),
          msg,
        ],
      }));
      return;
    }
    if (msg.method === "item/tool/requestUserInput" || msg.method === "mcpServer/elicitation/request") {
      set((state) => ({ inputRequests: [...state.inputRequests.filter((request) => request.requestId !== msg.requestId), msg].slice(-128) }));
      return;
    }
  }

  return {
  connection: "connecting",
  connectionError: null,
  management: { state: "idle" },
  managementError: null,
  codexState: "unknown",
  gatewayVersion: "",
  workspaceRoot: "",
  providerMode: "openai",
  account: null,
    projects: [],
    currentProject: loadCurrentProject(),
    models: [],
    mcpServers: [],
    settings: loadSettings(),
    display: { ...DEFAULT_DISPLAY },
    displayError: null,
    sendOperations: loadSendOperations(),
    sessions: [],
    sessionCursor: null,
    sessionLoading: false,
    sessionLoadingMore: false,
    sessionSearch: "",
    sessionArchived: false,
    activeThreadId: null,
    items: {},
    historyLoaded: {},
    historyLoading: {},
    turnActive: {},
    activeTurnId: {},
    turnDiff: {},
    tokenUsage: {},
    compacting: {},
    plan: {},
    approvals: [],
    inputRequests: [],
    inputRequestErrors: {},
    deviceLogin: null,
    drawerTab: null,
    sidebarOpen: false,

    bootstrap() {
      // React StrictMode intentionally runs mount effects twice in development.
      // The store is process-global, so registering a second set of socket
      // listeners would duplicate every notification and reconnect refresh.
      if (bootstrapped) return;
      bootstrapped = true;
      const initial = boundedString(new URLSearchParams(location.search).get("threadId"), 256);
      if (initial) {
        set({ activeThreadId: initial });
        initialThreadSelected = true;
      }
      applyTheme(get().settings.theme);
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
        if (get().settings.theme === "system") applyTheme("system");
      });
      let everConnected = false;
      gateway.onStateChange((state) => {
        if (state !== "open") {
          clearRuntimeState();
          set({
            connection: state,
            connectionError: gateway.failure === "authentication" ? "网关认证已失效，请重新打开登录入口完成认证后刷新页面。"
              : gateway.failure === "configuration" ? "网关拒绝此页面来源，请检查访问域名、端口与反向代理配置后刷新页面。" : null,
            approvals: [],
            deviceLogin: null,
            sessionLoading: false,
            sessionLoadingMore: false,
          });
          return;
        }
        set((current) => ({ connection: state, connectionError: null,
          management: current.management.state === "idle" ? { ...current.management, state: "unknown", error: "正在核对服务器管理状态。" } : current.management }));
        if (everConnected) {
          // A real DROP-then-reconnect: the gateway or app-server may have
          // restarted server-side. Cached items are potentially stale, and a
          // fresh app-server doesn't know our threads — sending would fail
          // with "thread not found". Clear everything and re-resume below.
          clearRuntimeState();
        }
        everConnected = true;
        // This control-plane query remains available even if the data worker
        // cannot serve app/status. Reconnect observes; it never replays writes.
        void get().refreshManagement();
        void get().refresh();
        for (const operation of Object.values(get().sendOperations)) {
          if (operation.state === "unknown") void get().checkSendOperation(operation.threadId);
        }
      });
      gateway.onNotification(applyNotification);
      window.addEventListener?.("storage", (event) => {
        if (event.key?.startsWith(OPERATIONS_KEY)) set((state) => ({ sendOperations: { ...state.sendOperations, ...loadSendOperations() } }));
      });
      gateway.setServerRequestHandler(handleServerRequest);
      gateway.connect();

    },

    async refresh() {
      const seq = ++refreshRequestSeq;
      const generation = gateway.generation;
      const managementVersion = managementNotificationVersion;
      try {
        const status = await gateway.rpc<any>("app/status");
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        const providerMode = normalizeProviderMode(status?.providerMode);
        const providerChanged = providerMode !== get().providerMode;
        let settings = get().settings;
        if (providerChanged) {
          // Models and effort catalogs are provider-specific. Reset both the
          // visible catalogs and persisted selections immediately instead of
          // briefly sending/showing a value from the old endpoint.
          modelRequestSeq += 1;
          modelsLoadedFor = null;
        }
        if (providerChanged) {
          settings = normalizeSettings({
            ...settings,
            ...(providerChanged ? { selectedModel: "" } : {}),
            selectedEffort: "",
          });
          saveSettings(settings);
        }
        set({
          gatewayVersion: boundedString(status?.gatewayVersion, 64),
          codexState: boundedString(status?.codexState, 64) || "unknown",
          workspaceRoot: boundedString(status?.workspaceRoot, 4096),
          providerMode,
          ...(managementVersion === managementNotificationVersion && status?.management ? { management: normalizeManagement(status.management) } : {}),
          ...(providerChanged ? { models: [], mcpServers: [], account: null } : {}),
          ...(providerChanged ? { settings } : {}),
          display: normalizeDisplay({ autoCompactThreshold: status?.autoCompactThreshold }, get().display),
        });
        await Promise.all([
          gateway.request("account/read", undefined).then((account) => {
            if (seq === refreshRequestSeq && generation === gateway.generation) set({ account });
          }).catch(() => {}),
          gateway
            .rpc<Partial<Display>>("displayPrefs/get")
            .then((prefs) => {
              if (prefs && seq === refreshRequestSeq && generation === gateway.generation) {
                set({ display: normalizeDisplay(prefs, get().display) });
              }
            })
            .catch(() => {}),
          get().refreshProjects(),
          get().refreshModels(),
          get().refreshMcp(),
        ]);
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        await get().refreshSessions();
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        // Re-opening the active thread after a reconnect is handled by the
        // connection watcher in bootstrap() (it re-resumes server-side too).
        // #4: entering the WebUI lands in the most recent session, not a
        // blank new-conversation screen (only on the first successful load).
        if (get().activeThreadId) {
          await get().openThread(get().activeThreadId!);
        } else if (!initialThreadSelected) {
          const first = get().sessions[0];
          if (first) void get().openThread(first.threadId).catch(() => {});
        }
        initialThreadSelected = true;
      } catch {
        /* next reconnect retries */
      }
    },

    async refreshManagement() {
      const seq = ++managementRequestSeq;
      const generation = gateway.generation;
      const version = managementNotificationVersion;
      try {
        const snapshot = await gateway.rpc<unknown>("management/status");
        if (seq !== managementRequestSeq || generation !== gateway.generation || version !== managementNotificationVersion) return;
        managementNotificationVersion++;
        set({ management: normalizeManagement(snapshot), managementError: null });
      } catch (error) {
        if (seq !== managementRequestSeq || generation !== gateway.generation || version !== managementNotificationVersion) return;
        set((current) => ({ management: { ...current.management, state: "unknown" }, managementError: `管理状态未能核对：${error instanceof Error ? error.message : String(error)}` }));
      }
    },

    async refreshSessions() {
      const seq = ++sessionRequestSeq;
      const generation = gateway.generation;
      const { currentProject, sessionArchived, sessionSearch } = get();
      const context = JSON.stringify([currentProject, sessionArchived, sessionSearch.trim()]);
      const windowPages = Math.max(
        get().sessions.length && context === sessionWindowContext ? sessionWindowPages : 1,
        Math.ceil(get().sessions.filter((s) => !localSessions.has(s.threadId)).length / 50),
      );
      // Reset BOTH loading flags — a pending loadMore from a previous query
      // context might have set loadingMore and its stale return won't clear it.
      set({ sessionLoading: true, sessionLoadingMore: false });
      try {
        const params: ThreadListParams = { limit: 50 };
        if (currentProject) params.cwd = currentProject;
        if (sessionArchived) params.archived = true;
        if (sessionSearch.trim()) params.searchTerm = sessionSearch.trim();
        const byId = new Map<string, SessionInfo>();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        let loadedPages = 0;
        // Refresh the entire loaded window before publishing either its rows
        // or its cursor. A failed/stale page leaves the prior snapshot intact.
        for (let page = 0; page < windowPages; page++) {
          const res: ThreadListResponse = await gateway.request("thread/list", { ...params, ...(cursor ? { cursor } : {}) });
          if (seq !== sessionRequestSeq || generation !== gateway.generation) return;
          loadedPages += 1;
          const threads = Array.isArray(res?.data) ? res.data.slice(0, 100) : [];
          const sessions: SessionInfo[] = threads
            .map((t) => ({
              threadId: boundedString(t?.id, 256),
              title: boundedString(t?.name || t?.preview, 200) || "（无标题会话）",
              updatedAt: typeof t?.updatedAt === "number" && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
            }))
            .filter((s) => s.threadId && !deletedThreads.has(s.threadId));
          for (const session of sessions) byId.set(session.threadId, session);
          cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor.slice(0, 512) : null;
          if (!cursor) break;
          if (seenCursors.has(cursor)) throw new Error("Repeated session cursor");
          seenCursors.add(cursor);
        }
        let sessions = [...byId.values()];
        // The server's thread list lags behind rollout indexing; keep entries
        // we registered locally within the last 5 minutes — but only when
        // we're on the "current" tab with no search filter.
        if (!sessionArchived && !sessionSearch.trim()) {
          const nowSec = Math.floor(Date.now() / 1000);
          const freshLocals: SessionInfo[] = [];
          for (const [id, local] of localSessions) {
            if (byId.has(id) || nowSec - local.session.updatedAt >= 300 || deletedThreads.has(id)) localSessions.delete(id);
            else if (local.cwd === currentProject) freshLocals.push(local.session);
          }
          if (freshLocals.length > 0) sessions = [...freshLocals, ...sessions];
        }
        // Server already sorts by updated_at desc (gateway sets sortKey), so
        // we preserve cursor order — no client-side re-sort on paginated data.
        sessionWindowContext = context;
        sessionWindowPages = loadedPages;
        set({
          sessions,
          sessionCursor: cursor,
          sessionLoading: false,
        });
      } catch {
        if (seq === sessionRequestSeq && generation === gateway.generation) set({ sessionLoading: false });
      }
    },

    async loadMoreSessions() {
      const cursor = get().sessionCursor;
      if (!cursor || get().sessionLoadingMore || get().sessionLoading) return;
      const seq = ++sessionRequestSeq;
      const generation = gateway.generation;
      const context = JSON.stringify([get().currentProject, get().sessionArchived, get().sessionSearch.trim()]);
      set({ sessionLoadingMore: true });
      try {
        const params: ThreadListParams = { limit: 50, cursor };
        if (get().currentProject) params.cwd = get().currentProject;
        if (get().sessionArchived) params.archived = true;
        if (get().sessionSearch.trim()) params.searchTerm = get().sessionSearch.trim();
        const res = await gateway.request("thread/list", params);
        if (seq !== sessionRequestSeq || generation !== gateway.generation) return;
        const newThreads: SessionInfo[] = (Array.isArray(res?.data) ? res.data.slice(0, 100) : [])
          .map((t) => ({
            threadId: boundedString(t?.id, 256),
            title: boundedString(t?.name || t?.preview, 200) || "（无标题会话）",
            updatedAt: typeof t?.updatedAt === "number" && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
          }))
          .filter((s: SessionInfo) => s.threadId);
        // Append + dedupe: existing ids updated in place, new ids appended.
        // Preserve the server's cursor ordering — no global re-sort.
        const byId = new Map(get().sessions.map((s) => [s.threadId, s]));
        for (const s of newThreads) { byId.set(s.threadId, s); localSessions.delete(s.threadId); }
        sessionWindowPages = (context === sessionWindowContext ? sessionWindowPages : 1) + 1;
        sessionWindowContext = context;
        set({
          sessions: [...byId.values()],
          sessionCursor: typeof res?.nextCursor === "string" ? res.nextCursor.slice(0, 512) : null,
          sessionLoadingMore: false,
        });
      } catch {
        if (seq === sessionRequestSeq && generation === gateway.generation) set({ sessionLoadingMore: false });
      }
    },

    setSessionSearch(term: string) {
      // Invalidate an in-flight query immediately; waiting until the debounce
      // callback lets old results flash under the new search term.
      sessionRequestSeq += 1;
      set({ sessionSearch: term.slice(0, 200), sessions: [], sessionCursor: null, sessionLoading: false, sessionLoadingMore: false });
      // Debounce the actual query so rapid typing doesn't flood the server.
      if (sessionSearchTimer !== null) clearTimeout(sessionSearchTimer);
      sessionSearchTimer = window.setTimeout(() => {
        sessionSearchTimer = null;
        void get().refreshSessions();
      }, 300);
    },

    setSessionArchived(archived: boolean) {
      // Reset list state — mixing active and archived cursors corrupts pagination.
      set({ sessionArchived: archived, sessions: [], sessionCursor: null });
      void get().refreshSessions();
    },

    async unarchiveThread(threadId) {
      try {
        await gateway.rpc("thread/unarchive", { threadId });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`恢复失败: ${err.message}`));
        return;
      }
      set((s) => ({ sessions: s.sessions.filter((x) => x.threadId !== threadId) }));
    },

    async refreshProjects() {
      const seq = ++projectRequestSeq;
      const generation = gateway.generation;
      try {
        const res = await gateway.rpc<any>("projects/list");
        if (seq !== projectRequestSeq || generation !== gateway.generation) return;
        const projects: ProjectEntry[] = (Array.isArray(res?.projects) ? res.projects : [])
          .slice(0, 1_000)
          .map((entry: any) => ({
            path: boundedString(entry?.path, 4096),
            addedAt: typeof entry?.addedAt === "number" && Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
            lastUsedAt: typeof entry?.lastUsedAt === "number" && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0,
            available: entry?.available !== false,
          }))
          .filter((entry: ProjectEntry) => entry.path);
        const previous = get().currentProject;
        let current = previous;
        if (!current || !projects.some((p) => p.path === current)) {
          current = projects[0]?.path ?? "";
        }
        try {
          localStorage.setItem(PROJECT_KEY, current);
        } catch {
          /* ignore */
        }
        if (current !== previous && !get().activeThreadId) {
          sessionRequestSeq += 1;
          openThreadRequestSeq += 1;
          newThreadRequestSeq += 1;
          set({
            projects,
            currentProject: current,
            activeThreadId: null,
            items: {},
            historyLoaded: {}, historyLoading: {},
            sessions: [],
            sessionCursor: null,
            sessionLoading: false,
            sessionLoadingMore: false,
          });
          syncUrl(null);
        } else {
          set({ projects, currentProject: current });
        }
      } catch {
        /* keep previous */
      }
    },

    async refreshModels() {
      // Loop-paginate model/list until exhausted (most providers return a
      // single page, but large catalogs need multiple requests).
      const generation = ++modelRequestSeq;
      const connectionGeneration = gateway.generation;
      const provider = get().providerMode;
      try {
        const all: ModelInfo[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        let lastCursor: string | null = null;
        const MAX_PAGES = 100; // 100 × 100 = 10k models; guard against a
        // server that keeps returning cursors (loop protection), not a real
        // catalog limit. A warning marks the (unreachable in practice) case.
        for (let page = 0; page < MAX_PAGES; page++) {
          const params: Record<string, unknown> = { limit: 100 };
          if (cursor) params.cursor = cursor;
          const res = await gateway.request("model/list", params);
          if (generation !== modelRequestSeq || connectionGeneration !== gateway.generation || provider !== get().providerMode) return;
          for (const m of Array.isArray(res?.data) ? res.data : []) {
            const id = boundedString(m?.id, MAX_MODEL_ID_LENGTH);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            all.push({ id, displayName: boundedString(m?.displayName, 256) || id,
              reasoningEfforts: normalizeReasoningEfforts(m?.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort)),
              defaultReasoningEffort: normalizeReasoningEfforts([m?.defaultReasoningEffort])[0], isDefault: m?.isDefault === true });
          }
          cursor = res?.nextCursor ?? null;
          if (!cursor || cursor === lastCursor) break;
          lastCursor = cursor;
        }
        if (cursor) console.warn(`[webui] model catalog truncated at ${MAX_PAGES} pages`);
        if (generation === modelRequestSeq && connectionGeneration === gateway.generation && provider === get().providerMode) {
          set({ models: all });
          modelsLoadedFor = provider;
          const settings = get().settings;
          if (settings.selectedModel && !seen.has(settings.selectedModel)) {
            const next = normalizeSettings({ ...settings, selectedModel: "" });
            saveSettings(next);
            set({ settings: next });
          }
        }
      } catch {
        if (generation === modelRequestSeq && connectionGeneration === gateway.generation && provider === get().providerMode) {
          // Transient failure under the SAME provider: keep the list. Under a
          // DIFFERENT provider it would be stale (wrong endpoint's models)
          // — drop it so selectors fall back to 默认模型 until a reload works.
          if (modelsLoadedFor !== null && modelsLoadedFor !== get().providerMode) {
            console.warn("[webui] model list failed for the new provider — dropping stale list");
            set({ models: [] });
            modelsLoadedFor = null;
          }
        }
      }
    },

    async refreshMcp() {
      const seq = ++mcpRequestSeq;
      const generation = gateway.generation;
      try {
        const res = await gateway.request("mcpServerStatus/list", undefined);
        if (seq !== mcpRequestSeq || generation !== gateway.generation) return;
        const mcpServers = (Array.isArray(res?.data) ? res.data : [])
          .slice(0, 200)
          .filter((entry) => typeof entry?.name === "string" && entry.name.length > 0)
          .map((entry) => ({ ...entry, name: entry.name.slice(0, 256) }));
        set({ mcpServers });
      } catch {
        /* MCP status is a nicety */
      }
    },

    async addProject(path, create) {
      const target = path.trim().slice(0, 4096);
      if (!target) throw new Error("项目路径不能为空");
      await gateway.rpc("projects/add", { path: target, create: create === true });
      await get().refreshProjects();
    },

    async removeProject(path) {
      await gateway.rpc("projects/remove", { path });
      await get().refreshProjects();
      await get().refreshSessions();
    },

    async selectProject(path) {
      path = path.trim().slice(0, 4096);
      if (!path || path === get().currentProject) return;
      sessionRequestSeq += 1;
      openThreadRequestSeq += 1;
      newThreadRequestSeq += 1;
      try {
        localStorage.setItem(PROJECT_KEY, path);
      } catch {
        /* ignore */
      }
      set({
        currentProject: path,
        activeThreadId: null,
        items: {},
        historyLoaded: {}, historyLoading: {},
        sessions: [],
        sessionCursor: null,
        sessionLoading: false,
        sessionLoadingMore: false,
      });
      syncUrl(null);
      void gateway.rpc("projects/touch", { path }).catch(() => {});
      await get().refreshProjects();
      await get().refreshSessions();
    },

    updateSettings(patch) {
      const settings = normalizeSettings({ ...get().settings, ...patch });
      if (patch.selectedModel !== undefined && !selectedModelEfforts(get().models, settings.selectedModel).includes(settings.selectedEffort as Exclude<ReasoningEffort, "">)) settings.selectedEffort = "";
      saveSettings(settings);
      set({ settings });
      applyTheme(settings.theme);
    },

    updateDisplay(patch) {
      const validated: Partial<Display> = {};
      for (const key of ["reasoning", "commands", "fileChanges", "mcpCalls", "webSearch"] as const) {
        if (typeof patch[key] === "boolean") validated[key] = patch[key];
      }
      if (typeof patch.autoCompactThreshold === "number" && Number.isFinite(patch.autoCompactThreshold) && patch.autoCompactThreshold >= 0 && patch.autoCompactThreshold <= 1) validated.autoCompactThreshold = patch.autoCompactThreshold;
      if (!Object.keys(validated).length) return;
      // Only send the requested fields. A stale tab must not overwrite other
      // browsers' unrelated preferences. No optimistic state to roll back.
      set({ displayError: null });
      // The ordered displayPrefs/updated broadcast is authoritative. A full
      // RPC snapshot could be older than a different tab's later broadcast.
      void gateway.rpc("displayPrefs/set", validated).catch((error) => set({ displayError: `设置未保存：${error instanceof Error ? error.message : String(error)}` }));
    },

    async checkSendOperation(threadId, clientOperationId) {
      const current = get().sendOperations[threadId];
      const operation: SendOperation | undefined = clientOperationId && current?.clientOperationId !== clientOperationId
        ? { threadId, clientOperationId, state: "unknown" } : current;
      if (!operation || operation.state !== "unknown") return;
      try {
        const result = await gateway.rpc<{ state: SendOperation["state"]; error?: string }>("turn/operation", { clientOperationId: operation.clientOperationId });
        if (!["accepted", "not_received", "rejected", "unknown"].includes(result?.state)) return;
        const latest = get().sendOperations[threadId];
        if (latest?.clientOperationId === operation.clientOperationId && latest.state !== "unknown") return latest;
        const checked = { ...operation, state: result.state, error: result.error };
        // A Composer may still own an older draft after another tab starts a
        // newer operation. Resolve that exact ID without replacing the new one.
        if (latest?.clientOperationId === operation.clientOperationId) {
          saveSendOperation(checked);
          set({ sendOperations: { ...get().sendOperations, [threadId]: checked } });
        }
        return checked;
      } catch { /* Retain unknown until the same operation can be reconciled. */ }
    },

    acknowledgeUnknownSend(threadId, clientOperationId) {
      const operation = get().sendOperations[threadId];
      if (!operation || operation.clientOperationId !== clientOperationId || operation.state !== "unknown") return false;
      const acknowledged: SendOperation = { ...operation, state: "acknowledged_unknown" };
      // A local release is not evidence of acceptance/rejection. Keep the
      // original ID recorded and never mutate/retry its server-side ledger.
      try { saveSendOperation(acknowledged); } catch { return false; }
      set((state) => ({ sendOperations: { ...state.sendOperations, [threadId]: acknowledged },
        items: { ...state.items, [threadId]: (state.items[threadId] ?? []).filter((item) => item.type !== "localUserMessage" || item.clientOperationId !== clientOperationId) } }));
      return true;
    },

    uploadAttachment(name, base64, kind) {
      if (!base64 || base64.length > MAX_ATTACHMENT_BASE64_CHARS) {
        return Promise.reject(new Error("附件编码后超过 25MB 文件传输上限"));
      }
      return gateway.rpc<{ path: string; size: number }>("attachment/upload", {
        name: name.slice(0, 255) || "file",
        base64,
        kind: kind === "image" ? "image" : "file",
      });
    },

    readAttachment(path) {
      return gateway.rpc<{ base64: string; mime: string }>("attachment/read", { path });
    },

    deleteAttachment(path) {
      return gateway.rpc("attachment/delete", { path }).then(() => undefined);
    },

    async openThread(threadId) {
      threadId = boundedString(threadId, 256);
      if (!threadId || deletedThreads.has(threadId)) return;
      overflowThreads.delete(threadId);
      newThreadRequestSeq += 1;
      const requestSeq = ++openThreadRequestSeq;
      const generation = gateway.generation;
      const previous = get().activeThreadId;
      if (previous && previous !== threadId) {
        pendingHistoryDeltas.delete(previous);
        set((s) => ({ historyLoading: { ...s.historyLoading, [previous]: false } }));
      }
      set({ activeThreadId: threadId, sidebarOpen: false });
      syncUrl(threadId);
      if (get().historyLoaded[threadId]) return;
      pendingHistoryDeltas.delete(threadId);
      historyStarts.set(threadId, new Set());
      set((s) => ({ historyLoading: { ...s.historyLoading, [threadId]: true } }));
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Activate first so output is subscribed before reading the full
          // snapshot. Do not enable sending until activation completes.
          let activationError: unknown;
          try { await gateway.request("thread/resume", { threadId }); }
          catch (error) { activationError = error; }
          if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
          const activityVersion = activityVersions.get(threadId) ?? 0;
          const { thread } = await gateway.request("thread/read", { threadId, includeTurns: true });
          if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
          flushDeltas();
          if (get().activeThreadId === threadId) {
            const items = flattenTurns(thread).map((it) => ({ ...it, threadId }));
            const uncertain = pendingHistoryDeltas.get(threadId);
            if (uncertain?.size) {
              pausedStreams.set(threadId, uncertain);
              items.push({ ...makeErrorItem("重连期间的流片段没有序号，无法与快照安全对齐；暂时显示快照，等待完整条目或任务结束后刷新。"), threadId });
            }
            if (activationError) items.push({ ...makeErrorItem(`历史已加载，但会话无法激活: ${activationError instanceof Error ? activationError.message : String(activationError)}（重新选择可重试）`, false), threadId, historyLoadError: true });
            const running = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
            const unchanged = activityVersion === (activityVersions.get(threadId) ?? 0);
            const projectChanged = !!thread.cwd && thread.cwd !== get().currentProject;
            set((s) => ({
              items: { ...s.items, [threadId]: mergeHistory(items, (s.items[threadId] ?? []).filter((item) => item.type !== "errorItem" || !item.historyLoadError), historyStarts.get(threadId) ?? new Set()) },
              historyLoaded: { ...s.historyLoaded, [threadId]: !activationError },
              historyLoading: { ...s.historyLoading, [threadId]: false },
              ...(unchanged ? {
                turnActive: { ...s.turnActive, [threadId]: thread.status.type === "active" || !!running },
                activeTurnId: { ...s.activeTurnId, [threadId]: running?.id ?? null },
              } : s.turnActive[threadId] && !s.activeTurnId[threadId] && running ? {
                activeTurnId: { ...s.activeTurnId, [threadId]: running.id },
              } : {}),
              ...(projectChanged ? { currentProject: thread.cwd, sessions: [], sessionCursor: null } : {}),
            }));
            pendingHistoryDeltas.delete(threadId);
            historyStarts.delete(threadId);
            if (projectChanged) {
              try { localStorage.setItem(PROJECT_KEY, thread.cwd); } catch { /* storage unavailable */ }
              await get().refreshSessions();
            }
          }
          return;
        } catch (err: any) {
          if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
          if (attempt === 2) {
            // Never swallow a failed history load silently — that showed up
            // as "refresh loses all messages". Surface it and retry on click.
            appendToThread(threadId, {
              ...makeErrorItem(`会话历史加载失败: ${err.message}（切换会话后重进可重试）`),
              historyLoadError: true,
            });
            set((s) => ({ historyLoading: { ...s.historyLoading, [threadId]: false } }));
            return;
          }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    },

    async newThread() {
      const { currentProject, settings } = get();
      const requestSeq = ++newThreadRequestSeq;
      const generation = gateway.generation;
      const params: Pick<ThreadStartParams, "cwd" | "model" | "approvalPolicy"> = {};
      if (currentProject) params.cwd = currentProject;
      // Same guard as sendTurn: a localStorage model left over from another
      // provider mode could 400 thread/start when the new provider's catalog
      // hasn't loaded — only send selections valid for the CURRENT provider.
      const models = get().models;
      if (settings.selectedModel && models.some((m) => m.id === settings.selectedModel)) {
        params.model = settings.selectedModel;
      }
      if (settings.selectedApprovalPolicy) params.approvalPolicy = settings.selectedApprovalPolicy;
      const res = await gateway.request("thread/start", params);
      const threadId = boundedString(res?.thread?.id, 256);
      if (!threadId) {
        // thread/start "succeeded" but returned no id — treat as a hard error
        // so sendMessage's catch block can show it (and the composer text
        // survives because newThread throws BEFORE sendTurn clears it).
        throw new Error(`thread/start returned no thread.id: ${JSON.stringify(res).slice(0, 200)}`);
      }
      if (
        requestSeq !== newThreadRequestSeq ||
        generation !== gateway.generation ||
        currentProject !== get().currentProject
      ) {
        // The server did create the thread, but the user navigated elsewhere
        // while it was in flight. Do not steal focus or send their draft into
        // a different project/thread; the created thread will appear on the
        // next server-side list refresh.
        void get().refreshSessions().catch(() => {});
        return null;
      }
      if (currentProject) void gateway.rpc("projects/touch", { path: currentProject }).catch(() => {});
      {
        // The server-side thread list lags behind rollout indexing by a long
        // while; register the session locally so the sidebar shows it at once.
        // A new session belongs in the CURRENT tab with no search filter —
        // viewing the archive or a filtered list must not capture it.
        if (sessionSearchTimer !== null) {
          clearTimeout(sessionSearchTimer);
          sessionSearchTimer = null;
        }
        const local: SessionInfo = { threadId, title: "新对话", updatedAt: Math.floor(Date.now() / 1000) };
        localSessions.set(threadId, { session: local, cwd: currentProject });
        sessionRequestSeq += 1;
        set((s) => ({
          items: { ...s.items, [threadId]: [] },
          historyLoaded: { ...s.historyLoaded, [threadId]: true },
          sessions: [local, ...(!s.sessionArchived && !s.sessionSearch ? s.sessions.filter((x) => x.threadId !== threadId) : [])],
          sessionArchived: false,
          sessionSearch: "",
          sessionCursor: null,
          sidebarOpen: false,
        }));
        await get().openThread(threadId);
      }
      void get().refreshSessions().catch(() => {});
      return threadId;
    },

    /** Composer entry: typing with no session selected starts a new one. */
    async sendMessage(text, attachments, onOperation) {
      let targetThreadId = get().activeThreadId;
      if (!targetThreadId) {
        try {
          targetThreadId = await get().newThread();
        } catch (err: any) {
          console.error("[webui] failed to create session:", err);
          throw err; // propagate so the Composer knows the send failed
        }
      }
      if (!targetThreadId || get().activeThreadId !== targetThreadId) {
        throw new Error("创建会话期间已切换项目或会话，消息未发送");
      }
      await get().sendTurn(text, attachments, onOperation);
    },

    async sendTurn(text, attachments, onOperation) {
      const runtime = runtimeVersion;
      const threadId = get().activeThreadId;
      if (!threadId) return;
      if (get().management.state !== "idle") throw new Error("管理操作正在进行，请完成后再发送消息");
      if (!get().historyLoaded[threadId]) throw new Error("会话历史尚未完成加载，请稍后重试");
      if (get().turnActive[threadId]) throw new Error("会话正在运行，请等待完成或先停止");
      if (get().sendOperations[threadId]?.state === "unknown") throw new Error("上一条消息是否已受理尚未确认；请先核对发送状态，不能重复发送");
      if (Object.values(get().sendOperations).filter((entry) => entry.state === "unknown").length >= 100) throw new Error("待确认发送过多，请先核对已有会话");
      const clientOperationId = operationId();
      const operation: SendOperation = { clientOperationId, threadId, state: "unknown" };
      const pendingOperations = { ...get().sendOperations, [threadId]: operation };
      try {
        saveSendOperation(operation);
        const prior = get().sendOperations[threadId];
        if (prior?.state === "acknowledged_unknown") localStorage.removeItem(`${OPERATIONS_KEY}${prior.clientOperationId}`);
      } catch { throw new Error("浏览器无法保存发送标识，消息未发送；请允许本站本地存储后重试"); }
      // Bind UI ownership only after a real thread and durable operation exist,
      // but before any observable state change or asynchronous delivery.
      onOperation?.({ threadId, clientOperationId });
      set({ sendOperations: pendingOperations });
      const activityVersion = (activityVersions.get(threadId) ?? 0) + 1;
      activityVersions.set(threadId, activityVersion);
      const atts = attachments ?? [];
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((s) => ({
        turnActive: { ...s.turnActive, [threadId]: true },
        items: {
          ...s.items,
          [threadId]: [
            ...(s.items[threadId] ?? []),
            { id: localId, type: "localUserMessage", text, threadId, attachments: atts, clientOperationId },
          ],
        },
      }));
      try {
        // Per-turn overrides so switching model/policy/sandbox/effort in the
        // composer takes effect on the very next message, mid-session
        // included. Model and effort selections persist in localStorage, so
        // guard them against the CURRENT provider's live data — a value left
        // over from another provider mode (e.g. effort "xhigh" probed on a
        // local vLLM) could 400 against a different endpoint.
        const { selectedModel, selectedApprovalPolicy, selectedSandbox, selectedEffort } = get().settings;
        const modelOk = selectedModel && get().models.some((m) => m.id === selectedModel);
        const effortOk = selectedEffort && selectedModelEfforts(get().models, selectedModel).includes(selectedEffort);
        // null selects the gateway's configured defaults. The gateway resolves
        // concrete values because app-server null does not reset sticky values.
        await gateway.request("turn/start", {
          threadId,
          clientOperationId,
          text,
          ...(atts.length ? { attachments: atts.map(({ kind, name, path }) => ({ kind, name, path })) } : {}),
          model: modelOk ? selectedModel : null,
          approvalPolicy: selectedApprovalPolicy || null,
          sandbox: selectedSandbox || null,
          effort: effortOk ? selectedEffort : null,
        });
        if (get().sendOperations[threadId]?.clientOperationId !== clientOperationId || get().sendOperations[threadId]?.state === "acknowledged_unknown") return;
        const sendOperations = { ...get().sendOperations, [threadId]: { ...operation, state: "accepted" as const } };
        try { saveSendOperation(sendOperations[threadId]); } catch { /* Keep durable unknown; it resolves safely on next load. */ }
        set({ sendOperations });
      } catch (err: any) {
        if (get().sendOperations[threadId]?.clientOperationId !== clientOperationId || get().sendOperations[threadId]?.state === "acknowledged_unknown") throw err;
        if (get().sendOperations[threadId]?.clientOperationId === clientOperationId && get().sendOperations[threadId]?.state === "accepted") return;
        const definitive = err?.delivery === "not_sent" || err?.delivery === "rejected" && err?.code !== "OPERATION_UNKNOWN";
        const sendOperations = { ...get().sendOperations, [threadId]: { ...operation, state: definitive ? "rejected" as const : "unknown" as const, error: String(err?.message ?? err).slice(0, 1000) } };
        try { saveSendOperation(sendOperations[threadId]); } catch { /* Do not lose the in-memory lock. */ }
        set({ sendOperations });
        if (runtime !== runtimeVersion || deletedThreads.has(threadId)) throw err;
        set((s) => ({
          ...(activityVersion === activityVersions.get(threadId)
            ? { turnActive: { ...s.turnActive, [threadId]: false } } : {}),
          // The Composer retains the text, attachments and preview URLs for a
          // retry, so remove only this failed optimistic echo without
          // revoking resources that it still owns.
          items: {
            ...s.items,
            [threadId]: (s.items[threadId] ?? []).filter((item) => item.id !== localId),
          },
        }));
        appendToThread(threadId, makeErrorItem(definitive ? err.message : "发送结果待确认：服务器可能已开始执行，未自动重发。请点击「核对发送状态」。"));
        // Do not delete attachments here. A connection can close after the
        // server accepted turn/start but before its response reached us; in
        // that ambiguous case deletion would break durable conversation
        // history. Keeping the pending attachment also makes the Composer's
        // advertised retry behavior real; explicit removal cleans it up.
        throw err; // propagate so the Composer knows the send failed
      }
    },

    async interruptTurn() {
      const runtime = runtimeVersion;
      const threadId = get().activeThreadId;
      if (!threadId) return;
      const activityVersion = activityVersions.get(threadId) ?? 0;
      // A pending approval blocks the turn server-side — decline it first or
      // the turn survives the interrupt request.
      for (const a of get().approvals) {
        const owner = a.params.threadId;
        if (!owner || owner === threadId) {
          get().decideApproval(a.requestId, "decline");
        }
      }
      // activeTurnId may be unknown (refresh mid-turn / missed turn/started);
      // the gateway falls back to its own tracked id — send regardless.
      const turnId = get().activeTurnId[threadId] ?? undefined;
      // Optimistic: the button must flip back immediately; turn/completed
      // confirms, and a missed terminal notification can no longer wedge it.
      set((s) => ({
        turnActive: { ...s.turnActive, [threadId]: false },
        activeTurnId: { ...s.activeTurnId, [threadId]: null },
      }));
      await gateway.rpc("turn/interrupt", { threadId, turnId }).catch((err: any) => {
        if (runtime !== runtimeVersion || activityVersion !== (activityVersions.get(threadId) ?? 0)) return;
        appendToThread(threadId, makeErrorItem(`停止失败: ${err.message}`));
        // Turn might actually still be running — restore the button state.
        set((s) => ({ turnActive: { ...s.turnActive, [threadId]: true } }));
      });
    },

    async renameThread(threadId, name) {
      name = name.trim().slice(0, 200);
      if (!name) return;
      try {
        await gateway.rpc("thread/name/set", { threadId, name });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`重命名失败: ${err.message}`));
        return;
      }
      set((s) => ({
        sessions: s.sessions.map((x) => (x.threadId === threadId ? { ...x, title: name } : x)),
      }));
      const local = localSessions.get(threadId);
      if (local) local.session = { ...local.session, title: name };
    },

    async archiveThread(threadId) {
      try {
        await gateway.rpc("thread/archive", { threadId });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`归档失败: ${err.message}`));
        return;
      }
      forgetThread(threadId);
    },

    async deleteThread(threadId) {
      try {
        await gateway.rpc("thread/delete", { threadId });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`删除失败: ${err.message}`));
        return;
      }
      forgetThread(threadId, true);
    },

    respondInputRequest(requestId, payload) {
      const request = get().inputRequests.find((entry) => entry.requestId === requestId);
      if (!request || submittedInputs.has(requestId) || !payload || typeof payload !== "object") return false;
      if (validateResponse(request, payload).error) return false;
      if (!gateway.respondServerRequest(requestId, payload)) return false;
      submittedInputs.add(requestId);
      set((state) => {
        const inputRequestErrors = { ...state.inputRequestErrors }; delete inputRequestErrors[String(requestId)];
        return { inputRequestErrors };
      });
      return true;
    },

    decideApproval(requestId, decision) {
      const approval = get().approvals.find((a) => a.requestId === requestId);
      if (!approval) return;
      if (approval.method === "item/permissions/requestApproval" && decision !== "decline" && !describePermissions(approval.params.permissions).valid) return;
      set((s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }));
      // Each approval method expects its OWN response shape — a wrong shape
      // is a protocol error that kills the turn.
      let payload: PermissionsRequestApprovalResponse | CommandExecutionRequestApprovalResponse;
      if (approval.method === "item/permissions/requestApproval") {
        if (decision === "decline") {
          // GrantedPermissionProfile with nothing granted = denial.
          payload = { permissions: {}, scope: "turn" };
        } else {
          // Grant exactly what was requested; scope follows the button.
          const req = approval.params.permissions;
          payload = {
            permissions: {
              ...(req.network != null ? { network: req.network } : {}),
              ...(req.fileSystem != null ? { fileSystem: req.fileSystem } : {}),
            },
            scope: decision === "acceptForSession" ? "session" : "turn",
          };
        }
      } else {
        payload = { decision };
      }
      gateway.respondServerRequest(requestId, payload);
    },

    async compactThread() {
      const runtime = runtimeVersion;
      const threadId = get().activeThreadId;
      if (!threadId || get().compacting[threadId] || get().turnActive[threadId]) return;
      set((s) => ({ compacting: { ...s.compacting, [threadId]: true } }));
      try {
        await gateway.rpc("thread/compact/start", { threadId });
      } catch (err: any) {
        if (runtime !== runtimeVersion) return;
        set((s) => ({ compacting: { ...s.compacting, [threadId]: false } }));
        appendToThread(threadId, makeErrorItem(`上下文压缩失败: ${err.message}`));
      }
    },

    async startDeviceLogin() {
      const runtime = runtimeVersion;
      set({ deviceLogin: { status: "waiting" } });
      try {
        const res = await gateway.request("account/login/start", { type: "chatgptDeviceCode" });
        if (runtime !== runtimeVersion) return;
        if (res.type !== "chatgptDeviceCode") throw new Error("服务器未返回设备码登录信息");
        set({
          deviceLogin: {
            status: "waiting",
            userCode: boundedString(res?.userCode, 128) || undefined,
            verificationUrl: boundedString(res?.verificationUrl, 2_048) || undefined,
          },
        });
      } catch (err: any) {
        if (runtime !== runtimeVersion) return;
        set({ deviceLogin: { status: "error", error: boundedString(err?.message, 1_000) || "登录失败" } });
      }
    },

    setDrawerTab(tab) {
      set({ drawerTab: tab });
    },

    setSidebarOpen(open) {
      set({ sidebarOpen: open });
    },
  };
});
