import { create } from "zustand";
import { gateway, type ServerRequestMsg } from "./api/ws";

/**
 * Times are normalized app-server payloads (see protocol/ generated types,
 * codex 0.149.0): items by thread, pending approvals, aggregated turn diff,
 * the per-project session list, and browser-local settings.
 */

export interface TimelineItem {
  id: string;
  type: string;
  [key: string]: any;
}

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
  selectedSandbox: "" | "network" | "full";
  /** Per-turn reasoning effort (custom provider only; "" = catalog default). */
  selectedEffort: "";
}

export interface PendingServerRequest {
  requestId: number | string;
  method: string;
  params: any;
}

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

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
    return localStorage.getItem(PROJECT_KEY) ?? "";
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

interface AppStore {
  connection: "connecting" | "open" | "closed";
  codexState: string;
  gatewayVersion: string;
  workspaceRoot: string;
  /** Active provider preset (exclusive) — "custom" enables the effort selector. */
  providerMode: "openai" | "zhipu" | "custom";
  /** Effort options probed from the custom endpoint (empty = hide selector). */
  reasoningEfforts: string[];
  account: { account: any | null; requiresOpenaiAuth: boolean } | null;
  projects: ProjectEntry[];
  currentProject: string;
  models: Array<{ id: string; displayName?: string }>;
  mcpServers: Array<{ name: string; status?: any }>;
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
  newThread(): Promise<void>;
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
function flattenTurns(thread: any): TimelineItem[] {
  const turns: any[] = thread?.turns ?? [];
  return turns.flatMap((t) => t?.items ?? []);
}

function makeErrorItem(message: string, willRetry = false): TimelineItem {
  return {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: "errorItem",
    message,
    willRetry,
  };
}

function userTextOf(item: TimelineItem): string {
  if (typeof item.text === "string") return item.text;
  return (item.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
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
  const DELTA_METHODS = new Set([
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta",
  ]);
  let deltaBuffer: Array<{ method: string; params: any }> = [];
  let deltaFlushTimer: number | null = null;

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
      for (const { method, params } of batch) {
        const list = nextItems[params.threadId];
        if (!list) continue; // thread not loaded — nothing to patch
        nextItems[params.threadId] = patchItem(list, params.itemId, (it) => {
          switch (method) {
            case "item/agentMessage/delta":
              return { ...it, text: (it.text ?? "") + (params.delta ?? "") };
            case "item/reasoning/textDelta": {
              const content: string[] = [...(it.content ?? [])];
              const idx = typeof params.contentIndex === "number" ? params.contentIndex : 0;
              while (content.length <= idx) content.push("");
              content[idx] = (content[idx] ?? "") + (params.delta ?? "");
              return { ...it, content, streaming: true };
            }
            case "item/reasoning/summaryTextDelta": {
              const summary: string[] = [...(it.summary ?? [])];
              const idx = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
              while (summary.length <= idx) summary.push("");
              summary[idx] = (summary[idx] ?? "") + (params.delta ?? "");
              return { ...it, summary, streaming: true };
            }
            default: {
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

  function applyNotification(method: string, params: any): void {
    if (DELTA_METHODS.has(method)) {
      deltaBuffer.push({ method, params });
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
    switch (method) {
      case "item/started":
      case "item/completed": {
        if (!params?.item?.id || !params?.threadId) return;
        // upsertItem merges, so explicitly drop the local streaming marker —
        // otherwise a completed reasoning item keeps "思考中…" forever.
        const item: TimelineItem = { ...params.item, threadId: params.threadId, streaming: false };
        set((s) => {
          let items = s.items[params.threadId] ?? [];
          // The server echoes the user message we already inserted optimistically.
          // The echo's text may carry appended attachment notes, so a prefix
          // match is used; dropping the local echo also frees its previews.
          if (item.type === "userMessage") {
            const text = userTextOf(item);
            for (const it of items) {
              if (it.local && it.type === "userMessage" && typeof it.text === "string" && (it.text === text || text.startsWith(it.text))) {
                for (const att of it.attachments ?? []) {
                  if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
                }
              }
            }
            items = items.filter(
              (it) =>
                !(
                  it.local &&
                  it.type === "userMessage" &&
                  typeof it.text === "string" &&
                  (it.text === text || text.startsWith(it.text))
                ),
            );
          }
          return { items: { ...s.items, [params.threadId]: upsertItem(items, item) } };
        });
        return;
      }
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/commandExecution/outputDelta":
        // handled by the delta batcher above
        return;
      case "turn/started": {
        set((s) => ({
          turnActive: { ...s.turnActive, [params.threadId]: true },
          activeTurnId: { ...s.activeTurnId, [params.threadId]: params.turn?.id ?? null },
        }));
        return;
      }
      case "turn/completed": {
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
        set((s) => ({
          tokenUsage: {
            ...s.tokenUsage,
            [params.threadId]: { total: u.last?.totalTokens ?? 0, window: u.modelContextWindow ?? null },
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
          type: "contextCompaction",
          threadId: params.threadId,
          auto: true,
          message: `上下文占用 ${pct}%（达到舒适阈值），正在自动压缩…`,
        });
        return;
      }
      case "thread/autoCompactFailed": {
        if (!params?.threadId) return;
        set((s) => ({ compacting: { ...s.compacting, [params.threadId]: false } }));
        appendToThread(params.threadId, makeErrorItem(`自动压缩失败: ${params.error ?? "unknown"}`));
        return;
      }
      case "thread/compacted": {
        set((s) => ({ compacting: { ...s.compacting, [params.threadId]: false } }));
        scheduleSessionsRefresh();
        return;
      }
      case "thread/unarchived": {
        // Multi-tab sync: remove from the archived list if we're viewing it;
        // otherwise refresh so the restored thread reappears in the list.
        if (!params?.threadId) return;
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
        set((s) => ({
          compacting: { ...s.compacting, [params.threadId]: false },
          turnActive: { ...s.turnActive, [params.threadId]: false },
        }));
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
        if (gone) set((s) => ({ sessions: s.sessions.filter((x) => x.threadId !== gone) }));
        scheduleSessionsRefresh();
        return;
      }
      case "account/updated":
      case "account/login/completed": {
        // The notification carries success/error — surface failures instead
        // of silently clearing the waiting state.
        if (params?.success === false) {
          set({ deviceLogin: { status: "error", error: params?.error ?? "登录失败" } });
          return;
        }
        void gateway.rpc("account/read").then((account) => set({ account })).catch(() => {});
        if (get().deviceLogin?.status === "waiting") set({ deviceLogin: null });
        return;
      }
      case "appServer/stateChanged": {
        set({ codexState: params?.state ?? "unknown" });
        // App-server restart kills all its terminal sessions and may change
        // model/account state. Force a full refresh + clear caches when it
        // comes back to ready, even if our WebSocket never dropped.
        if (params?.state === "ready" && get().connection === "open") {
          set((s) => {
            const cleared: Record<string, boolean> = {};
            for (const tid of Object.keys(s.turnActive)) cleared[tid] = false;
            return { turnActive: cleared, items: {} };
          });
          void get().refresh();
        }
        return;
      }
      case "displayPrefs/updated": {
        // Broadcast from the gateway when ANY browser changes display prefs.
        if (params) set({ display: { ...get().display, ...params } });
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
        console.warn("[codex config]", params?.message ?? params);
        return;
      }
      case "thread/status/changed": {
        // Update the session's turn activity hint if we have the thread.
        if (params?.threadId && params?.status === "idle") {
          set((s) => ({
            turnActive: { ...s.turnActive, [params.threadId]: false },
          }));
        }
        return;
      }
      case "thread/queue/changed": {
        // Queue depth changed — informational for now; log at debug level.
        if (params?.threadId && params?.queued === 0) {
          set((s) => ({ turnActive: { ...s.turnActive, [params.threadId]: false } }));
        }
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
    if (msg.method.includes("requestApproval")) {
      set((s) => ({
        approvals: [
          ...s.approvals.filter((a) => a.requestId !== msg.requestId),
          { requestId: msg.requestId, method: msg.method, params: msg.params ?? {} },
        ],
      }));
      return;
    }
    if (msg.method.includes("requestUserInput") || msg.method.includes("elicitation/request")) {
      const tid = (msg.params as any)?.threadId as string | undefined;
      const isElicitation = msg.method.includes("elicitation/request");
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
      applyTheme(get().settings.theme);
      window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
        if (get().settings.theme === "system") applyTheme("system");
      });
      let everConnected = false;
      gateway.onStateChange((state) => {
        set({ connection: state });
        if (state !== "open") return;
        if (everConnected) {
          // A real DROP-then-reconnect: the gateway or app-server may have
          // restarted server-side. Cached items are potentially stale, and a
          // fresh app-server doesn't know our threads — sending would fail
          // with "thread not found". Clear everything and re-resume below.
          set((s) => {
            const cleared: Record<string, boolean> = {};
            for (const tid of Object.keys(s.turnActive)) cleared[tid] = false;
            return { turnActive: cleared, items: {} };
          });
        }
        everConnected = true;
        void get()
          .refresh()
          .then(() => {
            // Re-resume the active thread so the app-server knows it — this
            // is what keeps "send" working right after a service restart.
            const active = get().activeThreadId;
            if (active) void get().openThread(active).catch(() => {});
          })
          .catch(() => {});
      });
      gateway.onNotification(applyNotification);
      gateway.setServerRequestHandler(handleServerRequest);
      gateway.connect();

      // Restore ?threadId= from the URL after the first project/session load.
      // The socket is still CONNECTING here, and rpc() rejects until it is
      // open — wait for the first "open" or the restore always fails.
      const initial = new URLSearchParams(location.search).get("threadId");
      if (initial) {
        set({ activeThreadId: initial });
        initialThreadSelected = true;
        const doResume = () => {
          void get().openThread(initial).catch(() => {
            set({ activeThreadId: null });
            syncUrl(null); // don't leave a stale ?threadId= in the address bar
          });
        };
        if (gateway.state === "open") doResume();
        else {
          const off = gateway.onStateChange((state) => {
            if (state !== "open") return;
            off();
            doResume();
          });
        }
      }
    },

    async refresh() {
      try {
        const status = await gateway.rpc<any>("app/status");
        set({
          gatewayVersion: status.gatewayVersion ?? "",
          codexState: status.codexState ?? "unknown",
          workspaceRoot: status.workspaceRoot ?? "",
          providerMode: status.providerMode ?? "openai",
          reasoningEfforts: Array.isArray(status.reasoningEfforts) ? status.reasoningEfforts : [],
          display: typeof status.autoCompactThreshold === "number"
            ? { ...get().display, autoCompactThreshold: status.autoCompactThreshold }
            : get().display,
        });
        await Promise.all([
          gateway.rpc("account/read").then((account) => set({ account })).catch(() => {}),
          gateway
            .rpc<Partial<Display>>("displayPrefs/get")
            .then((prefs) => {
              if (prefs) set({ display: { ...get().display, ...prefs } });
            })
            .catch(() => {}),
          get().refreshProjects(),
          get().refreshModels(),
          get().refreshMcp(),
        ]);
        await get().refreshSessions();
        // Re-opening the active thread after a reconnect is handled by the
        // connection watcher in bootstrap() (it re-resumes server-side too).
        // #4: entering the WebUI lands in the most recent session, not a
        // blank new-conversation screen (only on the first successful load).
        if (!initialThreadSelected && !get().activeThreadId) {
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
      // Reset BOTH loading flags — a pending loadMore from a previous query
      // context might have set loadingMore and its stale return won't clear it.
      set({ sessionLoading: true, sessionLoadingMore: false });
      try {
        const params: Record<string, unknown> = { limit: 50 };
        if (get().currentProject) params.cwd = get().currentProject;
        if (get().sessionArchived) params.archived = true;
        if (get().sessionSearch.trim()) params.searchTerm = get().sessionSearch.trim();
        const res = await gateway.rpc<any>("thread/list", params);
        if (seq !== sessionRequestSeq) return; // stale response — a newer query superseded us
        const threads: any[] = res?.data ?? [];
        let sessions: SessionInfo[] = threads
          .map((t) => ({
            threadId: t.id,
            title: t.name || t.preview || "（无标题会话）",
            updatedAt: t.updatedAt ?? 0,
          }))
          .filter((s) => s.threadId);
        // The server's thread list lags behind rollout indexing; keep entries
        // we registered locally within the last 5 minutes — but only when
        // we're on the "current" tab with no search filter.
        if (!get().sessionArchived && !get().sessionSearch.trim()) {
          const known = new Set(sessions.map((s) => s.threadId));
          const nowSec = Math.floor(Date.now() / 1000);
          const freshLocals = get().sessions.filter(
            (s) => !known.has(s.threadId) && nowSec - s.updatedAt < 300,
          );
          if (freshLocals.length > 0) sessions = [...sessions, ...freshLocals];
        }
        // Server already sorts by updated_at desc (gateway sets sortKey), so
        // we preserve cursor order — no client-side re-sort on paginated data.
        // Merge strategy: a refresh replaces the first page but must not
        // collapse pages the user already loaded via "加载更多" (a background
        // turn/completed would otherwise fold the list back to page 1). Items
        // from the old tail that the fresh page no longer lists are kept
        // below the fold; explicit archived/deleted handling removes them.
        const prev = get().sessions;
        if (prev.length > sessions.length) {
          const known = new Set(sessions.map((s) => s.threadId));
          const tail = prev.filter((s) => !known.has(s.threadId));
          if (tail.length > 0) sessions = [...sessions, ...tail];
        }
        set({ sessions, sessionCursor: res?.nextCursor ?? null, sessionLoading: false });
      } catch {
        if (seq === sessionRequestSeq) set({ sessionLoading: false });
      }
    },

    async loadMoreSessions() {
      const cursor = get().sessionCursor;
      if (!cursor || get().sessionLoadingMore || get().sessionLoading) return;
      const seq = ++sessionRequestSeq;
      set({ sessionLoadingMore: true });
      try {
        const params: Record<string, unknown> = { limit: 50, cursor };
        if (get().currentProject) params.cwd = get().currentProject;
        if (get().sessionArchived) params.archived = true;
        if (get().sessionSearch.trim()) params.searchTerm = get().sessionSearch.trim();
        const res = await gateway.rpc<any>("thread/list", params);
        if (seq !== sessionRequestSeq) return;
        const newThreads: SessionInfo[] = (res?.data ?? [])
          .map((t: any) => ({
            threadId: t.id,
            title: t.name || t.preview || "（无标题会话）",
            updatedAt: t.updatedAt ?? 0,
          }))
          .filter((s: SessionInfo) => s.threadId);
        // Append + dedupe: existing ids updated in place, new ids appended.
        // Preserve the server's cursor ordering — no global re-sort.
        const byId = new Map(get().sessions.map((s) => [s.threadId, s]));
        for (const s of newThreads) byId.set(s.threadId, s);
        set({
          sessions: [...byId.values()],
          sessionCursor: res?.nextCursor ?? null,
          sessionLoadingMore: false,
        });
      } catch {
        if (seq === sessionRequestSeq) set({ sessionLoadingMore: false });
      }
    },

    setSessionSearch(term: string) {
      set({ sessionSearch: term, sessions: [], sessionCursor: null });
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
      try {
        const res = await gateway.rpc<any>("projects/list");
        const projects: ProjectEntry[] = res?.projects ?? [];
        let current = get().currentProject;
        if (!current || !projects.some((p) => p.path === current)) {
          current = projects[0]?.path ?? "";
        }
        try {
          localStorage.setItem(PROJECT_KEY, current);
        } catch {
          /* ignore */
        }
        set({ projects, currentProject: current });
      } catch {
        /* keep previous */
      }
    },

    async refreshModels() {
      // Loop-paginate model/list until exhausted (most providers return a
      // single page, but large catalogs need multiple requests).
      const generation = ++modelRequestSeq;
      try {
        const all: Array<{ id: string; displayName?: string }> = [];
        let cursor: string | null = null;
        let lastCursor: string | null = null;
        const MAX_PAGES = 100; // 100 × 100 = 10k models; guard against a
        // server that keeps returning cursors (loop protection), not a real
        // catalog limit. A warning marks the (unreachable in practice) case.
        for (let page = 0; page < MAX_PAGES; page++) {
          const params: Record<string, unknown> = { limit: 100 };
          if (cursor) params.cursor = cursor;
          const res: any = await gateway.rpc("model/list", params);
          if (generation !== modelRequestSeq) return; // provider switched — drop stale data
          for (const m of res?.data ?? []) {
            all.push({ id: m.id, displayName: m.displayName ?? m.id });
          }
          cursor = res?.nextCursor ?? null;
          if (!cursor || cursor === lastCursor) break;
          lastCursor = cursor;
        }
        if (cursor) console.warn(`[webui] model catalog truncated at ${MAX_PAGES} pages`);
        if (generation === modelRequestSeq) {
          set({ models: all });
          modelsLoadedFor = get().providerMode;
        }
      } catch {
        if (generation === modelRequestSeq) {
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
      try {
        const res = await gateway.rpc<any>("mcpServerStatus/list");
        set({ mcpServers: res?.data ?? [] });
      } catch {
        /* MCP status is a nicety */
      }
    },

    async addProject(path, create) {
      await gateway.rpc("projects/add", { path, create });
      await get().refreshProjects();
    },

    async removeProject(path) {
      await gateway.rpc("projects/remove", { path });
      await get().refreshProjects();
    },

    async selectProject(path) {
      if (!path || path === get().currentProject) return;
      try {
        localStorage.setItem(PROJECT_KEY, path);
      } catch {
        /* ignore */
      }
      set({ currentProject: path, activeThreadId: null, items: {}, sessions: [], sessionCursor: null });
      syncUrl(null);
      void gateway.rpc("projects/touch", { path }).catch(() => {});
      await get().refreshProjects();
      await get().refreshSessions();
    },

    updateSettings(patch) {
      const settings = { ...get().settings, ...patch };
      saveSettings(settings);
      set({ settings });
      applyTheme(settings.theme);
    },

    updateDisplay(patch) {
      // Optimistic local apply; the gateway persists it for every browser.
      set({ display: { ...get().display, ...patch } });
      void gateway.rpc("displayPrefs/set", patch).catch(() => {});
    },

    uploadAttachment(name, base64, kind) {
      return gateway.rpc<{ path: string; size: number }>("attachment/upload", { name, base64, kind });
    },

    readAttachment(path) {
      return gateway.rpc<{ base64: string; mime: string }>("attachment/read", { path });
    },

    deleteAttachment(path) {
      return gateway.rpc("attachment/delete", { path }).then(() => undefined);
    },

    async openThread(threadId) {
      set({ activeThreadId: threadId, sidebarOpen: false });
      syncUrl(threadId);
      if (get().items[threadId]) return;
      // Full-history load. thread/resume's built-in initial page is
      // summary-viewed and page-capped (old messages went missing), so the
      // DISPLAY history comes from thread/read {includeTurns:true}; resume
      // still runs to activate live notifications for the thread.
      const loadHistory = async (): Promise<TimelineItem[]> => {
        const read = await gateway.rpc<any>("thread/read", { threadId, includeTurns: true });
        let items = flattenTurns(read?.thread).map((it) => ({ ...it, threadId }));
        if (items.length === 0) {
          // Older app-server or read quirks — fall back to resume's turns.
          const res = await gateway.rpc<any>("thread/resume", { threadId });
          items = flattenTurns(res?.thread).map((it) => ({ ...it, threadId }));
        } else {
          // Activation (idempotent when already resumed).
          void gateway.rpc("thread/resume", { threadId }).catch(() => {});
        }
        return items;
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const items = await loadHistory();
          // Only cache when this thread is still the one the user wants —
          // a fast thread switch must not be overwritten by a slow response.
          if (get().activeThreadId === threadId) {
            set((s) => ({ items: { ...s.items, [threadId]: items } }));
          }
          return;
        } catch (err: any) {
          if (attempt === 2) {
            // Never swallow a failed history load silently — that showed up
            // as "refresh loses all messages". Surface it and retry on click.
            appendToThread(threadId, makeErrorItem(`会话历史加载失败: ${err.message}（切换会话后重进可重试）`));
            return;
          }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    },

    async newThread() {
      const { currentProject, settings } = get();
      const params: Record<string, unknown> = {};
      if (currentProject) params.cwd = currentProject;
      // Same guard as sendTurn: a localStorage model left over from another
      // provider mode could 400 thread/start when the new provider's catalog
      // hasn't loaded — only send selections valid for the CURRENT provider.
      const models = get().models;
      if (settings.selectedModel && models.some((m) => m.id === settings.selectedModel)) {
        params.model = settings.selectedModel;
      }
      if (settings.selectedApprovalPolicy) params.approvalPolicy = settings.selectedApprovalPolicy;
      const res = await gateway.rpc<any>("thread/start", params);
      const threadId = res?.thread?.id;
      if (!threadId) {
        // thread/start "succeeded" but returned no id — treat as a hard error
        // so sendMessage's catch block can show it (and the composer text
        // survives because newThread throws BEFORE sendTurn clears it).
        throw new Error(`thread/start returned no thread.id: ${JSON.stringify(res).slice(0, 200)}`);
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
        set((s) => ({
          items: { ...s.items, [threadId]: [] },
          sessions: [local, ...s.sessions.filter((x) => x.threadId !== threadId)],
          sessionArchived: false,
          sessionSearch: "",
          sessionCursor: null,
          sidebarOpen: false,
        }));
        await get().openThread(threadId);
      }
      void get().refreshSessions().catch(() => {});
    },

    /** Composer entry: typing with no session selected starts a new one. */
    async sendMessage(text, attachments) {
      if (!get().activeThreadId) {
        try {
          await get().newThread();
        } catch (err: any) {
          console.error("[webui] failed to create session:", err);
          if (get().activeThreadId) appendToThread(get().activeThreadId!, makeErrorItem(err.message));
          throw err; // propagate so the Composer knows the send failed
        }
      }
      if (!get().activeThreadId) throw new Error("no active session after newThread");
      await get().sendTurn(text, attachments);
    },

    async sendTurn(text, attachments) {
      const threadId = get().activeThreadId;
      if (!threadId) return;
      const atts = attachments ?? [];
      set((s) => ({
        turnActive: { ...s.turnActive, [threadId]: true },
        items: {
          ...s.items,
          [threadId]: [
            ...(s.items[threadId] ?? []),
            { id: `local-${Date.now()}`, type: "userMessage", text, threadId, local: true, attachments: atts },
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
        // All four overrides are STICKY on the app-server side ("this turn and
        // subsequent turns"), so "默认" must send an explicit null reset —
        // omitting the field would silently keep the last override active.
        await gateway.rpc("turn/start", {
          threadId,
          text,
          ...(atts.length ? { attachments: atts.map(({ kind, name, path }) => ({ kind, name, path })) } : {}),
          model: modelOk ? selectedModel : null,
          approvalPolicy: selectedApprovalPolicy || null,
          sandbox: selectedSandbox || null,
          effort: effortOk ? selectedEffort : null,
        });
      } catch (err: any) {
        set((s) => ({ turnActive: { ...s.turnActive, [threadId]: false } }));
        appendToThread(threadId, makeErrorItem(err.message));
        // The turn never started — the server-side attachment files are now
        // orphans. Clean them up so cancelled uploads don't accumulate.
        for (const att of atts) {
          void gateway.rpc("attachment/delete", { path: att.path }).catch(() => {});
        }
        throw err; // propagate so the Composer knows the send failed
      }
    },

    async interruptTurn() {
      const threadId = get().activeThreadId;
      if (!threadId) return;
      // A pending approval blocks the turn server-side — decline it first or
      // the turn survives the interrupt request.
      for (const a of get().approvals) {
        const owner = (a.params as any)?.threadId;
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
        appendToThread(threadId, makeErrorItem(`停止失败: ${err.message}`));
        // Turn might actually still be running — restore the button state.
        set((s) => ({ turnActive: { ...s.turnActive, [threadId]: true } }));
      });
    },

    async renameThread(threadId, name) {
      try {
        await gateway.rpc("thread/name/set", { threadId, name });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`重命名失败: ${err.message}`));
        return;
      }
      set((s) => ({
        sessions: s.sessions.map((x) => (x.threadId === threadId ? { ...x, title: name } : x)),
      }));
    },

    async archiveThread(threadId) {
      try {
        await gateway.rpc("thread/archive", { threadId });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`归档失败: ${err.message}`));
        return;
      }
      set((s) => ({
        sessions: s.sessions.filter((x) => x.threadId !== threadId),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      }));
      if (!get().activeThreadId) syncUrl(null);
    },

    async deleteThread(threadId) {
      try {
        await gateway.rpc("thread/delete", { threadId });
      } catch (err: any) {
        appendToThread(threadId, makeErrorItem(`删除失败: ${err.message}`));
        return;
      }
      set((s) => ({
        sessions: s.sessions.filter((x) => x.threadId !== threadId),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
      }));
      if (!get().activeThreadId) syncUrl(null);
    },

    decideApproval(requestId, decision) {
      const approval = get().approvals.find((a) => a.requestId === requestId);
      set((s) => ({ approvals: s.approvals.filter((a) => a.requestId !== requestId) }));
      // Each approval method expects its OWN response shape — a wrong shape
      // is a protocol error that kills the turn.
      let payload: unknown;
      if (approval?.method.includes("permissions")) {
        if (decision === "decline") {
          // GrantedPermissionProfile with nothing granted = denial.
          payload = { permissions: {}, scope: "turn" };
        } else {
          // Grant exactly what was requested; scope follows the button.
          const req = (approval.params as any)?.permissions ?? {};
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
      const threadId = get().activeThreadId;
      if (!threadId || get().compacting[threadId] || get().turnActive[threadId]) return;
      set((s) => ({ compacting: { ...s.compacting, [threadId]: true } }));
      try {
        await gateway.rpc("thread/compact/start", { threadId });
      } catch (err: any) {
        set((s) => ({ compacting: { ...s.compacting, [threadId]: false } }));
        appendToThread(threadId, makeErrorItem(`上下文压缩失败: ${err.message}`));
      }
    },

    async startDeviceLogin() {
      set({ deviceLogin: { status: "waiting" } });
      try {
        const res = await gateway.rpc<any>("account/login/start", { type: "chatgptDeviceCode" });
        set({
          deviceLogin: {
            status: "waiting",
            userCode: res?.userCode,
            verificationUrl: res?.verificationUrl,
          },
        });
      } catch (err: any) {
        set({ deviceLogin: { status: "error", error: err.message } });
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
