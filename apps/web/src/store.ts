import { create } from "zustand";
import { gateway, type ServerRequestMsg } from "./api/ws";
import { type ApprovalRequest, type GatewayNotification, type TimelineItem } from "./api/protocol";
import type { Thread } from "../../../protocol/v2/Thread";
import type { ThreadItem } from "../../../protocol/v2/ThreadItem";
import type { ThreadListParams } from "../../../protocol/v2/ThreadListParams";
import type { ThreadListResponse } from "../../../protocol/v2/ThreadListResponse";
import type { ThreadStartParams } from "../../../protocol/v2/ThreadStartParams";
import type { GetAccountResponse } from "../../../protocol/v2/GetAccountResponse";
import type { McpServerStatus } from "../../../protocol/v2/McpServerStatus";
import type { PermissionsRequestApprovalResponse } from "../../../protocol/v2/PermissionsRequestApprovalResponse";
import type { CommandExecutionRequestApprovalResponse } from "../../../protocol/v2/CommandExecutionRequestApprovalResponse";
import { describePermissions } from "./utils/permissions";
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
}

export type ApprovalPolicy = "" | "untrusted" | "on-request" | "never";
export type SandboxPreset = "" | "network" | "full";
export type ReasoningEffort = "" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
const REASONING_EFFORTS = new Set<ReasoningEffort>(["", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
  const effort = REASONING_EFFORTS.has(source.selectedEffort as ReasoningEffort)
    ? source.selectedEffort as ReasoningEffort
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
        typeof entry === "string" && entry !== "" && REASONING_EFFORTS.has(entry as ReasoningEffort),
    ),
  )].slice(0, REASONING_EFFORTS.size - 1);
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

interface AppStore {
  connection: "connecting" | "open" | "closed";
  codexState: string;
  gatewayVersion: string;
  workspaceRoot: string;
  /** Active provider preset (exclusive) — "custom" enables the effort selector. */
  providerMode: ProviderMode;
  /** Effort options probed from the custom endpoint (empty = hide selector). */
  reasoningEfforts: Array<Exclude<ReasoningEffort, "">>;
  account: GetAccountResponse | null;
  projects: ProjectEntry[];
  currentProject: string;
  models: Array<{ id: string; displayName?: string }>;
  mcpServers: McpServerStatus[];
  settings: Settings;
  display: Display;
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
  deviceLogin: DeviceLogin | null;
  drawerTab: "diff" | "terminal" | null;
  sidebarOpen: boolean;

  bootstrap(): void;
  refresh(): Promise<void>;
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
  uploadAttachment(name: string, base64: string, kind?: "image" | "file"): Promise<{ path: string; size: number }>;
  readAttachment(path: string): Promise<{ base64: string; mime: string }>;
  deleteAttachment(path: string): Promise<void>;
  openThread(threadId: string): Promise<void>;
  newThread(): Promise<string | null>;
  sendMessage(text: string, attachments?: Array<{ kind: "image" | "file"; name: string; path: string; previewUrl?: string }>): Promise<void>;
  sendTurn(text: string, attachments?: Array<{ kind: "image" | "file"; name: string; path: string }>): Promise<void>;
  interruptTurn(): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  decideApproval(requestId: number | string, decision: "accept" | "acceptForSession" | "decline"): void;
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

/** Preserve events received during a history read. Text snapshots can already
 * contain a prefix of the live stream, so never concatenate them blindly. */
function mergeStreamText(snapshot: string, live: string): string {
  if (snapshot.includes(live)) return snapshot;
  if (live.includes(snapshot)) return live;
  // KMP suffix/prefix overlap keeps long tool output merges linear.
  const prefix = new Uint32Array(live.length);
  for (let i = 1, matched = 0; i < live.length; i++) {
    while (matched && live[i] !== live[matched]) matched = prefix[matched - 1];
    if (live[i] === live[matched]) matched++;
    prefix[i] = matched;
  }
  let overlap = 0;
  const tail = snapshot.slice(-live.length);
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i];
    while (overlap && char !== live[overlap]) overlap = prefix[overlap - 1];
    if (char === live[overlap]) overlap++;
  }
  return snapshot + live.slice(overlap);
}

function mergeHistory(snapshot: TimelineItem[], live: TimelineItem[], baseline: TimelineItem[]): TimelineItem[] {
  const before = new Map(baseline.map((item) => [item.id, item]));
  const result = new Map(snapshot.map((item) => [item.id, item]));
  for (const item of live) {
    const saved = result.get(item.id);
    if (!saved) { result.set(item.id, item); continue; }
    if (before.get(item.id) === item) continue;
    if (!item.completed && (item.type === "agentMessage" || item.type === "plan") && saved.type === item.type) {
      result.set(item.id, { ...item, text: mergeStreamText(saved.text, item.text) });
    } else if (!item.completed && item.type === "commandExecution" && saved.type === "commandExecution") {
      result.set(item.id, { ...item, aggregatedOutput: mergeStreamText(saved.aggregatedOutput ?? "", item.aggregatedOutput ?? "") });
    } else if (!item.completed && item.type === "reasoning" && saved.type === "reasoning") {
      const mergeParts = (savedParts: string[], liveParts: string[]) => Array.from({ length: Math.max(savedParts.length, liveParts.length) }, (_, index) => mergeStreamText(savedParts[index] ?? "", liveParts[index] ?? ""));
      result.set(item.id, { ...item, content: mergeParts(saved.content, item.content), summary: mergeParts(saved.summary, item.summary) });
    } else result.set(item.id, item);
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

function userTextOf(item: Extract<ThreadItem, { type: "userMessage" }>): string {
  return item.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
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

export const useStore = create<AppStore>((set, get) => {
  let sessionsRefreshTimer: number | null = null;
  let bootstrapped = false;
  let runtimeVersion = 0;
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
    }));
    if (!get().activeThreadId) syncUrl(null);
  }

  function clearRuntimeState() {
    runtimeVersion += 1;
    invalidateAsyncWork();
    activityVersions.clear();
    set({
      items: {}, historyLoaded: {}, historyLoading: {}, turnActive: {}, activeTurnId: {},
      compacting: {}, plan: {}, turnDiff: {}, tokenUsage: {}, approvals: [], deviceLogin: null,
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
  const pendingHistoryDeltas = new Map<string, Delta[]>();

  function mergePendingDeltas(items: TimelineItem[], pending: Delta[]): TimelineItem[] {
    const suffixes = new Map<string, { sample: Delta; text: string }>();
    for (const delta of pending) {
      const index = delta.method === "item/reasoning/textDelta" ? delta.params.contentIndex :
        delta.method === "item/reasoning/summaryTextDelta" ? delta.params.summaryIndex : 0;
      const key = `${delta.params.itemId}:${delta.method}:${index}`;
      const previous = suffixes.get(key);
      suffixes.set(key, { sample: delta, text: (previous?.text ?? "") + delta.params.delta });
    }
    let result = items;
    for (const { sample, text } of suffixes.values()) {
      result = patchItem(result, sample.params.itemId, (item) => {
        switch (sample.method) {
          case "item/agentMessage/delta": case "item/plan/delta":
            return item.type === "agentMessage" || item.type === "plan" ? { ...item, text: mergeStreamText(item.text, text) } : item;
          case "item/commandExecution/outputDelta":
            return item.type === "commandExecution" ? { ...item, aggregatedOutput: mergeStreamText(item.aggregatedOutput ?? "", text) } : item;
          case "item/reasoning/textDelta": {
            if (item.type !== "reasoning") return item;
            const content = [...item.content]; const index = sample.params.contentIndex;
            content[index] = mergeStreamText(content[index] ?? "", text);
            return { ...item, content };
          }
          case "item/reasoning/summaryTextDelta": {
            if (item.type !== "reasoning") return item;
            const summary = [...item.summary]; const index = sample.params.summaryIndex;
            summary[index] = mergeStreamText(summary[index] ?? "", text);
            return { ...item, summary };
          }
        }
      });
    }
    return result;
  }
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
    pendingHistoryDeltas.clear();
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
    set((s) => {
      const nextItems = { ...s.items };
      for (const delta of batch) {
        const { method, params } = delta;
        const list = nextItems[params.threadId];
        if (!list?.some((item) => item.id === params.itemId)) {
          if (s.historyLoading[params.threadId]) {
            const pending = pendingHistoryDeltas.get(params.threadId) ?? [];
            pending.push(delta);
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
      deltaBuffer.push(event);
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
      case "item/started":
      case "item/completed": {
        if (!params?.item?.id || !params?.threadId) return;
        // upsertItem merges, so explicitly drop the local streaming marker —
        // otherwise a completed reasoning item keeps "思考中…" forever.
        const item: TimelineItem = { ...params.item, threadId: params.threadId, streaming: false, completed: method === "item/completed" };
        set((s) => {
          let items = s.items[params.threadId] ?? [];
          // The server echoes the user message we already inserted optimistically.
          // The echo's text may carry appended attachment notes, so a prefix
          // match is used; dropping the local echo also frees its previews.
          if (item.type === "userMessage") {
            const text = userTextOf(item);
            for (const it of items) {
              if (it.type === "localUserMessage" && (it.text === text || text.startsWith(it.text))) {
                for (const att of it.attachments ?? []) {
                  if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
                }
              }
            }
            items = items.filter(
              (it) =>
                !(
                  it.type === "localUserMessage" &&
                  typeof it.text === "string" &&
                  (it.text === text || text.startsWith(it.text))
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
        set((s) => ({ approvals: s.approvals.filter((a) => a.requestId !== rid) }));
        return;
      }
      default:
        return;
    }
  }

  function handleServerRequest(msg: ServerRequestMsg): void {
    // Approval-type requests get the approval banner UI. Other interactive
    // request types (elicitation forms, tool user input) are surfaced as
    // error items with context — they'd otherwise hang for 10 minutes.
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
      const tid = msg.params.threadId;
      const isElicitation = msg.method === "mcpServer/elicitation/request";
      const desc = isElicitation
        ? "MCP 服务器请求交互确认（此请求类型暂不支持交互界面，已自动拒绝）"
        : "服务器请求用户输入（此请求类型暂不支持交互界面，已自动取消）";
      if (tid) {
        appendToThread(tid, makeErrorItem(desc));
      } else {
        console.warn("[serverRequest]", msg.method);
      }
      // Return protocol-correct refusal shapes — NOT {error:...} which the
      // app-server would treat as a successful (but malformed) response.
      if (isElicitation) {
        gateway.respondServerRequest(msg.requestId, { action: "decline", content: null, _meta: null });
      } else {
        gateway.respondServerRequest(msg.requestId, { answers: {} });
      }
      return;
    }
  }

  return {
  connection: "connecting",
  codexState: "unknown",
  gatewayVersion: "",
  workspaceRoot: "",
  providerMode: "openai",
  reasoningEfforts: [],
  account: null,
    projects: [],
    currentProject: loadCurrentProject(),
    models: [],
    mcpServers: [],
    settings: loadSettings(),
    display: { ...DEFAULT_DISPLAY },
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
            approvals: [],
            deviceLogin: null,
            sessionLoading: false,
            sessionLoadingMore: false,
          });
          return;
        }
        set({ connection: state });
        if (everConnected) {
          // A real DROP-then-reconnect: the gateway or app-server may have
          // restarted server-side. Cached items are potentially stale, and a
          // fresh app-server doesn't know our threads — sending would fail
          // with "thread not found". Clear everything and re-resume below.
          clearRuntimeState();
        }
        everConnected = true;
        void get().refresh();
      });
      gateway.onNotification(applyNotification);
      gateway.setServerRequestHandler(handleServerRequest);
      gateway.connect();

    },

    async refresh() {
      const seq = ++refreshRequestSeq;
      const generation = gateway.generation;
      try {
        const status = await gateway.rpc<any>("app/status");
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        const providerMode = normalizeProviderMode(status?.providerMode);
        const reasoningEfforts = normalizeReasoningEfforts(status?.reasoningEfforts);
        const providerChanged = providerMode !== get().providerMode;
        let settings = get().settings;
        const effortInvalid = !!settings.selectedEffort && !reasoningEfforts.includes(settings.selectedEffort);
        if (providerChanged) {
          // Models and effort catalogs are provider-specific. Reset both the
          // visible catalogs and persisted selections immediately instead of
          // briefly sending/showing a value from the old endpoint.
          modelRequestSeq += 1;
          modelsLoadedFor = null;
        }
        if (providerChanged || effortInvalid) {
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
          reasoningEfforts,
          ...(providerChanged ? { models: [], mcpServers: [], account: null } : {}),
          ...((providerChanged || effortInvalid) ? { settings } : {}),
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
        const all: Array<{ id: string; displayName?: string }> = [];
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
            all.push({ id, displayName: boundedString(m?.displayName, 256) || id });
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
      saveSettings(settings);
      set({ settings });
      applyTheme(settings.theme);
    },

    updateDisplay(patch) {
      // Optimistic local apply; the gateway persists it for every browser.
      const display = normalizeDisplay(patch, get().display);
      set({ display });
      void gateway.rpc("displayPrefs/set", display).catch(() => {});
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
      const baseline = get().items[threadId] ?? [];
      pendingHistoryDeltas.delete(threadId);
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
            if (activationError) items.push({ ...makeErrorItem(`历史已加载，但会话无法激活: ${activationError instanceof Error ? activationError.message : String(activationError)}（重新选择可重试）`, false), threadId, historyLoadError: true });
            const running = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
            const unchanged = activityVersion === (activityVersions.get(threadId) ?? 0);
            const projectChanged = !!thread.cwd && thread.cwd !== get().currentProject;
            set((s) => ({
              items: { ...s.items, [threadId]: mergePendingDeltas(mergeHistory(items, (s.items[threadId] ?? []).filter((item) => item.type !== "errorItem" || !item.historyLoadError), baseline), pendingHistoryDeltas.get(threadId) ?? []) },
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
    async sendMessage(text, attachments) {
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
      await get().sendTurn(text, attachments);
    },

    async sendTurn(text, attachments) {
      const runtime = runtimeVersion;
      const threadId = get().activeThreadId;
      if (!threadId) return;
      if (!get().historyLoaded[threadId]) throw new Error("会话历史尚未完成加载，请稍后重试");
      if (get().turnActive[threadId]) throw new Error("会话正在运行，请等待完成或先停止");
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
            { id: localId, type: "localUserMessage", text, threadId, attachments: atts },
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
        const effortOk = selectedEffort && get().reasoningEfforts.includes(selectedEffort);
        // null selects the gateway's configured defaults. The gateway resolves
        // concrete values because app-server null does not reset sticky values.
        await gateway.request("turn/start", {
          threadId,
          text,
          ...(atts.length ? { attachments: atts.map(({ kind, name, path }) => ({ kind, name, path })) } : {}),
          model: modelOk ? selectedModel : null,
          approvalPolicy: selectedApprovalPolicy || null,
          sandbox: selectedSandbox || null,
          effort: effortOk ? selectedEffort : null,
        });
      } catch (err: any) {
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
        appendToThread(threadId, makeErrorItem(err.message));
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
