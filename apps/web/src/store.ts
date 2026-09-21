import { create } from "zustand";
import { gateway, type ServerRequestMsg } from "./api/ws";
import { type ApprovalRequest, type GatewayNotification, type TimelineItem } from "./api/protocol";
import type { Turn } from "../../../protocol/v2/Turn";
import type { ThreadListParams } from "../../../protocol/v2/ThreadListParams";
import type { ThreadListResponse } from "../../../protocol/v2/ThreadListResponse";
import type { ThreadStartParams } from "../../../protocol/v2/ThreadStartParams";
import type { GetAccountResponse } from "../../../protocol/v2/GetAccountResponse";
import type { PermissionsRequestApprovalResponse } from "../../../protocol/v2/PermissionsRequestApprovalResponse";
import type { CommandExecutionRequestApprovalResponse } from "../../../protocol/v2/CommandExecutionRequestApprovalResponse";
import { approvalCanAccept } from "./utils/permissions";
import { operationId } from "./utils/operation-id";
import { validateResponse, type InputRequest } from "./utils/input-forms";
import { budgetTimeline, deriveTimelineListBudget } from "./utils/timeline-budget";
import { normalizeManagement, type ManagementSnapshot } from "./utils/management";
import { releasePreviewUrl, retainTimelineAttachment } from "./utils/preview-urls";
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

export interface GlobalWarning {
  id: string;
  message: string;
}

export type ApprovalPolicy = "" | "untrusted" | "on-request" | "never";
export type SandboxPreset = "" | "network" | "full";
// The pinned protocol intentionally leaves this extensible. Only a bounded
// identifier advertised by the selected model is admissible for a turn.
export type ReasoningEffort = string;
export type ProviderMode = "openai" | "zhipu" | "custom";
export interface LoadStatus {
  state: "loading" | "loaded" | "error";
  error: string | null;
}

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
  /** Auto-compact trigger threshold: 0 disables it, otherwise 0 < n < 1. */
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
  loginId?: string;
  userCode?: string;
  verificationUrl?: string;
  error?: string;
  canceling?: boolean;
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
const ACCOUNT_PLAN_TYPES = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_prolite", "self_serve_business_usage_based", "business",
  "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise",
  "edu", "edu_plus", "edu_pro", "unknown",
]);

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function loadFailure(label: string, error: unknown): LoadStatus {
  let detail = "未知错误";
  try {
    detail = error instanceof Error ? error.message : String(error);
  } catch {
    /* An exotic thrown value must not break the recovery UI. */
  }
  return { state: "error", error: `${label}：${boundedString(detail, 1_000) || "未知错误"}` };
}

const loadingStatus = (): LoadStatus => ({ state: "loading", error: null });
const loadedStatus = (): LoadStatus => ({ state: "loaded", error: null });

/** Project the untrusted account/read result into the exact generated union.
 * In particular, an arbitrary object is not evidence of a ChatGPT login. */
export function projectAccountResponse(value: unknown): GetAccountResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("服务器返回的账号状态格式无效");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.requiresOpenaiAuth !== "boolean") {
    throw new Error("服务器返回的账号状态格式无效");
  }
  if (source.account === null) {
    return { account: null, requiresOpenaiAuth: source.requiresOpenaiAuth };
  }
  if (!source.account || typeof source.account !== "object" || Array.isArray(source.account)) {
    throw new Error("服务器返回的账号状态格式无效");
  }
  const account = source.account as Record<string, unknown>;
  if (account.type === "apiKey") {
    return { account: { type: "apiKey" }, requiresOpenaiAuth: source.requiresOpenaiAuth };
  }
  if (account.type === "chatgpt") {
    if (!(account.email === null || typeof account.email === "string") ||
        typeof account.planType !== "string" || !ACCOUNT_PLAN_TYPES.has(account.planType)) {
      throw new Error("服务器返回的账号状态格式无效");
    }
    return {
      account: {
        type: "chatgpt",
        email: account.email === null ? null : account.email.slice(0, 320),
        planType: account.planType as Extract<NonNullable<GetAccountResponse["account"]>, { type: "chatgpt" }>["planType"],
      },
      requiresOpenaiAuth: source.requiresOpenaiAuth,
    };
  }
  if (account.type === "amazonBedrock" && typeof account.usesCodexManagedCredentials === "boolean") {
    return {
      account: { type: "amazonBedrock", usesCodexManagedCredentials: account.usesCodexManagedCredentials },
      requiresOpenaiAuth: source.requiresOpenaiAuth,
    };
  }
  throw new Error("服务器返回的账号状态格式无效");
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

function normalizeProviderMode(value: unknown, fallback: ProviderMode = "openai"): ProviderMode {
  return value === "openai" || value === "zhipu" || value === "custom" ? value : fallback;
}

function normalizeReasoningEfforts(value: unknown): Exclude<ReasoningEffort, "">[] {
  if (!Array.isArray(value)) return [];
  const result: Exclude<ReasoningEffort, "">[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(value.length, 1_024) && result.length < 128; index++) {
    const entry = value[index];
    if (typeof entry !== "string" || !EFFORT_IDENTIFIER.test(entry) || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  reasoningEfforts?: Exclude<ReasoningEffort, "">[];
  defaultReasoningEffort?: ReasoningEffort;
  isDefault?: boolean;
}

/** Bounded browser view of MCP status. Full schemas/resources are available
 * from the gateway but the settings screen consumes only these fields. */
export interface McpServerView {
  name: string;
  initialized: boolean;
  toolCount: number;
  toolsTruncated?: boolean;
  tools: Array<{ name: string; description?: string }>;
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
export interface ThreadCreateOperation {
  clientOperationId: string;
  cwd: string;
  state: "unknown" | "accepted" | "not_received" | "rejected" | "acknowledged_unknown";
  threadId?: string;
  error?: string;
}
const OPERATIONS_KEY = "codex-harness-pending-operation-v1:";
const THREAD_CREATE_OPERATION_KEY = "codex-harness-thread-create-operation-v1";
interface LoadedSendOperations {
  byThread: Record<string, SendOperation>;
  byId: Record<string, SendOperation>;
  overflow: boolean;
}

const MAX_UNKNOWN_SEND_OPERATIONS = 100;
const MAX_ACKNOWLEDGED_SEND_OPERATIONS = 100;
const MAX_SEND_OPERATION_STORAGE_KEYS = 4_096;
const MAX_AUTOMATIC_SEND_CHECKS = 8;

function selectThreadOperations(byId: Record<string, SendOperation>): Record<string, SendOperation> {
  const byThread: Record<string, SendOperation> = {};
  const priority = (state: SendOperation["state"]) => state === "unknown" ? 3 : state === "acknowledged_unknown" ? 2 : 1;
  let inspected = 0;
  for (const id in byId) {
    if (!Object.prototype.hasOwnProperty.call(byId, id) || ++inspected > 512) break;
    const operation = byId[id];
    const current = byThread[operation.threadId];
    // Equal-priority records have no trustworthy creation order across tabs.
    // Pick deterministically for the compact per-thread control; the full
    // by-ID map remains authoritative and every unresolved ID is displayed.
    if (!current || priority(operation.state) > priority(current.state) ||
        priority(operation.state) === priority(current.state) && operation.clientOperationId < current.clientOperationId) {
      byThread[operation.threadId] = operation;
    }
  }
  return byThread;
}

function mergedSendOperationRecords(state: Pick<AppStore, "sendOperationRecords" | "sendOperations">): Record<string, SendOperation> {
  const records: Record<string, SendOperation> = {};
  const settled: SendOperation[] = [];
  let unknown = 0;
  let acknowledged = 0;
  let inspected = 0;
  for (const id in state.sendOperationRecords) {
    if (!Object.prototype.hasOwnProperty.call(state.sendOperationRecords, id) || ++inspected > 4_096) break;
    const operation = state.sendOperationRecords[id];
    if (operation.state === "unknown") {
      if (++unknown <= MAX_UNKNOWN_SEND_OPERATIONS) records[id] = operation;
    } else if (operation.state === "acknowledged_unknown") {
      if (++acknowledged <= MAX_ACKNOWLEDGED_SEND_OPERATIONS) records[id] = operation;
    } else {
      if (settled.length === 64) settled.shift();
      settled.push(operation);
    }
  }
  for (const operation of settled) records[operation.clientOperationId] = operation;
  // sendOperations is retained as a compact compatibility view. Include an
  // entry only when its exact ID is not already represented by the canonical
  // record map (tests and an in-flight older tab can briefly update this view).
  inspected = 0;
  for (const threadId in state.sendOperations) {
    if (!Object.prototype.hasOwnProperty.call(state.sendOperations, threadId) || ++inspected > 256) break;
    const operation = state.sendOperations[threadId];
    if (!records[operation.clientOperationId]) records[operation.clientOperationId] = operation;
  }
  return records;
}

function loadSendOperations(): LoadedSendOperations | null {
  try {
    const byId: Record<string, SendOperation> = {};
    let unknown = 0;
    let acknowledged = 0;
    let overflow = localStorage.length > MAX_SEND_OPERATION_STORAGE_KEYS;
    const inspected = Math.min(localStorage.length, MAX_SEND_OPERATION_STORAGE_KEYS);
    for (let index = 0; index < inspected; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(OPERATIONS_KEY)) continue;
      let entry: any;
      const raw = localStorage.getItem(key);
      if (!raw || raw.length > 8_192) { overflow = true; continue; }
      try { entry = JSON.parse(raw); } catch { continue; }
      if (!entry || !["unknown", "acknowledged_unknown"].includes(entry.state) ||
          typeof entry.threadId !== "string" || !entry.threadId || entry.threadId.length > 256 ||
          typeof entry.clientOperationId !== "string" || !/^[a-z0-9-]{36}$/i.test(entry.clientOperationId)) continue;
      if (entry.state === "unknown") {
        unknown += 1;
        if (unknown > MAX_UNKNOWN_SEND_OPERATIONS) { overflow = true; continue; }
      } else {
        acknowledged += 1;
        if (acknowledged > MAX_ACKNOWLEDGED_SEND_OPERATIONS) continue;
      }
      byId[entry.clientOperationId] = {
        threadId: entry.threadId,
        clientOperationId: entry.clientOperationId,
        state: entry.state,
      };
    }
    // Records beyond the view remain durable in localStorage and are never
    // replayed. The overflow flag fails closed and blocks new sends.
    return { byId, byThread: selectThreadOperations(byId), overflow };
  } catch { return null; }
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

function loadThreadCreateOperation(): ThreadCreateOperation | null {
  try {
    const raw = localStorage.getItem(THREAD_CREATE_OPERATION_KEY);
    if (!raw) return null;
    if (raw.length > 8_192) {
      return { clientOperationId: "00000000-0000-4000-8000-000000000000", cwd: "", state: "unknown", error: "本地新会话回执超过安全预算；未自动重试，请明确放弃后再新建。" };
    }
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object" ||
        typeof entry.clientOperationId !== "string" || !/^[a-z0-9-]{36}$/i.test(entry.clientOperationId) ||
        typeof entry.cwd !== "string" || entry.cwd.length > 4096 || entry.cwd.includes("\0") ||
        !["unknown", "accepted", "acknowledged_unknown"].includes(entry.state) ||
        (entry.state === "accepted" && (typeof entry.threadId !== "string" || !entry.threadId || entry.threadId.length > 256))) return null;
    return {
      clientOperationId: entry.clientOperationId,
      cwd: entry.cwd,
      state: entry.state,
      ...(entry.state === "accepted" ? { threadId: entry.threadId } : {}),
    };
  } catch { return null; }
}

function saveThreadCreateOperation(operation: ThreadCreateOperation | null): void {
  if (!operation || !["unknown", "accepted", "acknowledged_unknown"].includes(operation.state)) {
    localStorage.removeItem(THREAD_CREATE_OPERATION_KEY);
    return;
  }
  localStorage.setItem(THREAD_CREATE_OPERATION_KEY, JSON.stringify({
    clientOperationId: operation.clientOperationId,
    cwd: operation.cwd,
    state: operation.state,
    ...(operation.state === "accepted" ? { threadId: operation.threadId } : {}),
  }));
}

function normalizeDisplay(value: unknown, base: Display = DEFAULT_DISPLAY): Display {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const next = { ...base };
  for (const key of ["reasoning", "commands", "fileChanges", "mcpCalls", "webSearch"] as const) {
    if (typeof source[key] === "boolean") next[key] = source[key];
  }
  const threshold = source.autoCompactThreshold;
  if (typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold < 1) {
    next.autoCompactThreshold = threshold;
  }
  return next;
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    if (raw.length > 64 * 1024) return DEFAULT_SETTINGS;
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
let projectSelectionSeq = 0;
let mcpRequestSeq = 0;
let openThreadRequestSeq = 0;
let newThreadRequestSeq = 0;
let managementRequestSeq = 0;
let managementNotificationVersion = 0;

interface AppStore {
  connection: "connecting" | "open" | "closed";
  connectionError: string | null;
  appStatusLoad: LoadStatus;
  management: ManagementSnapshot;
  managementError: string | null;
  codexState: string;
  gatewayVersion: string;
  workspaceRoot: string;
  /** Active provider preset. Model capabilities come from model/list. */
  providerMode: ProviderMode;
  account: GetAccountResponse | null;
  accountLoad: LoadStatus;
  projects: ProjectEntry[];
  projectsLoad: LoadStatus;
  currentProject: string;
  models: ModelInfo[];
  modelLoad: LoadStatus;
  mcpServers: McpServerView[];
  mcpLoad: LoadStatus;
  settings: Settings;
  display: Display;
  displayError: string | null;
  globalWarnings: GlobalWarning[];
  /** Every locally durable unresolved/acknowledged operation, keyed by its
   * immutable ID. Multiple tabs can race on one thread, so a thread-only map
   * is insufficient evidence. */
  sendOperationRecords: Record<string, SendOperation>;
  /** Preferred operation per thread for the compact Composer controls. */
  sendOperations: Record<string, SendOperation>;
  /** More durable unknown receipts exist than the bounded browser view holds. */
  sendOperationOverflow: boolean;
  threadCreateOperation: ThreadCreateOperation | null;
  sessions: SessionInfo[];
  /** Pagination cursor from the last thread/list response (null = no more). */
  sessionCursor: string | null;
  sessionLoading: boolean;
  sessionLoadingMore: boolean;
  sessionLoad: LoadStatus;
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
  /** Approval cards remain visible until the server confirms resolution. */
  approvalSubmissions: Record<string, boolean>;
  approvalErrors: Record<string, string>;
  inputRequests: InputRequest[];
  inputRequestErrors: Record<string, string>;
  deviceLogin: DeviceLogin | null;
  drawerTab: "diff" | "terminal" | null;
  sidebarOpen: boolean;

  bootstrap(): void;
  refresh(): Promise<void>;
  refreshAccount(): Promise<void>;
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
  dismissGlobalWarning(id: string): void;
  checkSendOperation(threadId: string, clientOperationId?: string): Promise<SendOperation | undefined>;
  acknowledgeUnknownSend(threadId: string, clientOperationId: string): boolean;
  checkThreadCreateOperation(): Promise<ThreadCreateOperation | null>;
  acknowledgeUnknownThreadCreate(clientOperationId: string): boolean;
  uploadAttachment(name: string, base64: string, kind?: "image" | "file"): Promise<{ path: string; size: number }>;
  readAttachment(path: string, signal?: AbortSignal): Promise<{ base64: string; mime: string }>;
  deleteAttachment(path: string): Promise<void>;
  openThread(threadId: string): Promise<void>;
  newThread(): Promise<string | null>;
  sendMessage(text: string, attachments?: Array<{ kind: "image" | "file"; name: string; path: string; previewUrl?: string }>, onOperation?: (identity: SendIdentity) => void): Promise<void>;
  sendTurn(text: string, attachments?: Array<{ kind: "image" | "file"; name: string; path: string; previewUrl?: string }>, onOperation?: (identity: SendIdentity) => void): Promise<void>;
  interruptTurn(): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  decideApproval(requestId: number | string, decision: "accept" | "acceptForSession" | "decline"): void;
  respondInputRequest(requestId: number | string, payload: unknown): boolean;
  compactThread(): Promise<void>;
  startDeviceLogin(): Promise<void>;
  cancelDeviceLogin(): Promise<void>;
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
function makeTurnStatusItem(turn: Pick<Turn, "id" | "status" | "error">): Extract<TimelineItem, { type: "turnStatus" }> | null {
  if (turn.status === "failed") {
    // Bound each untrusted field before joining; joining first could allocate a
    // second attacker-sized string while recovering a failed history turn.
    const details = [turn.error?.message, turn.error?.additionalDetails]
      .map((value) => boundedString(value, 10_000).trim())
      .filter((value) => value.length > 0);
    return {
      id: `turn-status:${turn.id}`,
      type: "turnStatus",
      turnId: turn.id,
      status: "failed",
      message: boundedString(details.join("\n"), 20_000) || "回合失败（服务器未提供错误详情）",
    };
  }
  return turn.status === "interrupted"
    ? { id: `turn-status:${turn.id}`, type: "turnStatus", turnId: turn.id, status: "interrupted", message: "回合已中断" }
    : null;
}

const MAX_HISTORY_RAW_TURNS = 4_096;
const MAX_HISTORY_PROJECTED_ITEMS = 9_999;
const MAX_HISTORY_PROJECTED_CHARS = 12 * 1024 * 1024;
const MAX_HISTORY_PROJECTED_NODES = 100_000;
const MAX_HISTORY_VALUE_DEPTH = 32;

class HistoryProjectionBudgetExceeded extends Error {}

function chargeHistoryText(value: string, budget: { chars: number }): void {
  // Charge the JSON-escaped representation without materializing it. Control
  // characters can expand six-fold in JSON.stringify, which the downstream
  // timeline budget uses when sizing retained items.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    budget.chars += code < 0x20 ? 6 : code === 0x22 || code === 0x5c ? 2 : 1;
    if (budget.chars > MAX_HISTORY_PROJECTED_CHARS) throw new HistoryProjectionBudgetExceeded();
  }
}

function plainRuntimeRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} 格式无效`);
  return value as Record<string, unknown>;
}

function ownRuntimeValue(record: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(`${label} 缺少 ${key}`);
  return descriptor.value;
}

/** Clone one inspected item while charging every nested value against a
 * shared budget. This never maps/copies the uninspected prefix of a large
 * runtime array and refuses accessors/custom prototypes at the wire boundary. */
function cloneHistoryValue(
  value: unknown,
  budget: { chars: number; nodes: number },
  ancestors: Set<object>,
  depth = 0,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_HISTORY_PROJECTED_NODES || depth > MAX_HISTORY_VALUE_DEPTH) {
    throw new HistoryProjectionBudgetExceeded();
  }
  if (value === null || typeof value === "boolean") {
    budget.chars += 5;
    if (budget.chars > MAX_HISTORY_PROJECTED_CHARS) throw new HistoryProjectionBudgetExceeded();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("会话历史包含无效数字");
    budget.chars += 24;
    if (budget.chars > MAX_HISTORY_PROJECTED_CHARS) throw new HistoryProjectionBudgetExceeded();
    return value;
  }
  if (typeof value === "string") {
    chargeHistoryText(value, budget);
    return value;
  }
  if (typeof value !== "object") throw new Error("会话历史包含无法序列化的值");
  if (ancestors.has(value)) throw new Error("会话历史包含循环引用");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error("会话历史数组格式无效");
        copy.push(cloneHistoryValue(descriptor.value, budget, ancestors, depth + 1));
      }
      return copy;
    }
    const record = plainRuntimeRecord(value, "会话历史条目");
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      chargeHistoryText(key, budget);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("会话历史条目包含访问器");
      copy[key] = cloneHistoryValue(descriptor.value, budget, ancestors, depth + 1);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

interface HistoryProjection {
  cwd: string;
  statusType: "active" | "idle" | "notLoaded" | "systemError";
  items: TimelineItem[];
  runningTurnId: string | null;
  truncated: boolean;
}

/** Validate the response identity before committing anything, then project
 * only a bounded tail. `thread/read` is a runtime trust boundary even though
 * its generated TypeScript type is precise. */
function projectThreadReadResponse(value: unknown, expectedThreadId: string): HistoryProjection {
  const response = plainRuntimeRecord(value, "thread/read 响应");
  const thread = plainRuntimeRecord(ownRuntimeValue(response, "thread", "thread/read 响应"), "thread/read 会话");
  const id = ownRuntimeValue(thread, "id", "thread/read 会话");
  if (typeof id !== "string" || id !== expectedThreadId || id.length > 256) throw new Error("thread/read 返回了错误的会话身份");
  const cwd = ownRuntimeValue(thread, "cwd", "thread/read 会话");
  if (typeof cwd !== "string" || !cwd || cwd.length > 4_096) throw new Error("thread/read 返回了无效工作目录");
  const status = plainRuntimeRecord(ownRuntimeValue(thread, "status", "thread/read 会话"), "thread/read 会话状态");
  const statusType = ownRuntimeValue(status, "type", "thread/read 会话状态");
  if (statusType !== "active" && statusType !== "idle" && statusType !== "notLoaded" && statusType !== "systemError") {
    throw new Error("thread/read 返回了无效会话状态");
  }
  if (statusType === "active") {
    const activeFlags = ownRuntimeValue(status, "activeFlags", "thread/read 会话状态");
    if (!Array.isArray(activeFlags) || activeFlags.length > 16) throw new Error("thread/read 返回了无效活动状态");
    for (let index = 0; index < activeFlags.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(activeFlags, String(index));
      if (!descriptor || !("value" in descriptor) ||
          descriptor.value !== "waitingOnApproval" && descriptor.value !== "waitingOnUserInput") {
        throw new Error("thread/read 返回了无效活动状态");
      }
    }
  }
  const turns = ownRuntimeValue(thread, "turns", "thread/read 会话");
  if (!Array.isArray(turns)) throw new Error("thread/read 返回了无效回合列表");

  const reversed: TimelineItem[] = [];
  const budget = { chars: 0, nodes: 0 };
  let runningTurnId: string | null = null;
  let truncated = turns.length > MAX_HISTORY_RAW_TURNS;
  const oldestInspectedTurn = Math.max(0, turns.length - MAX_HISTORY_RAW_TURNS);
  outer: for (let turnIndex = turns.length - 1; turnIndex >= oldestInspectedTurn; turnIndex--) {
    const descriptor = Object.getOwnPropertyDescriptor(turns, String(turnIndex));
    if (!descriptor || !("value" in descriptor)) throw new Error("thread/read 回合列表格式无效");
    const turn = plainRuntimeRecord(descriptor.value, "thread/read 回合");
    const turnId = ownRuntimeValue(turn, "id", "thread/read 回合");
    const turnStatus = ownRuntimeValue(turn, "status", "thread/read 回合");
    const items = ownRuntimeValue(turn, "items", "thread/read 回合");
    const itemsView = ownRuntimeValue(turn, "itemsView", "thread/read 回合");
    if (typeof turnId !== "string" || !turnId || turnId.length > 512 ||
        turnStatus !== "completed" && turnStatus !== "interrupted" && turnStatus !== "failed" && turnStatus !== "inProgress" ||
        !Array.isArray(items) || itemsView !== "notLoaded" && itemsView !== "summary" && itemsView !== "full") {
      throw new Error("thread/read 返回了无效回合结构");
    }
    if (itemsView !== "full") truncated = true;
    if (turnStatus === "inProgress" && runningTurnId === null) runningTurnId = turnId;

    let error: Turn["error"] = null;
    const rawError = ownRuntimeValue(turn, "error", "thread/read 回合");
    if (rawError !== null) {
      const errorRecord = plainRuntimeRecord(rawError, "thread/read 回合错误");
      const message = ownRuntimeValue(errorRecord, "message", "thread/read 回合错误");
      const additionalDetails = ownRuntimeValue(errorRecord, "additionalDetails", "thread/read 回合错误");
      if (typeof message !== "string" || additionalDetails !== null && typeof additionalDetails !== "string") {
        throw new Error("thread/read 返回了无效回合错误");
      }
      error = { message, additionalDetails, codexErrorInfo: null };
    }
    const statusItem = makeTurnStatusItem({ id: turnId, status: turnStatus, error });
    if (statusItem) {
      if (reversed.length >= MAX_HISTORY_PROJECTED_ITEMS) { truncated = true; break; }
      try {
        chargeHistoryText(statusItem.message, budget);
        chargeHistoryText(statusItem.id, budget);
      } catch (error) {
        if (error instanceof HistoryProjectionBudgetExceeded) { truncated = true; break; }
        throw error;
      }
      reversed.push({ ...statusItem, threadId: expectedThreadId });
    }

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      if (reversed.length >= MAX_HISTORY_PROJECTED_ITEMS) { truncated = true; break outer; }
      const itemDescriptor = Object.getOwnPropertyDescriptor(items, String(itemIndex));
      if (!itemDescriptor || !("value" in itemDescriptor)) throw new Error("thread/read 条目列表格式无效");
      let cloned: unknown;
      try {
        cloned = cloneHistoryValue(itemDescriptor.value, budget, new Set());
      } catch (error) {
        if (error instanceof HistoryProjectionBudgetExceeded) { truncated = true; break outer; }
        throw error;
      }
      const item = plainRuntimeRecord(cloned, "thread/read 条目");
      if (typeof item.id !== "string" || !item.id || item.id.length > 512 ||
          typeof item.type !== "string" || !item.type || item.type.length > 128) {
        throw new Error("thread/read 返回了无效时间线条目");
      }
      reversed.push({ ...item, threadId: expectedThreadId, turnId, streaming: false } as TimelineItem);
    }
  }

  const items = reversed.reverse();
  if (truncated) {
    items.unshift({
      ...makeErrorItem("会话历史超过浏览器读取预算；仅显示最新的有界部分，服务器历史没有删除。"),
      threadId: expectedThreadId,
      historyLoadError: true,
    });
  }
  return { cwd, statusType, items, runningTurnId, truncated };
}

/** Upstream has no snapshot sequence/cut. Only a complete live item, or a
 * stream whose item/started was observed during this read, can supersede a
 * snapshot. Content overlap is not evidence of identity ("abc" may repeat). */
function mergeHistory(snapshot: TimelineItem[], live: TimelineItem[], started: Set<string>): TimelineItem[] {
  const result = new Map(snapshot.map((item) => [item.id, item]));
  const acceptedOperations = new Set(snapshot.filter((item) => item.type === "userMessage").map((item) => item.clientOperationId).filter(Boolean));
  for (const item of live) {
    if (item.type === "localUserMessage" && item.clientOperationId && acceptedOperations.has(item.clientOperationId)) {
      continue;
    }
    const saved = result.get(item.id);
    if (!saved) { result.set(item.id, item); continue; }
    if (item.completed || started.has(item.id)) result.set(item.id, item);
  }
  return [...result.values()];
}

/** Object identity is the ownership token for an optimistic timeline preview. */
function timelinePreviewOwners(items: Record<string, TimelineItem[]>): Map<object, unknown> {
  const result = new Map<object, unknown>();
  for (const threadId in items) {
    if (!Object.prototype.hasOwnProperty.call(items, threadId)) continue;
    const list = items[threadId];
    for (const item of list) {
      if (item.type !== "localUserMessage" || !Array.isArray(item.attachments)) continue;
      for (const attachment of item.attachments) {
        if (attachment && typeof attachment === "object") result.set(attachment, attachment.previewUrl);
      }
    }
  }
  return result;
}

function releaseDroppedTimelinePreviews(before: Record<string, TimelineItem[]>, after: Record<string, TimelineItem[]>): void {
  if (before === after) return;
  const retained = timelinePreviewOwners(after);
  for (const [owner, url] of timelinePreviewOwners(before)) {
    if (!retained.has(owner)) releasePreviewUrl(owner, url);
  }
}

function releaseTimelinePreviews(list: TimelineItem[] | undefined): void {
  if (!list) return;
  for (const item of list) {
    if (item.type !== "localUserMessage" || !Array.isArray(item.attachments)) continue;
    for (const attachment of item.attachments) {
      if (attachment && typeof attachment === "object") releasePreviewUrl(attachment, attachment.previewUrl);
    }
  }
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
function syncUrl(threadId: string | null, mode: "replace" | "push" = "replace"): void {
  try {
    const url = new URL(location.href);
    const current = boundedString(url.searchParams.get("threadId"), 256) || null;
    if (current === threadId) return;
    if (threadId) url.searchParams.set("threadId", threadId);
    else url.searchParams.delete("threadId");
    if (mode === "push" && typeof history.pushState === "function") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  } catch {
    /* non-http context */
  }
}

export const useStore = create<AppStore>((rawSet, get) => {
  const overflowThreads = new Set<string>();
  const initialSendOperations = loadSendOperations() ?? { byThread: {}, byId: {}, overflow: false };
  let newThreadFlight: Promise<string | null> | null = null;
  let threadCreateCheckFlight: Promise<ThreadCreateOperation | null> | null = null;
  const sendOperationCheckFlights = new Map<string, Promise<SendOperation | undefined>>();
  const automaticallyCheckedSendOperations = new Set<string>();
  let automaticSendChecksStarted = 0;
  let automaticSendCheckEpoch = 0;
  let displayReadSeq = 0;
  let displayWriteIntentSeq = 0;
  let displayPendingWrites = 0;
  let displayWriteTail: Promise<void> = Promise.resolve();
  let globalWarningSeq = 0;
  let historyNavigationTarget: string | null | undefined;
  const set = (partial: Partial<AppStore> | ((state: AppStore) => Partial<AppStore>)) => rawSet((state) => {
    const patch = { ...(typeof partial === "function" ? partial(state) : partial) };
    const active = patch.activeThreadId === undefined ? state.activeThreadId : patch.activeThreadId;
    const project = patch.currentProject === undefined ? state.currentProject : patch.currentProject;
    if (active !== state.activeThreadId || project !== state.currentProject) cancelAttachmentReads();
    // Lifecycle/diff dictionaries otherwise retain every session ever seen,
    // even when its actual timeline was evicted from the bounded cache.
    const keys = ["turnActive", "activeTurnId", "turnDiff", "tokenUsage", "compacting", "plan", "historyLoaded", "historyLoading"] as const;
    for (const key of keys) {
      const value = patch[key];
      if (!value) continue;
      const limit = key === "turnDiff" || key === "plan" ? 8 : 128;
      const bounded: Record<string, unknown> = {};
      const tail: string[] = [];
      let inspected = 0;
      for (const id in value) {
        if (!Object.prototype.hasOwnProperty.call(value, id) || id === active) continue;
        if (++inspected > 4_096) break;
        if (tail.length === Math.max(0, limit - (active && Object.prototype.hasOwnProperty.call(value, active) ? 1 : 0))) tail.shift();
        tail.push(id);
      }
      if (active && Object.prototype.hasOwnProperty.call(value, active)) bounded[active] = value[active];
      for (let index = tail.length - 1; index >= 0; index--) bounded[tail[index]] = value[tail[index]];
      (patch as Record<string, unknown>)[key] = bounded;
    }
    if (patch.turnDiff) {
      const bounded: Record<string, string> = {};
      for (const id in patch.turnDiff) {
        if (!Object.prototype.hasOwnProperty.call(patch.turnDiff, id)) continue;
        const diff = patch.turnDiff[id];
        bounded[id] = diff.length > 1024 * 1024 ? `${diff.slice(0, 1024 * 1024)}\n[浏览器 Diff 显示预算已达到，剩余内容请在服务器查看。]` : diff;
      }
      patch.turnDiff = bounded;
    }
    if (!patch.items) return patch;
    const budget = budgetTimeline(patch.items, active);
    for (const threadId of budget.overflow) rememberBoundedSet(overflowThreads, threadId, 2_048);
    const historyLoaded = { ...state.historyLoaded, ...patch.historyLoaded };
    for (const threadId of [...budget.evicted, ...budget.overflow]) delete historyLoaded[threadId];
    releaseDroppedTimelinePreviews(state.items, budget.items);
    // A newly created optimistic item can itself be rejected by the budget and
    // therefore never appear in `state.items`; release that candidate too.
    releaseDroppedTimelinePreviews(patch.items, budget.items);
    return { ...patch, items: budget.items, historyLoaded };
  });
  let sessionsRefreshTimer: number | null = null;
  let bootstrapped = false;
  let runtimeVersion = 0;
  let accountRequestSeq = 0;
  let deviceLoginStatusRequestSeq = 0;
  let deviceLoginAttemptVersion = 0;
  let pendingDeviceLoginAttempt: number | null = null;
  type DeviceLoginCompletion = { success: boolean; error: string | null };
  const earlyDeviceLoginCompletions = new Map<string, { attempt: number; completion: DeviceLoginCompletion }>();
  const submittedInputs = new Set<string | number>();
  const activityVersions = new Map<string, number>();
  const deletedThreads = new Set<string>();
  // Only sessions actually created here may bridge delayed server indexing.
  const localSessions = new Map<string, { session: SessionInfo; cwd: string | null }>();
  let sessionWindowContext = "";
  /** Pagination grows only through an explicit "load more" action. A normal
   * lifecycle refresh replaces the authoritative first page and restarts from
   * its fresh cursor. Rows learned earlier remain visible as an unverified tail
   * until explicit pagination either revalidates or exhausts them. */
  let sessionFreshPrefixIds = new Set<string>();

  const rememberBoundedSet = (target: Set<string>, value: string, limit: number) => {
    target.delete(value);
    target.add(value);
    while (target.size > limit) {
      const oldest = target.values().next().value;
      if (typeof oldest !== "string") break;
      target.delete(oldest);
    }
  };
  const setActivityVersion = (threadId: string, value: number) => {
    activityVersions.delete(threadId);
    activityVersions.set(threadId, value);
    while (activityVersions.size > 2_048) {
      const oldest = activityVersions.keys().next().value;
      if (typeof oldest !== "string") break;
      activityVersions.delete(oldest);
    }
  };
  const rememberLocalSession = (threadId: string, value: { session: SessionInfo; cwd: string | null }) => {
    localSessions.delete(threadId);
    localSessions.set(threadId, value);
    while (localSessions.size > 256) {
      const oldest = localSessions.keys().next().value;
      if (typeof oldest !== "string") break;
      localSessions.delete(oldest);
    }
  };

  function resetSessionWindow(): void {
    sessionWindowContext = "";
    sessionFreshPrefixIds.clear();
  }

  async function activateCreatedThread(threadId: string, cwd: string): Promise<boolean> {
    if (cwd !== get().currentProject ||
        !get().projects.some((project) => project.path === cwd && project.available !== false)) return false;
    if (sessionSearchTimer !== null) {
      clearTimeout(sessionSearchTimer);
      sessionSearchTimer = null;
    }
    const local: SessionInfo = { threadId, title: "新对话", updatedAt: Math.floor(Date.now() / 1000) };
    rememberLocalSession(threadId, { session: local, cwd });
    sessionRequestSeq += 1;
    set((state) => ({
      items: { ...state.items, [threadId]: [] },
      historyLoaded: { ...state.historyLoaded, [threadId]: true },
      sessions: [local, ...(!state.sessionArchived && !state.sessionSearch
        ? state.sessions.filter((session) => session.threadId !== threadId) : [])],
      sessionArchived: false,
      sessionSearch: "",
      sessionCursor: null,
      sidebarOpen: false,
    }));
    await get().openThread(threadId);
    void get().refreshSessions().catch(() => {});
    return true;
  }

  type AttachmentReadResult = { base64: string; mime: string };
  type AttachmentReadSubscriber = {
    resolve: (value: AttachmentReadResult) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
    settled: boolean;
  };
  type AttachmentReadJob = {
    path: string;
    epoch: number;
    runtime: number;
    generation: number;
    threadId: string | null;
    project: string;
    subscribers: Set<AttachmentReadSubscriber>;
    started: boolean;
    wakeRetry?: () => void;
  };
  // The gateway has one heavy-request lane. Bound both active work and the
  // waiting set so mounting a very large history cannot retain thousands of
  // closures/base64 responses. Equal paths share one RPC and one retry loop.
  const MAX_QUEUED_ATTACHMENT_READS = 64;
  const attachmentReadQueue: AttachmentReadJob[] = [];
  const attachmentReadJobs = new Map<string, AttachmentReadJob>();
  const allAttachmentReadJobs = new Set<AttachmentReadJob>();
  let attachmentReadEpoch = 0;
  let queuedAttachmentReads = 0;
  let activeAttachmentReads = 0;

  function attachmentReadCanceled(): Error {
    const error = new Error("图片读取已取消");
    error.name = "AbortError";
    return error;
  }

  function settleAttachmentSubscriber(subscriber: AttachmentReadSubscriber, result: AttachmentReadResult | undefined, error?: unknown): void {
    if (subscriber.settled) return;
    subscriber.settled = true;
    if (subscriber.signal && subscriber.abort) subscriber.signal.removeEventListener("abort", subscriber.abort);
    if (error !== undefined) subscriber.reject(error);
    else subscriber.resolve(result!);
  }

  function attachmentJobIsCurrent(job: AttachmentReadJob): boolean {
    return job.epoch === attachmentReadEpoch && job.runtime === runtimeVersion &&
      job.generation === gateway.generation && job.threadId === get().activeThreadId &&
      job.project === get().currentProject;
  }

  function removeQueuedAttachmentJob(job: AttachmentReadJob): void {
    if (job.started) return;
    const index = attachmentReadQueue.indexOf(job);
    if (index === -1) return;
    attachmentReadQueue.splice(index, 1);
    queuedAttachmentReads = Math.max(0, queuedAttachmentReads - 1);
    allAttachmentReadJobs.delete(job);
  }

  function cancelAttachmentSubscriber(job: AttachmentReadJob, subscriber: AttachmentReadSubscriber): void {
    if (!job.subscribers.delete(subscriber)) return;
    settleAttachmentSubscriber(subscriber, undefined, attachmentReadCanceled());
    if (job.subscribers.size > 0) return;
    if (attachmentReadJobs.get(job.path) === job) attachmentReadJobs.delete(job.path);
    if (job.started) job.wakeRetry?.();
    else removeQueuedAttachmentJob(job);
  }

  function cancelAttachmentReads(): void {
    attachmentReadEpoch += 1;
    attachmentReadQueue.length = 0;
    queuedAttachmentReads = 0;
    attachmentReadJobs.clear();
    for (const job of allAttachmentReadJobs) {
      job.wakeRetry?.();
      const error = attachmentReadCanceled();
      for (const subscriber of job.subscribers) settleAttachmentSubscriber(subscriber, undefined, error);
      job.subscribers.clear();
      if (!job.started) allAttachmentReadJobs.delete(job);
    }
  }

  function waitForAttachmentRetry(job: AttachmentReadJob, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: number;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (job.wakeRetry === finish) delete job.wakeRetry;
        resolve();
      };
      timer = window.setTimeout(finish, delayMs);
      job.wakeRetry = finish;
    });
  }

  async function executeAttachmentRead(job: AttachmentReadJob): Promise<AttachmentReadResult> {
    for (let attempt = 0; ; attempt++) {
      if (!attachmentJobIsCurrent(job) || job.subscribers.size === 0) throw attachmentReadCanceled();
      try {
        const result = await gateway.rpc<AttachmentReadResult>("attachment/read", { path: job.path });
        if (!attachmentJobIsCurrent(job) || job.subscribers.size === 0) throw attachmentReadCanceled();
        return result;
      } catch (error: any) {
        if (!attachmentJobIsCurrent(job) || job.subscribers.size === 0) throw attachmentReadCanceled();
        // BUSY proves the gateway rejected the request before dispatch. No
        // other failure is replayed because it may be ambiguous.
        if (error?.code !== "BUSY" || attempt >= 2) throw error;
        await waitForAttachmentRetry(job, 75 * (attempt + 1));
      }
    }
  }

  function pumpAttachmentReads(): void {
    if (activeAttachmentReads >= 1) return;
    const job = attachmentReadQueue.shift();
    if (!job) return;
    queuedAttachmentReads = Math.max(0, queuedAttachmentReads - 1);
    if (job.subscribers.size === 0 || !attachmentJobIsCurrent(job)) {
      const error = attachmentReadCanceled();
      for (const subscriber of job.subscribers) settleAttachmentSubscriber(subscriber, undefined, error);
      job.subscribers.clear();
      if (attachmentReadJobs.get(job.path) === job) attachmentReadJobs.delete(job.path);
      allAttachmentReadJobs.delete(job);
      pumpAttachmentReads();
      return;
    }
    job.started = true;
    activeAttachmentReads += 1;
    void executeAttachmentRead(job)
      .then((result) => {
        for (const subscriber of job.subscribers) settleAttachmentSubscriber(subscriber, result);
      }, (error) => {
        for (const subscriber of job.subscribers) settleAttachmentSubscriber(subscriber, undefined, error);
      })
      .finally(() => {
        job.subscribers.clear();
        if (attachmentReadJobs.get(job.path) === job) attachmentReadJobs.delete(job.path);
        allAttachmentReadJobs.delete(job);
        activeAttachmentReads = Math.max(0, activeAttachmentReads - 1);
        pumpAttachmentReads();
      });
  }

  function queueAttachmentRead(path: string, signal?: AbortSignal): Promise<AttachmentReadResult> {
    if (typeof path !== "string" || path.length === 0 || path.length > 4_096) {
      return Promise.reject(new Error("附件路径格式无效"));
    }
    if (signal?.aborted) return Promise.reject(attachmentReadCanceled());
    let job = attachmentReadJobs.get(path);
    if (job && !attachmentJobIsCurrent(job)) {
      cancelAttachmentReads();
      job = undefined;
    }
    const created = !job;
    if (!job) {
      if (queuedAttachmentReads >= MAX_QUEUED_ATTACHMENT_READS) {
        return Promise.reject(Object.assign(new Error("等待读取的历史图片过多，请稍后重试"), { code: "ATTACHMENT_QUEUE_FULL" }));
      }
      job = {
        path,
        epoch: attachmentReadEpoch,
        runtime: runtimeVersion,
        generation: gateway.generation,
        threadId: get().activeThreadId,
        project: get().currentProject,
        subscribers: new Set(),
        started: false,
      };
      attachmentReadJobs.set(path, job);
      allAttachmentReadJobs.add(job);
    }
    const target = job;
    const result = new Promise<AttachmentReadResult>((resolve, reject) => {
      const subscriber: AttachmentReadSubscriber = { resolve, reject, signal, settled: false };
      subscriber.abort = () => cancelAttachmentSubscriber(target, subscriber);
      target.subscribers.add(subscriber);
      signal?.addEventListener("abort", subscriber.abort, { once: true });
      if (signal?.aborted) subscriber.abort();
    });
    if (created && target.subscribers.size > 0) {
      attachmentReadQueue.push(target);
      queuedAttachmentReads += 1;
      pumpAttachmentReads();
    }
    return result;
  }

  function forgetThread(threadId: string, deleted = false) {
    localSessions.delete(threadId);
    activityVersions.delete(threadId);
    overflowThreads.delete(threadId);
    if (deleted) rememberBoundedSet(deletedThreads, threadId, 4_096);
    if (get().activeThreadId === threadId) openThreadRequestSeq += 1;
    historyLoadOwners.delete(threadId);
    pendingHistoryDeltas.delete(threadId);
    historyStarts.delete(threadId);
    pausedStreams.delete(threadId);
    historyTerminalEpochs.delete(threadId);
    const drop = <T,>(record: Record<string, T>) => {
      const next = { ...record };
      delete next[threadId];
      return next;
    };
    set((s) => {
      const sendOperationRecords: Record<string, SendOperation> = {};
      for (const id in s.sendOperationRecords) {
        if (!Object.prototype.hasOwnProperty.call(s.sendOperationRecords, id)) continue;
        const operation = s.sendOperationRecords[id];
        // An unknown receipt is safety evidence and survives deletion. Settled
        // and explicitly abandoned compatibility records must not leak forever.
        if (operation.threadId === threadId && operation.state !== "unknown") {
          if (operation.state === "acknowledged_unknown") {
            try { localStorage.removeItem(`${OPERATIONS_KEY}${id}`); } catch { /* stale durable evidence is harmless */ }
          }
          continue;
        }
        sendOperationRecords[id] = operation;
      }
      return {
        sessions: s.sessions.filter((entry) => entry.threadId !== threadId),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
        items: drop(s.items), historyLoaded: drop(s.historyLoaded), historyLoading: drop(s.historyLoading),
        turnActive: drop(s.turnActive), activeTurnId: drop(s.activeTurnId),
        compacting: drop(s.compacting), plan: drop(s.plan), turnDiff: drop(s.turnDiff), tokenUsage: drop(s.tokenUsage),
        // Pending approvals are gateway-owned requests. Even deletion/archive
        // is not proof that the callback was resolved; the ordered
        // serverRequest/resolved event is the sole removal authority.
        approvals: s.approvals,
        inputRequests: s.inputRequests.filter((request) => request.params?.threadId !== threadId),
        sendOperationRecords,
        sendOperations: selectThreadOperations(sendOperationRecords),
      };
    });
    if (!get().activeThreadId) syncUrl(null);
  }

  function clearRuntimeState() {
    const currentLogin = get().deviceLogin;
    const preservedLogin: DeviceLogin | null = currentLogin?.status === "waiting"
      ? {
          ...currentLogin,
          canceling: false,
          ...(!currentLogin.loginId
            ? { error: "设备码登录启动结果待确认：连接或服务状态已经变化。未自动重试，正在重新核对。" }
            : currentLogin.canceling
              ? { error: "设备码登录取消结果待确认：连接或服务状态已经变化。正在重新核对。" }
              : {}),
        }
      : currentLogin;
    runtimeVersion += 1;
    automaticSendCheckEpoch += 1;
    accountRequestSeq += 1;
    deviceLoginStatusRequestSeq += 1;
    deviceLoginAttemptVersion += 1;
    pendingDeviceLoginAttempt = null;
    earlyDeviceLoginCompletions.clear();
    invalidateAsyncWork();
    activityVersions.clear();
    overflowThreads.clear();
    submittedInputs.clear();
    resetSessionWindow();
    set({
      items: {}, historyLoaded: {}, historyLoading: {}, turnActive: {}, activeTurnId: {},
      compacting: {}, plan: {}, turnDiff: {}, tokenUsage: {}, approvals: [], approvalSubmissions: {}, approvalErrors: {}, inputRequests: [], inputRequestErrors: {}, deviceLogin: preservedLogin,
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

  function loginId(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
  }

  function refreshAccountAfterNotification(): void {
    void get().refreshAccount();
  }

  async function refreshDeviceLoginStatus(): Promise<void> {
    const seq = ++deviceLoginStatusRequestSeq;
    const attempt = deviceLoginAttemptVersion;
    const runtime = runtimeVersion;
    const generation = gateway.generation;
    try {
      const result = await gateway.request("account/login/status", undefined);
      if (seq !== deviceLoginStatusRequestSeq || attempt !== deviceLoginAttemptVersion ||
          runtime !== runtimeVersion || generation !== gateway.generation || get().deviceLogin?.canceling) return;
      if (result?.state === "idle") {
        deviceLoginAttemptVersion += 1;
        pendingDeviceLoginAttempt = null;
        earlyDeviceLoginCompletions.clear();
        set({ deviceLogin: null });
        return;
      }
      if (result?.state === "starting" || result?.state === "unknown") {
        const current = get().deviceLogin;
        const error = result.state === "starting"
          ? "服务器正在启动设备码登录，等待登录标识。未自动重复发起。"
          : "设备码登录启动结果仍待确认（服务器状态未知）。未自动重试；请等待服务器恢复状态。";
        set({
          // A weaker global state must not erase an exact login ID already
          // witnessed by this tab. Keeping it permits an explicit cancel;
          // the next active/idle snapshot remains authoritative.
          deviceLogin: current?.status === "waiting" && current.loginId
            ? { ...current, canceling: false, error }
            : { status: "waiting", error },
        });
        return;
      }
      if (result?.state !== "active" || !result.login || typeof result.login !== "object" ||
          result.login.type !== "chatgptDeviceCode") {
        set({ deviceLogin: { status: "waiting", error: "服务器返回了无法识别的设备码登录状态；未自动重试。" } });
        return;
      }
      const id = loginId(result.login.loginId);
      if (!id) {
        set({ deviceLogin: { status: "waiting", error: "服务器返回了无效的设备码登录标识；未自动重试。" } });
        return;
      }
      const userCode = boundedString(result.login.userCode, 128) || undefined;
      const verificationUrl = boundedString(result.login.verificationUrl, 2_048) || undefined;
      set({
        deviceLogin: {
          status: "waiting",
          loginId: id,
          userCode,
          verificationUrl,
          ...(!userCode || !verificationUrl ? { error: "服务器返回的设备码登录信息不完整；可取消后重新开始。" } : {}),
        },
      });
    } catch {
      // Read-only reconciliation is best effort. Preserve the exact local ID
      // and uncertainty instead of guessing that a login stopped or replaying it.
    }
  }

  function settleCurrentDeviceLogin(id: string, completion: DeviceLoginCompletion): boolean {
    const current = get().deviceLogin;
    if (current?.status !== "waiting" || current.loginId !== id) return false;
    deviceLoginAttemptVersion += 1;
    pendingDeviceLoginAttempt = null;
    earlyDeviceLoginCompletions.clear();
    set({
      deviceLogin: completion.success
        ? null
        : { status: "error", error: boundedString(completion.error, 1_000) || "登录失败" },
    });
    return true;
  }

  function cacheEarlyDeviceLoginCompletion(id: string, completion: DeviceLoginCompletion): void {
    const attempt = pendingDeviceLoginAttempt;
    const current = get().deviceLogin;
    if (attempt === null || current?.status !== "waiting" || current.loginId !== undefined) return;
    if (!earlyDeviceLoginCompletions.has(id) && earlyDeviceLoginCompletions.size >= 32) {
      const oldest = earlyDeviceLoginCompletions.keys().next().value;
      if (typeof oldest === "string") earlyDeviceLoginCompletions.delete(oldest);
    }
    earlyDeviceLoginCompletions.set(id, { attempt, completion });
  }

  function upsertTurnStatus(threadId: string, item: Extract<TimelineItem, { type: "turnStatus" }>) {
    set((s) => ({ items: { ...s.items, [threadId]: upsertItem(s.items[threadId] ?? [], { ...item, threadId }) } }));
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
  const MAX_REASONING_PARTS = 1_024;
  type Delta = Extract<GatewayNotification, { method: typeof DELTA_METHODS[number] }>;
  function isDelta(event: GatewayNotification): event is Delta {
    return DELTA_METHODS.some((method) => method === event.method);
  }
  let deltaBuffer: Delta[] = [];
  let deltaBufferChars = 0;
  const pendingHistoryDeltas = new Map<string, Set<string>>();
  const historyStarts = new Map<string, Set<string>>();
  const pausedStreams = new Map<string, Set<string>>();
  /** Monotonic terminal cut observed while a history request is in flight. */
  const historyTerminalEpochs = new Map<string, number>();
  // A thread can be selected, abandoned, then selected again while its first
  // read is still settling. Only the load that installed the current sets may
  // clear them; a stale finally block must not erase the replacement load's
  // streaming evidence.
  const historyLoadOwners = new Map<string, symbol>();
  let deltaFlushTimer: number | null = null;
  const timelineItemIndexes = new WeakMap<TimelineItem[], Map<string, number>>();

  function releaseHistoryLoad(threadId: string, owner: symbol, preservePaused = false): boolean {
    if (historyLoadOwners.get(threadId) !== owner) return false;
    historyLoadOwners.delete(threadId);
    historyTerminalEpochs.delete(threadId);
    pendingHistoryDeltas.delete(threadId);
    historyStarts.delete(threadId);
    if (!preservePaused) pausedStreams.delete(threadId);
    return true;
  }

  function settlePausedHistory(threadId: string): void {
    const paused = pausedStreams.get(threadId);
    if (!paused) return;
    pausedStreams.delete(threadId);
    if (paused.size === 0) return;
    // The terminal lifecycle event is the safe cut the upstream snapshot API
    // does not provide. Force an inactive thread to reload on its next visit,
    // or reload the current one immediately after its load has settled.
    set((state) => ({ historyLoaded: { ...state.historyLoaded, [threadId]: false } }));
    if (get().activeThreadId === threadId && !get().historyLoading[threadId]) {
      void get().openThread(threadId);
    }
  }

  function noteHistoryTerminal(threadId: string): void {
    if (historyLoadOwners.has(threadId)) {
      historyTerminalEpochs.set(threadId, (historyTerminalEpochs.get(threadId) ?? 0) + 1);
    }
    settlePausedHistory(threadId);
  }

  function clearAllHistoryAuxiliary(): void {
    historyLoadOwners.clear();
    pendingHistoryDeltas.clear();
    historyStarts.clear();
    pausedStreams.clear();
    historyTerminalEpochs.clear();
  }

  function invalidateAsyncWork(): void {
    cancelAttachmentReads();
    refreshRequestSeq += 1;
    sessionRequestSeq += 1;
    modelRequestSeq += 1;
    projectRequestSeq += 1;
    projectSelectionSeq += 1;
    mcpRequestSeq += 1;
    openThreadRequestSeq += 1;
    newThreadRequestSeq += 1;
    deltaBuffer = [];
    deltaBufferChars = 0;
    clearAllHistoryAuxiliary();
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
    rawSet((s) => {
      const nextItems = { ...s.items };
      const indexes = new Map<string, Map<string, number>>();
      const copied = new Set<string>();
      const previousLists = new Map<string, TimelineItem[]>();
      const changedIndexes = new Map<string, Set<number>>();
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
        let list = nextItems[params.threadId];
        if (!list) continue;
        let index = indexes.get(params.threadId);
        if (!index) {
          index = timelineItemIndexes.get(list);
          if (!index) {
            index = new Map<string, number>();
            for (let itemIndex = 0; itemIndex < list.length; itemIndex++) index.set(list[itemIndex].id, itemIndex);
            timelineItemIndexes.set(list, index);
          }
          indexes.set(params.threadId, index);
        }
        const itemIndex = index.get(params.itemId);
        if (itemIndex === undefined) {
          if (s.historyLoading[params.threadId]) {
            const pending = pendingHistoryDeltas.get(params.threadId) ?? new Set<string>();
            if (pending.size < 2000) pending.add(params.itemId);
            pendingHistoryDeltas.set(params.threadId, pending);
          }
          continue;
        }
        if (!copied.has(params.threadId)) {
          previousLists.set(params.threadId, list);
          list = list.slice();
          nextItems[params.threadId] = list;
          timelineItemIndexes.set(list, index);
          copied.add(params.threadId);
        }
        const it = list[itemIndex];
        list[itemIndex] = (() => {
          switch (method) {
            case "item/agentMessage/delta":
              return it.type === "agentMessage" ? { ...it, text: (typeof it.text === "string" ? it.text : "") + params.delta } : it;
            case "item/plan/delta":
              return it.type === "plan" ? { ...it, text: (typeof it.text === "string" ? it.text : "") + params.delta } : it;
            case "item/reasoning/textDelta": {
              if (it.type !== "reasoning") return it;
              const content: string[] = (Array.isArray(it.content) ? it.content : [])
                .slice(0, MAX_REASONING_PARTS)
                .map((value) => typeof value === "string" ? value : "");
              const idx = params.contentIndex;
              while (content.length <= idx) content.push("");
              content[idx] = (content[idx] ?? "") + (params.delta ?? "");
              return { ...it, content, streaming: true };
            }
            case "item/reasoning/summaryTextDelta": {
              if (it.type !== "reasoning") return it;
              const summary: string[] = (Array.isArray(it.summary) ? it.summary : [])
                .slice(0, MAX_REASONING_PARTS)
                .map((value) => typeof value === "string" ? value : "");
              const idx = params.summaryIndex;
              while (summary.length <= idx) summary.push("");
              summary[idx] = (summary[idx] ?? "") + (params.delta ?? "");
              return { ...it, summary, streaming: true };
            }
            default: {
              if (it.type !== "commandExecution") return it;
              return {
                ...it,
                aggregatedOutput: (typeof it.aggregatedOutput === "string" ? it.aggregatedOutput : "") + params.delta,
              };
            }
          }
        })();
        const changed = changedIndexes.get(params.threadId) ?? new Set<number>();
        changed.add(itemIndex);
        changedIndexes.set(params.threadId, changed);
      }
      for (const [threadId, previous] of previousLists) {
        deriveTimelineListBudget(previous, nextItems[threadId], changedIndexes.get(threadId) ?? []);
      }
      const budget = budgetTimeline(nextItems, s.activeThreadId);
      for (const threadId of budget.overflow) rememberBoundedSet(overflowThreads, threadId, 2_048);
      const historyLoaded = { ...s.historyLoaded };
      const dropped = new Set([...budget.evicted, ...budget.overflow]);
      for (const threadId of dropped) {
        delete historyLoaded[threadId];
        releaseTimelinePreviews(nextItems[threadId] ?? s.items[threadId]);
      }
      return { items: budget.items, historyLoaded };
    });
  }

  function applyNotification(event: GatewayNotification): void {
    if (isDelta(event)) {
      const { params } = event;
      if (typeof params?.threadId !== "string" || !params.threadId || params.threadId.length > 256 ||
          typeof params.itemId !== "string" || !params.itemId || params.itemId.length > 512 ||
          typeof params.delta !== "string") return;
      if (event.method === "item/reasoning/textDelta") {
        const contentIndex = (params as { contentIndex?: unknown }).contentIndex;
        if (!Number.isSafeInteger(contentIndex) || (contentIndex as number) < 0 || (contentIndex as number) >= MAX_REASONING_PARTS) return;
      }
      if (event.method === "item/reasoning/summaryTextDelta") {
        const summaryIndex = (params as { summaryIndex?: unknown }).summaryIndex;
        if (!Number.isSafeInteger(summaryIndex) || (summaryIndex as number) < 0 || (summaryIndex as number) >= MAX_REASONING_PARTS) return;
      }
      if (overflowThreads.has(params.threadId)) return;
      if (params.delta.length > 1024 * 1024) {
        rememberBoundedSet(overflowThreads, params.threadId, 2_048);
        appendToThread(params.threadId, makeErrorItem("单次流片段超过浏览器预算，显示已暂停；请通过完整历史核对结果。"));
        set((state) => ({ historyLoaded: { ...state.historyLoaded, [params.threadId]: false } }));
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
    // The generated protocol is a compile-time contract, but the WebSocket is
    // still a runtime boundary. A malformed notification must not terminate
    // delivery of every later lifecycle event in this tab.
    if (!params || typeof params !== "object" || Array.isArray(params)) return;
    if ("threadId" in params) {
      if (typeof params.threadId !== "string" || !params.threadId || params.threadId.length > 256) return;
      if (deletedThreads.has(params.threadId) && method !== "thread/unarchived") return;
      if (["turn/started", "turn/completed", "thread/status/changed", "error"].includes(method)) {
        setActivityVersion(params.threadId, (activityVersions.get(params.threadId) ?? 0) + 1);
      }
    }
    switch (method) {
      case "serverRequest/answerRejected": {
        const requestId = params.serverRequestId ?? params.requestId;
        if (requestId === undefined) return;
        if (get().approvals.some((approval) => approval.requestId === requestId)) {
          const key = String(requestId);
          set((state) => ({
            approvalSubmissions: { ...state.approvalSubmissions, [key]: false },
            approvalErrors: {
              ...state.approvalErrors,
              [key]: boundedString(params.error, 2_000) || "服务器拒绝了此审批决定，请核对后重试。",
            },
          }));
          return;
        }
        if (!get().inputRequests.some((request) => request.requestId === requestId)) return;
        submittedInputs.delete(requestId);
        set((state) => ({ inputRequestErrors: { ...state.inputRequestErrors, [String(requestId)]: boundedString(params.error, 2000) || "服务器拒绝了此回答，请检查后重试。" } }));
        return;
      }
      case "harness/turnAccepted": {
        const selected = get().sendOperations[params.threadId];
        const operation = get().sendOperationRecords[params.clientOperationId] ??
          (selected?.clientOperationId === params.clientOperationId ? selected : undefined);
        if (operation && operation.threadId === params.threadId && operation.state !== "acknowledged_unknown") {
          const accepted: SendOperation = { ...operation, state: "accepted" };
          try { saveSendOperation(accepted); } catch { /* Durable unknown remains recoverable. */ }
          set((state) => {
            const sendOperationRecords = { ...mergedSendOperationRecords(state), [accepted.clientOperationId]: accepted };
            return { sendOperationRecords, sendOperations: selectThreadOperations(sendOperationRecords) };
          });
        }
        set((state) => {
          let items = (state.items[params.threadId] ?? []).map((item) => item.type === "userMessage" && item.turnId === params.turnId
            ? { ...item, harnessAttachments: params.attachments, clientOperationId: params.clientOperationId } : item);
          if (items.some((item) => item.type === "userMessage" && item.clientOperationId === params.clientOperationId)) {
            items = items.filter((item) => item.type !== "localUserMessage" || item.clientOperationId !== params.clientOperationId);
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
        if (!params?.item || typeof params.item !== "object" || Array.isArray(params.item) ||
            typeof params.item.id !== "string" || !params.item.id || params.item.id.length > 512 ||
            typeof params.item.type !== "string" || !params.item.type || params.item.type.length > 128 ||
            typeof params.turnId !== "string" || !params.turnId || params.turnId.length > 512) return;
        if (overflowThreads.has(params.threadId)) return;
        // upsertItem merges, so explicitly drop the local streaming marker —
        // otherwise a completed reasoning item keeps "思考中…" forever.
        const item: TimelineItem = { ...params.item, threadId: params.threadId, turnId: params.turnId, streaming: false, completed: method === "item/completed" };
        if (method === "item/started" && get().historyLoading[params.threadId]) historyStarts.get(params.threadId)?.add(item.id);
        if (method === "item/completed") {
          const pending = pendingHistoryDeltas.get(params.threadId);
          pending?.delete(item.id);
          if (pending && pending.size === 0) pendingHistoryDeltas.delete(params.threadId);
          const paused = pausedStreams.get(params.threadId);
          paused?.delete(item.id);
          if (paused && paused.size === 0) pausedStreams.delete(params.threadId);
        }
        set((s) => {
          let items = s.items[params.threadId] ?? [];
          // Match the gateway's durable operation ID, not natural language.
          if (item.type === "userMessage") {
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
        if (!params.turn || typeof params.turn !== "object" || Array.isArray(params.turn) ||
            typeof params.turn.id !== "string" || !params.turn.id || params.turn.id.length > 512) return;
        set((s) => ({
          turnActive: { ...s.turnActive, [params.threadId]: true },
          activeTurnId: { ...s.activeTurnId, [params.threadId]: params.turn.id },
        }));
        return;
      }
      case "turn/completed": {
        if (!params.threadId || !params.turn || typeof params.turn !== "object" || Array.isArray(params.turn) ||
            typeof params.turn.id !== "string" || !params.turn.id || params.turn.id.length > 512) return;
        const active = get().activeTurnId[params.threadId];
        if (active && active !== params.turn.id) return;
        set((s) => ({
          turnActive: { ...s.turnActive, [params.threadId]: false },
          activeTurnId: { ...s.activeTurnId, [params.threadId]: null },
        }));
        const status = makeTurnStatusItem(params.turn);
        if (status) upsertTurnStatus(params.threadId, status);
        // Titles (first-message preview) and timestamps settle server-side
        // only after rollout indexing; refresh once the turn is done.
        scheduleSessionsRefresh();
        noteHistoryTerminal(params.threadId);
        return;
      }
      case "turn/diff/updated": {
        if (!params.threadId || typeof params.diff !== "string") return;
        set((s) => ({ turnDiff: { ...s.turnDiff, [params.threadId]: params.diff } }));
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
        if (!params.threadId || (params.explanation !== null && typeof params.explanation !== "string") || !Array.isArray(params.plan)) return;
        const steps = params.plan.slice(0, 1_000).map((entry) => {
          const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
          const status = record.status === "pending" || record.status === "inProgress" || record.status === "completed" ? record.status : "unknown";
          return { step: boundedString(record.step, 20_000) || "（计划步骤格式无效）", status };
        });
        if (params.plan.length > steps.length) steps.push({ step: `另有 ${params.plan.length - steps.length} 个步骤未显示（已达到浏览器预算）`, status: "unknown" });
        set((s) => ({
          plan: {
            ...s.plan,
            [params.threadId]: { explanation: params.explanation?.slice(0, 20_000) ?? null, steps },
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
          noteHistoryTerminal(params.threadId);
        }
        if (!params.willRetry && params.turnId) {
          upsertTurnStatus(params.threadId, {
            id: `turn-status:${params.turnId}`,
            type: "turnStatus",
            turnId: params.turnId,
            status: "failed",
            message: boundedString(params.error?.message, 20_000) || "回合失败（服务器未提供错误详情）",
          });
        } else {
          appendToThread(params.threadId, makeErrorItem(params.error?.message ?? "unknown error", !!params.willRetry));
        }
        return;
      }
      case "thread/started": {
        scheduleSessionsRefresh();
        return;
      }
      case "thread/name/updated": {
        const threadId = boundedString(params?.threadId, 256);
        const title = boundedString(params?.threadName, 200);
        if (threadId && typeof params?.threadName === "string") {
          const query = get().sessionSearch.trim().toLocaleLowerCase();
          set((state) => ({
            sessions: query && !title.toLocaleLowerCase().includes(query)
              ? state.sessions.filter((session) => session.threadId !== threadId)
              : state.sessions.map((session) => session.threadId === threadId
                  ? { ...session, title: title || "（无标题会话）" }
                  : session),
          }));
        }
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
      case "account/updated": {
        // This event has no login identity. Refresh the account display, but do
        // not let another tab's account transition settle our device flow.
        refreshAccountAfterNotification();
        return;
      }
      case "account/login/completed": {
        refreshAccountAfterNotification();
        if (typeof params.success !== "boolean") return;
        const id = loginId(params.loginId);
        if (!id) return;
        const completion: DeviceLoginCompletion = {
          success: params.success,
          // Bound before caching: a completion may precede the start response,
          // so retaining the raw transport string here would bypass timeline budgets.
          error: typeof params.error === "string" ? boundedString(params.error, 1_000) : null,
        };
        if (!settleCurrentDeviceLogin(id, completion)) {
          cacheEarlyDeviceLoginCompletion(id, completion);
          if (get().deviceLogin?.status === "waiting" && !get().deviceLogin?.loginId && pendingDeviceLoginAttempt === null) {
            void refreshDeviceLoginStatus();
          }
        }
        return;
      }
      case "appServer/stateChanged": {
        const state = boundedString(params?.state, 64) || "unknown";
        set({ codexState: state });
        // App-server restart kills all its terminal sessions and may change
        // model/account state. Force a full refresh + clear caches when it
        // comes back to ready, even if our WebSocket never dropped.
        clearRuntimeState();
        if (state === "ready" && get().connection === "open") void get().refresh();
        return;
      }
      case "displayPrefs/updated": {
        // Broadcast from the gateway when ANY browser changes display prefs.
        displayReadSeq += 1;
        if (params) set({
          display: normalizeDisplay(params, get().display),
          ...(displayPendingWrites === 0 ? { displayError: null } : {}),
        });
        return;
      }
      case "warning": {
        // Server-side warnings (deprecated config keys, sandbox hints, etc.)
        // — surface in the active thread instead of silently dropping.
        const threadId = boundedString(params?.threadId, 256);
        const message = boundedString(params?.message, 2_000) || "服务器发出了一条未提供详情的警告。";
        if (threadId) {
          appendToThread(threadId, makeErrorItem(`⚠ ${message}`));
        } else {
          const id = `warning-${++globalWarningSeq}`;
          set((state) => ({ globalWarnings: [...state.globalWarnings, { id, message }].slice(-20) }));
        }
        return;
      }
      case "configWarning": {
        const summary = boundedString(params?.summary, 1_000) || "服务器配置存在警告。";
        const details = boundedString(params?.details, 2_000);
        const path = boundedString(params?.path, 1_000);
        const message = `${summary}${details ? ` ${details}` : ""}${path ? `（${path}）` : ""}`.slice(0, 3_000);
        const id = `config-warning-${++globalWarningSeq}`;
        set((state) => ({ globalWarnings: [...state.globalWarnings, { id, message }].slice(-20) }));
        return;
      }
      case "thread/status/changed": {
        // Update the session's turn activity hint if we have the thread.
        const status = params.status;
        if (params.threadId && status && typeof status === "object" && !Array.isArray(status) &&
            ["active", "idle", "notLoaded", "systemError"].includes(status.type)) {
          const active = status.type === "active";
          set((s) => ({
            turnActive: { ...s.turnActive, [params.threadId]: active },
            ...(!active ? { activeTurnId: { ...s.activeTurnId, [params.threadId]: null } } : {}),
          }));
          if (!active) noteHistoryTerminal(params.threadId);
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
          const approvalSubmissions = { ...s.approvalSubmissions }; delete approvalSubmissions[String(rid)];
          const approvalErrors = { ...s.approvalErrors }; delete approvalErrors[String(rid)];
          return {
            approvals: s.approvals.filter((a) => a.requestId !== rid),
            approvalSubmissions,
            approvalErrors,
            inputRequests: s.inputRequests.filter((request) => request.requestId !== rid),
            inputRequestErrors,
          };
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
      if (get().approvals.length >= 128 && !get().approvals.some((approval) => approval.requestId === msg.requestId)) {
        // The browser cannot safely retain an unbounded approval queue. Reject
        // only the excess request; never approve unseen context.
        const payload = msg.method === "item/permissions/requestApproval"
          ? { permissions: {}, scope: "turn" as const }
          : { decision: "decline" as const };
        try { gateway.respondServerRequest(msg.requestId, payload); } catch { /* fail closed if the socket is already gone */ }
        return;
      }
      set((s) => {
        return {
          approvals: [...s.approvals.filter((a) => a.requestId !== msg.requestId), msg].slice(-128),
        };
      });
      return;
    }
    if (msg.method === "item/tool/requestUserInput" || msg.method === "mcpServer/elicitation/request") {
      if (get().inputRequests.length >= 128 && !get().inputRequests.some((request) => request.requestId === msg.requestId)) {
        const payload = msg.method === "item/tool/requestUserInput"
          ? { answers: {} }
          : { action: "cancel" as const, content: null, _meta: null };
        try { gateway.respondServerRequest(msg.requestId, payload); } catch { /* fail closed if the socket is already gone */ }
        return;
      }
      set((state) => ({ inputRequests: [...state.inputRequests.filter((request) => request.requestId !== msg.requestId), msg].slice(-128) }));
      return;
    }
  }

  function reconcileStoredSendOperations(): void {
    const snapshot = loadSendOperations();
    if (!snapshot) return;
    // If this tab missed an acknowledgment event and observes only a newer
    // operation for the same thread, briefly expose the conservative
    // acknowledged_unknown state. Composer subscriptions are synchronous, so
    // they can release the captured old draft before the new snapshot lands.
    // The vanished key plus a newer same-thread durable ID proves another tab
    // deliberately released the old lock; it does not prove execution success
    // and must never trigger a resend.
    const currentById = mergedSendOperationRecords(get());
    const nextById = { ...snapshot.byId };
    const replacementThreads = new Map<string, string>();
    for (const id in snapshot.byId) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.byId, id)) continue;
      const operation = snapshot.byId[id];
      if (!replacementThreads.has(operation.threadId)) replacementThreads.set(operation.threadId, operation.clientOperationId);
    }
    for (const id in currentById) {
      if (!Object.prototype.hasOwnProperty.call(currentById, id)) continue;
      const current = currentById[id];
      if (current.state !== "unknown" || nextById[current.clientOperationId]) continue;
      const replacementId = replacementThreads.get(current.threadId);
      if (!replacementId || replacementId === current.clientOperationId) continue;
      try {
        const raw = localStorage.getItem(`${OPERATIONS_KEY}${current.clientOperationId}`);
        if (raw !== null) {
          const stored = JSON.parse(raw);
          if (stored?.clientOperationId !== current.clientOperationId || stored?.threadId !== current.threadId || stored?.state !== "acknowledged_unknown") continue;
        }
      } catch { return; }
      nextById[current.clientOperationId] = { ...current, state: "acknowledged_unknown" };
    }
    // localStorage is the durable authority for unresolved IDs. Replace the
    // snapshot instead of merging so removals from another tab propagate.
    set({ sendOperationRecords: nextById, sendOperations: selectThreadOperations(nextById), sendOperationOverflow: snapshot.overflow });
  }

  function scheduleAutomaticSendChecks(): void {
    const epoch = ++automaticSendCheckEpoch;
    if (automaticSendChecksStarted >= MAX_AUTOMATIC_SEND_CHECKS) return;
    const records = mergedSendOperationRecords(get());
    const candidates: SendOperation[] = [];
    for (const id in records) {
      if (!Object.prototype.hasOwnProperty.call(records, id)) continue;
      const operation = records[id];
      if (operation.state !== "unknown" || automaticallyCheckedSendOperations.has(id)) continue;
      rememberBoundedSet(automaticallyCheckedSendOperations, id, MAX_UNKNOWN_SEND_OPERATIONS);
      candidates.push(operation);
      if (candidates.length >= MAX_AUTOMATIC_SEND_CHECKS - automaticSendChecksStarted) break;
    }
    automaticSendChecksStarted += candidates.length;
    // One bounded sequential pass per connection. A failed/unknown lookup is
    // not retried automatically on later reconnects in this page lifetime.
    void (async () => {
      for (const operation of candidates) {
        if (epoch !== automaticSendCheckEpoch || get().connection !== "open") return;
        await get().checkSendOperation(operation.threadId, operation.clientOperationId);
      }
    })();
  }

  return {
  connection: "connecting",
  connectionError: null,
  appStatusLoad: loadingStatus(),
  management: { state: "idle" },
  managementError: null,
  codexState: "unknown",
  gatewayVersion: "",
  workspaceRoot: "",
  providerMode: "openai",
  account: null,
  accountLoad: loadingStatus(),
    projects: [],
    projectsLoad: loadingStatus(),
    currentProject: loadCurrentProject(),
    models: [],
    modelLoad: loadingStatus(),
    mcpServers: [],
    mcpLoad: loadingStatus(),
    settings: loadSettings(),
    display: { ...DEFAULT_DISPLAY },
    displayError: null,
    globalWarnings: [],
    sendOperationRecords: initialSendOperations.byId,
    sendOperations: initialSendOperations.byThread,
    sendOperationOverflow: initialSendOperations.overflow,
    threadCreateOperation: loadThreadCreateOperation(),
    sessions: [],
    sessionCursor: null,
    sessionLoading: false,
    sessionLoadingMore: false,
    sessionLoad: loadingStatus(),
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
    approvalSubmissions: {},
    approvalErrors: {},
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
        scheduleAutomaticSendChecks();
        if (get().threadCreateOperation?.state === "unknown") void get().checkThreadCreateOperation();
      });
      gateway.onNotification(applyNotification);
      window.addEventListener?.("storage", (event) => {
        if (event.key === null || event.key.startsWith(OPERATIONS_KEY)) reconcileStoredSendOperations();
        if (event.key === THREAD_CREATE_OPERATION_KEY && event.newValue) {
          const stored = loadThreadCreateOperation();
          if (stored) set({ threadCreateOperation: stored });
        }
      });
      window.addEventListener?.("popstate", () => {
        const target = boundedString(new URLSearchParams(location.search).get("threadId"), 256) || null;
        initialThreadSelected = true;
        if (target) {
          historyNavigationTarget = target;
          void get().openThread(target);
          return;
        }
        historyNavigationTarget = undefined;
        newThreadRequestSeq += 1;
        const previous = get().activeThreadId;
        if (previous) {
          const owner = historyLoadOwners.get(previous);
          if (owner) releaseHistoryLoad(previous, owner);
          else {
            pendingHistoryDeltas.delete(previous);
            historyStarts.delete(previous);
          }
        }
        openThreadRequestSeq += 1;
        set((state) => ({
          activeThreadId: null,
          sidebarOpen: false,
          ...(previous ? { historyLoading: { ...state.historyLoading, [previous]: false } } : {}),
        }));
      });
      gateway.setServerRequestHandler(handleServerRequest);
      gateway.connect();

    },

    async refresh() {
      const seq = ++refreshRequestSeq;
      const generation = gateway.generation;
      const managementVersion = managementNotificationVersion;
      set({ appStatusLoad: loadingStatus() });
      try {
        const status = await gateway.rpc<any>("app/status");
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        if (!status || typeof status !== "object" ||
            !["openai", "zhipu", "custom"].includes(status.providerMode) ||
            typeof status.codexState !== "string") {
          throw new Error("服务器返回的应用状态格式无效");
        }
        const providerMode = normalizeProviderMode(status.providerMode, get().providerMode);
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
          appStatusLoad: loadedStatus(),
          ...(managementVersion === managementNotificationVersion && status?.management ? { management: normalizeManagement(status.management) } : {}),
          ...(providerChanged ? {
            models: [], mcpServers: [], account: null,
            modelLoad: loadingStatus(), mcpLoad: loadingStatus(), accountLoad: loadingStatus(),
          } : {}),
          ...(providerChanged ? { settings } : {}),
          display: normalizeDisplay({ autoCompactThreshold: status?.autoCompactThreshold }, get().display),
        });
        // A provider may expose a large or slow paginated model catalog. It is
        // useful metadata, not a prerequisite for restoring projects/sessions.
        // Run it independently so an existing conversation becomes usable as
        // soon as its authoritative list/history is available.
        void get().refreshModels();
        await Promise.all([
          refreshDeviceLoginStatus(),
          get().refreshAccount(),
          (() => {
            const displaySeq = ++displayReadSeq;
            return gateway.rpc<Partial<Display>>("displayPrefs/get")
            .then((prefs) => {
              if (prefs && seq === refreshRequestSeq && generation === gateway.generation &&
                  displaySeq === displayReadSeq) {
                set({ display: normalizeDisplay(prefs, get().display), ...(displayPendingWrites === 0 ? { displayError: null } : {}) });
              }
            })
            .catch((error) => {
              if (seq === refreshRequestSeq && generation === gateway.generation &&
                  displaySeq === displayReadSeq && displayPendingWrites === 0) {
                set({ displayError: loadFailure("显示偏好读取失败", error).error });
              }
            });
          })(),
          get().refreshProjects(),
          get().refreshMcp(),
        ]);
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        await get().refreshSessions();
        if (seq !== refreshRequestSeq || generation !== gateway.generation) return;
        // A failed first list request is not an empty-list success. Keep the
        // initial-selection latch open so an explicit retry can still land on
        // the newest real conversation.
        if (get().sessionLoad.state !== "loaded") return;
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
      } catch (error) {
        if (seq === refreshRequestSeq && generation === gateway.generation) {
          set({ appStatusLoad: loadFailure("应用状态读取失败", error) });
        }
      }
    },

    async refreshAccount() {
      const seq = ++accountRequestSeq;
      const generation = gateway.generation;
      const runtime = runtimeVersion;
      set({ accountLoad: loadingStatus() });
      try {
        const response: unknown = await gateway.request("account/read", undefined);
        if (seq !== accountRequestSeq || generation !== gateway.generation || runtime !== runtimeVersion) return;
        const account = projectAccountResponse(response);
        set({ account, accountLoad: loadedStatus() });
      } catch (error) {
        if (seq === accountRequestSeq && generation === gateway.generation && runtime === runtimeVersion) {
          set({ accountLoad: loadFailure("账号状态读取失败", error) });
        }
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
      const previousSessions = get().sessions;
      const sameWindow = context === sessionWindowContext;
      // Reset BOTH loading flags — a pending loadMore from a previous query
      // context might have set loadingMore and its stale return won't clear it.
      set({ sessionLoading: true, sessionLoadingMore: false, sessionLoad: loadingStatus() });
      try {
        const params: ThreadListParams = { limit: 50 };
        if (currentProject) params.cwd = currentProject;
        if (sessionArchived) params.archived = true;
        if (sessionSearch.trim()) params.searchTerm = sessionSearch.trim();
        // Lifecycle notifications can be frequent. Refresh exactly one bounded
        // page; only an explicit loadMoreSessions call may extend pagination.
        const res: ThreadListResponse = await gateway.request("thread/list", params);
        if (seq !== sessionRequestSeq || generation !== gateway.generation) return;
        if (!Array.isArray(res?.data)) throw new Error("服务器返回的会话列表格式无效");
        const firstPage: SessionInfo[] = res.data.slice(0, 100)
          .map((t) => ({
            threadId: boundedString(t?.id, 256),
            title: boundedString(t?.name || t?.preview, 200) || "（无标题会话）",
            updatedAt: typeof t?.updatedAt === "number" && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
          }))
          .filter((s) => s.threadId && !deletedThreads.has(s.threadId));
        const firstById = new Map(firstPage.map((session) => [session.threadId, session]));
        for (const session of firstPage) localSessions.delete(session.threadId);
        const firstCursor = typeof res?.nextCursor === "string" && res.nextCursor
          ? res.nextCursor.slice(0, 512)
          : null;
        // Keep every previously known row absent from the new first page while
        // the fresh response still has a tail. This includes the old first-page
        // boundary: new inserts can push those rows onto page two. Crucially we
        // restart pagination from firstCursor rather than retaining a stale deep
        // cursor, so explicit load-more revalidates the tail without gaps.
        const preserveKnownTail = sameWindow && firstCursor !== null;
        const knownTail = preserveKnownTail
          ? previousSessions.filter((session) =>
              !localSessions.has(session.threadId) &&
              !firstById.has(session.threadId) &&
              !deletedThreads.has(session.threadId))
          : [];
        let sessions = [...firstPage, ...knownTail];
        // The server's thread list lags behind rollout indexing; keep entries
        // we registered locally within the last 5 minutes — but only when
        // we're on the "current" tab with no search filter.
        if (!sessionArchived && !sessionSearch.trim()) {
          const nowSec = Math.floor(Date.now() / 1000);
          const freshLocals: SessionInfo[] = [];
          for (const [id, local] of localSessions) {
            if (firstById.has(id) || nowSec - local.session.updatedAt >= 300 || deletedThreads.has(id)) localSessions.delete(id);
            else if (local.cwd === currentProject) freshLocals.push(local.session);
          }
          if (freshLocals.length > 0) sessions = [...freshLocals, ...sessions];
        }
        // Server already sorts by updated_at desc (gateway sets sortKey), so
        // we preserve cursor order — no client-side re-sort on paginated data.
        sessionWindowContext = context;
        sessionFreshPrefixIds = new Set(firstPage.map((session) => session.threadId));
        set({
          sessions,
          sessionCursor: firstCursor,
          sessionLoading: false,
          sessionLoad: loadedStatus(),
        });
      } catch (error) {
        if (seq === sessionRequestSeq && generation === gateway.generation) {
          set({ sessionLoading: false, sessionLoad: loadFailure("会话列表读取失败", error) });
        }
      }
    },

    async loadMoreSessions() {
      const cursor = get().sessionCursor;
      if (!cursor || get().sessionLoadingMore || get().sessionLoading) return;
      const seq = ++sessionRequestSeq;
      const generation = gateway.generation;
      const { currentProject, sessionArchived, sessionSearch } = get();
      const context = JSON.stringify([currentProject, sessionArchived, sessionSearch.trim()]);
      // A cursor is meaningful only for the query that produced it. Context
      // switches clear cursors, but this guard also protects imperative callers.
      if (context !== sessionWindowContext) {
        await get().refreshSessions();
        return;
      }
      set({ sessionLoadingMore: true, sessionLoad: loadingStatus() });
      try {
        const params: ThreadListParams = { limit: 50, cursor };
        if (currentProject) params.cwd = currentProject;
        if (sessionArchived) params.archived = true;
        if (sessionSearch.trim()) params.searchTerm = sessionSearch.trim();
        const res = await gateway.request("thread/list", params);
        if (seq !== sessionRequestSeq || generation !== gateway.generation) return;
        if (!Array.isArray(res?.data)) throw new Error("Malformed thread list response");
        const newThreads: SessionInfo[] = res.data.slice(0, 100)
          .map((t) => ({
            threadId: boundedString(t?.id, 256),
            title: boundedString(t?.name || t?.preview, 200) || "（无标题会话）",
            updatedAt: typeof t?.updatedAt === "number" && Number.isFinite(t.updatedAt) ? t.updatedAt : 0,
          }))
          .filter((s: SessionInfo) => s.threadId && !deletedThreads.has(s.threadId));
        const nextCursor = typeof res?.nextCursor === "string" && res.nextCursor && res.nextCursor !== cursor
          ? res.nextCursor.slice(0, 512)
          : null;
        // The visible list may contain a retained, not-yet-revalidated tail
        // from a lifecycle refresh. Insert this authoritative page immediately
        // after the verified prefix. If traversal is now exhausted, discard any
        // residual tail because the fresh walk is authoritative and complete.
        const currentSessions = get().sessions;
        const pageById = new Map(newThreads.map((session) => [session.threadId, session]));
        for (const session of newThreads) localSessions.delete(session.threadId);
        const localVisible = currentSessions.filter((session) => localSessions.has(session.threadId));
        const verified: SessionInfo[] = [];
        const verifiedIds = new Set<string>();
        for (const session of currentSessions) {
          if (!sessionFreshPrefixIds.has(session.threadId) || verifiedIds.has(session.threadId)) continue;
          verified.push(pageById.get(session.threadId) ?? session);
          verifiedIds.add(session.threadId);
        }
        for (const session of newThreads) {
          if (verifiedIds.has(session.threadId)) continue;
          verified.push(session);
          verifiedIds.add(session.threadId);
        }
        const retainedTail = nextCursor === null ? [] : currentSessions.filter((session) =>
          !localSessions.has(session.threadId) && !verifiedIds.has(session.threadId) &&
          !pageById.has(session.threadId) && !deletedThreads.has(session.threadId));
        sessionFreshPrefixIds = verifiedIds;
        sessionWindowContext = context;
        set({
          sessions: [...localVisible, ...verified, ...retainedTail],
          sessionCursor: nextCursor,
          sessionLoadingMore: false,
          sessionLoad: loadedStatus(),
        });
      } catch (error) {
        if (seq === sessionRequestSeq && generation === gateway.generation) {
          set({ sessionLoadingMore: false, sessionLoad: loadFailure("更多会话读取失败", error) });
        }
      }
    },

    setSessionSearch(term: string) {
      // Invalidate an in-flight query immediately; waiting until the debounce
      // callback lets old results flash under the new search term.
      sessionRequestSeq += 1;
      resetSessionWindow();
      set({
        sessionSearch: term.slice(0, 200), sessions: [], sessionCursor: null,
        sessionLoading: false, sessionLoadingMore: false, sessionLoad: loadingStatus(),
      });
      // Debounce the actual query so rapid typing doesn't flood the server.
      if (sessionSearchTimer !== null) clearTimeout(sessionSearchTimer);
      sessionSearchTimer = window.setTimeout(() => {
        sessionSearchTimer = null;
        void get().refreshSessions();
      }, 300);
    },

    setSessionArchived(archived: boolean) {
      // Reset list state — mixing active and archived cursors corrupts pagination.
      resetSessionWindow();
      set({ sessionArchived: archived, sessions: [], sessionCursor: null, sessionLoad: loadingStatus() });
      void get().refreshSessions();
    },

    async unarchiveThread(threadId) {
      try {
        await gateway.rpc("thread/unarchive", { threadId });
      } catch (error) {
        throw new Error(loadFailure("恢复失败", error).error ?? "恢复失败");
      }
      set((s) => ({ sessions: s.sessions.filter((x) => x.threadId !== threadId) }));
    },

    async refreshProjects() {
      const seq = ++projectRequestSeq;
      const generation = gateway.generation;
      set({ projectsLoad: loadingStatus() });
      try {
        const res = await gateway.rpc<any>("projects/list");
        if (seq !== projectRequestSeq || generation !== gateway.generation) return;
        if (!Array.isArray(res?.projects)) throw new Error("Malformed project list response");
        const projects: ProjectEntry[] = res.projects
          .slice(0, 1_000)
          .map((entry: any) => ({
            path: boundedString(entry?.path, 4096),
            addedAt: typeof entry?.addedAt === "number" && Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
            lastUsedAt: typeof entry?.lastUsedAt === "number" && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0,
            available: entry?.available !== false,
          }))
          .filter((entry: ProjectEntry) => entry.path);
        const previous = get().currentProject;
        const availableProjects = projects.filter((project) => project.available !== false);
        const current = availableProjects.some((project) => project.path === previous)
          ? previous
          : availableProjects[0]?.path ?? "";
        const noAvailableProject = projects.length > 0 && availableProjects.length === 0;
        const projectLoad = noAvailableProject
          ? { state: "error" as const, error: "已登记的项目当前均不可用；请选择或添加一个可访问项目。" }
          : loadedStatus();
        try {
          localStorage.setItem(PROJECT_KEY, current);
        } catch {
          /* ignore */
        }
        if (current !== previous || noAvailableProject) {
          // A project fallback is one atomic scope transition. Invalidate every
          // request that captured the old cwd before publishing the new one;
          // otherwise a delayed Q list/start can commit under selected P.
          sessionRequestSeq += 1;
          projectSelectionSeq += 1;
          openThreadRequestSeq += 1;
          newThreadRequestSeq += 1;
          clearAllHistoryAuxiliary();
          resetSessionWindow();
          const preserveInitialUrlThread = !noAvailableProject && previous === "" && !!get().activeThreadId && current !== "";
          set({
            projects,
            projectsLoad: projectLoad,
            currentProject: current,
            ...(preserveInitialUrlThread ? {} : {
              activeThreadId: null,
              items: {},
              historyLoaded: {}, historyLoading: {},
            }),
            sessions: [],
            sessionCursor: null,
            sessionLoading: false,
            sessionLoadingMore: false,
            sessionLoad: {
              state: "error",
              error: current
                ? "项目范围已变更；请重新加载该项目的会话列表。"
                : "当前没有可用项目；会话列表未加载。",
            },
          });
          if (!preserveInitialUrlThread) syncUrl(null);
        } else {
          set({ projects, currentProject: current, projectsLoad: projectLoad });
        }
      } catch (error) {
        if (seq === projectRequestSeq && generation === gateway.generation) {
          set({ projectsLoad: loadFailure("项目列表读取失败", error) });
        }
      }
    },

    async refreshModels() {
      const generation = ++modelRequestSeq;
      const connectionGeneration = gateway.generation;
      const provider = get().providerMode;
      set({ modelLoad: loadingStatus() });
      try {
        const all: ModelInfo[] = [];
        const seen = new Set<string>();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        let truncated = false;
        const MAX_PAGES = 5;
        const MAX_MODELS = 500;
        const MAX_ELAPSED_MS = 5_000;
        const startedAt = Date.now();
        for (let page = 0; page < MAX_PAGES; page++) {
          const remainingMs = MAX_ELAPSED_MS - (Date.now() - startedAt);
          if (remainingMs <= 0) { truncated = true; break; }
          const params: Record<string, unknown> = { limit: 100 };
          if (cursor) params.cursor = cursor;
          let timer: number | null = null;
          const res = await Promise.race([
            gateway.request("model/list", params),
            new Promise<never>((_resolve, reject) => {
              timer = window.setTimeout(() => reject(new Error("模型目录请求超过 5 秒预算")), remainingMs);
            }),
          ]).finally(() => { if (timer !== null) clearTimeout(timer); });
          if (generation !== modelRequestSeq || connectionGeneration !== gateway.generation || provider !== get().providerMode) return;
          if (!Array.isArray(res?.data)) throw new Error("Malformed model list response");
          for (const m of res.data.slice(0, 100)) {
            const id = boundedString(m?.id, MAX_MODEL_ID_LENGTH);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            all.push({ id, displayName: boundedString(m?.displayName, 256) || id,
              reasoningEfforts: normalizeReasoningEfforts(Array.isArray(m?.supportedReasoningEfforts)
                ? m.supportedReasoningEfforts.slice(0, 1_024).map((entry) => entry?.reasoningEffort)
                : []),
              defaultReasoningEffort: normalizeReasoningEfforts([m?.defaultReasoningEffort])[0], isDefault: m?.isDefault === true });
            if (all.length >= MAX_MODELS) break;
          }
          const nextCursor = boundedString(res?.nextCursor, 512) || null;
          if (!nextCursor || seenCursors.has(nextCursor)) {
            cursor = null;
            break;
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
          if (all.length >= MAX_MODELS || page === MAX_PAGES - 1 || Date.now() - startedAt >= MAX_ELAPSED_MS) {
            truncated = true;
            break;
          }
        }
        if (generation === modelRequestSeq && connectionGeneration === gateway.generation && provider === get().providerMode) {
          set({
            models: all,
            modelLoad: truncated
              ? { state: "error", error: `模型目录超过有界加载预算（最多 ${MAX_PAGES} 页 / ${MAX_MODELS} 项 / ${MAX_ELAPSED_MS / 1_000} 秒）；已保留当前有效结果，可重试。` }
              : loadedStatus(),
          });
          modelsLoadedFor = provider;
          const settings = get().settings;
          // A partial catalog cannot prove a previously selected model is gone.
          const selectedModel = !truncated && settings.selectedModel && !seen.has(settings.selectedModel) ? "" : settings.selectedModel;
          const availableEfforts = selectedModelEfforts(all, selectedModel);
          const selectedEffort = !truncated && settings.selectedEffort && !availableEfforts.includes(settings.selectedEffort) ? "" : settings.selectedEffort;
          if (selectedModel !== settings.selectedModel || selectedEffort !== settings.selectedEffort) {
            const next = normalizeSettings({ ...settings, selectedModel, selectedEffort });
            saveSettings(next);
            set({ settings: next });
          }
        }
      } catch (error) {
        if (generation === modelRequestSeq && connectionGeneration === gateway.generation && provider === get().providerMode) {
          // Transient failure under the SAME provider: keep the list. Under a
          // DIFFERENT provider it would be stale (wrong endpoint's models)
          // — drop it so selectors fall back to 默认模型 until a reload works.
          if (modelsLoadedFor !== null && modelsLoadedFor !== get().providerMode) {
            console.warn("[webui] model list failed for the new provider — dropping stale list");
            set({ models: [] });
            modelsLoadedFor = null;
          }
          set({ modelLoad: loadFailure("模型目录读取失败", error) });
        }
      }
    },

    async refreshMcp() {
      const seq = ++mcpRequestSeq;
      const generation = gateway.generation;
      set({ mcpLoad: loadingStatus() });
      try {
        const res = await gateway.request("mcpServerStatus/list", undefined);
        if (seq !== mcpRequestSeq || generation !== gateway.generation) return;
        if (!Array.isArray(res?.data)) throw new Error("Malformed MCP status response");
        const names = new Set<string>();
        const mcpServers: McpServerView[] = [];
        for (const entry of res.data.slice(0, 200)) {
          const name = boundedString(entry?.name, 256);
          if (!name || names.has(name)) continue;
          names.add(name);
          const toolSource = entry?.tools && typeof entry.tools === "object" && !Array.isArray(entry.tools)
            ? entry.tools as Record<string, unknown> : null;
          const tools: McpServerView["tools"] = [];
          let toolCount = 0;
          let toolsTruncated = false;
          // Avoid Object.entries/Object.values here: they materialize every
          // property before a later slice can apply the browser budget.
          if (toolSource) for (const key in toolSource) {
            if (!Object.prototype.hasOwnProperty.call(toolSource, key)) continue;
            toolCount += 1;
            if (toolCount > 500) {
              toolsTruncated = true;
              break;
            }
            const tool = toolSource[key];
            const record = tool && typeof tool === "object" && !Array.isArray(tool) ? tool as Record<string, unknown> : {};
            tools.push({
              name: boundedString(record.name, 256) || boundedString(key, 256) || "（未命名工具）",
              ...(typeof record.description === "string" ? { description: record.description.slice(0, 2_000) } : {}),
            });
          }
          mcpServers.push({
            name,
            initialized: !!entry?.serverInfo && typeof entry.serverInfo === "object" && !Array.isArray(entry.serverInfo) || toolCount > 0,
            toolCount,
            ...(toolsTruncated ? { toolsTruncated: true } : {}),
            tools,
          });
        }
        set({ mcpServers, mcpLoad: loadedStatus() });
      } catch (error) {
        if (seq === mcpRequestSeq && generation === gateway.generation) {
          set({ mcpLoad: loadFailure("MCP 状态读取失败", error) });
        }
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
      if (get().currentProject) await get().refreshSessions();
    },

    async selectProject(path) {
      path = path.trim().slice(0, 4096);
      if (!path) throw new Error("项目路径不能为空");
      const selection = ++projectSelectionSeq;
      const generation = gateway.generation;
      let target = get().projects.find((project) => project.path === path);
      if (!target) {
        await get().refreshProjects();
        if (selection !== projectSelectionSeq || generation !== gateway.generation) return;
        target = get().projects.find((project) => project.path === path);
      }
      if (!target || target.available === false) throw new Error("该项目当前不可用，未切换会话上下文");
      // Adding the very first project makes refreshProjects select it before
      // ProjectPicker reaches this call. The project is already current, but
      // its session list has never been loaded.
      if (path === get().currentProject) {
        await get().refreshSessions();
        return;
      }
      // Touch is part of selection. Do not publish a cwd that the gateway has
      // already rejected or forgotten.
      await gateway.rpc("projects/touch", { path });
      if (selection !== projectSelectionSeq || generation !== gateway.generation) return;
      target = get().projects.find((project) => project.path === path);
      if (!target || target.available === false) throw new Error("项目在切换期间变为不可用，仍保留当前项目");
      sessionRequestSeq += 1;
      openThreadRequestSeq += 1;
      newThreadRequestSeq += 1;
      clearAllHistoryAuxiliary();
      resetSessionWindow();
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
        sessionLoad: loadingStatus(),
      });
      syncUrl(null);
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
      if (typeof patch.autoCompactThreshold === "number" && Number.isFinite(patch.autoCompactThreshold) && patch.autoCompactThreshold >= 0 && patch.autoCompactThreshold < 1) validated.autoCompactThreshold = patch.autoCompactThreshold;
      if (!Object.keys(validated).length) return;
      // Only send the requested fields. A stale tab must not overwrite other
      // browsers' unrelated preferences. No optimistic state to roll back.
      const intent = ++displayWriteIntentSeq;
      const generation = gateway.generation;
      const runtime = runtimeVersion;
      displayReadSeq += 1;
      displayPendingWrites += 1;
      set({ displayError: null });
      // The ordered displayPrefs/updated broadcast is authoritative. A full
      // RPC snapshot could be older than a different tab's later broadcast.
      const write = displayWriteTail.then(async () => {
        if (generation !== gateway.generation || runtime !== runtimeVersion) {
          if (intent === displayWriteIntentSeq) set({ displayError: "设置未保存：连接或服务状态已经变化，请重试。" });
          return;
        }
        try {
          await gateway.rpc("displayPrefs/set", validated);
        } catch (error) {
          if (intent === displayWriteIntentSeq && generation === gateway.generation && runtime === runtimeVersion) {
            set({ displayError: loadFailure("设置未保存", error).error });
          }
        }
      }).finally(() => { displayPendingWrites = Math.max(0, displayPendingWrites - 1); });
      displayWriteTail = write.catch(() => {});
    },

    dismissGlobalWarning(id) {
      set((state) => ({ globalWarnings: state.globalWarnings.filter((warning) => warning.id !== id) }));
    },

    async checkSendOperation(threadId, clientOperationId) {
      const operationId = clientOperationId ?? get().sendOperations[threadId]?.clientOperationId;
      if (!operationId || !/^[a-z0-9-]{36}$/i.test(operationId)) return;
      const existingFlight = sendOperationCheckFlights.get(operationId);
      if (existingFlight) return existingFlight;
      const flight = (async (): Promise<SendOperation | undefined> => {
      const state = get();
      const lookupRuntime = runtimeVersion;
      const lookupGeneration = gateway.generation;
      const lookupActivityVersion = activityVersions.get(threadId) ?? 0;
      const current = state.sendOperations[threadId];
      const tracked = clientOperationId
        ? state.sendOperationRecords[clientOperationId] ?? (current?.clientOperationId === clientOperationId ? current : undefined)
        : current;
      // A mounted Composer can still own an older operation after another tab
      // replaces the compact thread selection. Query that captured immutable
      // ID, but do not recreate or overwrite durable state unless it is still
      // tracked locally.
      const operation: SendOperation | undefined = tracked ??
        (clientOperationId ? { threadId, clientOperationId, state: "unknown" } : undefined);
      if (!operation || operation.threadId !== threadId || operation.state !== "unknown") return;
      try {
        const result = await gateway.rpc<{ state: SendOperation["state"]; error?: string }>("turn/operation", { clientOperationId: operation.clientOperationId });
        if (!["accepted", "not_received", "rejected", "unknown"].includes(result?.state)) return;
        const latestState = get();
        const selected = latestState.sendOperations[threadId];
        const latest = latestState.sendOperationRecords[operation.clientOperationId] ??
          (selected?.clientOperationId === operation.clientOperationId ? selected : undefined);
        if (latest && latest.state !== "unknown") return latest;
        const checked = { ...operation, state: result.state, error: boundedString(result.error, 1_000) || undefined };
        if (latest?.clientOperationId === operation.clientOperationId) {
          try { saveSendOperation(checked); } catch { /* Keep the checked result in memory; stale durable unknown remains safe. */ }
          set((currentState) => {
            const currentSelected = currentState.sendOperations[threadId];
            const currentExact = currentState.sendOperationRecords[operation.clientOperationId] ??
              (currentSelected?.clientOperationId === operation.clientOperationId ? currentSelected : undefined);
            if (!currentExact || currentExact.state !== "unknown") return {};
            const sendOperationRecords = {
              ...mergedSendOperationRecords(currentState),
              [operation.clientOperationId]: { ...currentExact, state: result.state, error: boundedString(result.error, 1_000) || undefined },
            };
            return { sendOperationRecords, sendOperations: selectThreadOperations(sendOperationRecords) };
          });
        }

        // turn/operation answers admission, not whether an accepted turn is
        // still running. A lost turn/start response can also coincide with a
        // lost turn/started notification, so keep the optimistic activity lock
        // until a definitive rejection or an authoritative thread snapshot
        // says otherwise. Only the currently selected operation may reconcile
        // thread-wide activity; checking an older same-thread record must not
        // unlock a newer send from another tab.
        const selectedAfterCheck = get().sendOperations[threadId];
        if (
          selectedAfterCheck?.clientOperationId === operation.clientOperationId &&
          lookupRuntime === runtimeVersion &&
          lookupGeneration === gateway.generation &&
          !deletedThreads.has(threadId)
        ) {
          if (result.state === "accepted") {
            const reconciliationActivityVersion = activityVersions.get(threadId) ?? 0;
            try {
              const snapshot = await gateway.request("thread/read", { threadId, includeTurns: false });
              const statusType = snapshot?.thread?.status?.type;
              if (
                lookupRuntime === runtimeVersion &&
                lookupGeneration === gateway.generation &&
                reconciliationActivityVersion === (activityVersions.get(threadId) ?? 0) &&
                !deletedThreads.has(threadId) &&
                ["active", "idle", "notLoaded", "systemError"].includes(statusType)
              ) {
                const active = statusType === "active";
                set((currentState) => {
                  const selected = currentState.sendOperations[threadId];
                  if (selected?.clientOperationId !== operation.clientOperationId || selected.state !== "accepted") return {};
                  return {
                    turnActive: { ...currentState.turnActive, [threadId]: active },
                    ...(!active ? { activeTurnId: { ...currentState.activeTurnId, [threadId]: null } } : {}),
                  };
                });
              }
            } catch {
              // Admission is known but activity is not. Keep the conservative
              // lock; notifications, an explicit stop, or a reload can safely
              // reconcile it without risking an overlapping turn.
            }
          } else if (
            (result.state === "not_received" || result.state === "rejected") &&
            lookupActivityVersion === (activityVersions.get(threadId) ?? 0)
          ) {
            set((currentState) => {
              const selected = currentState.sendOperations[threadId];
              if (selected?.clientOperationId !== operation.clientOperationId || selected.state !== result.state) return {};
              return {
                turnActive: { ...currentState.turnActive, [threadId]: false },
                activeTurnId: { ...currentState.activeTurnId, [threadId]: null },
              };
            });
          }
        }
        if (get().sendOperationOverflow && result.state !== "unknown") {
          window.setTimeout(() => reconcileStoredSendOperations(), 0);
        }
        return checked;
      } catch { /* Retain unknown until the same operation can be reconciled. */ }
      })();
      sendOperationCheckFlights.set(operationId, flight);
      try { return await flight; }
      finally {
        if (sendOperationCheckFlights.get(operationId) === flight) sendOperationCheckFlights.delete(operationId);
      }
    },

    acknowledgeUnknownSend(threadId, clientOperationId) {
      const state = get();
      const selected = state.sendOperations[threadId];
      const operation = state.sendOperationRecords[clientOperationId] ??
        (selected?.clientOperationId === clientOperationId ? selected : undefined);
      if (!operation || operation.threadId !== threadId || operation.state !== "unknown") return false;
      const acknowledged: SendOperation = { ...operation, state: "acknowledged_unknown" };
      // A local release is not evidence of acceptance/rejection. Keep the
      // original ID recorded and never mutate/retry its server-side ledger.
      try { saveSendOperation(acknowledged); } catch { return false; }
      set((currentState) => {
        const sendOperationRecords = {
          ...mergedSendOperationRecords(currentState),
          [clientOperationId]: acknowledged,
        };
        return {
          sendOperationRecords,
          sendOperations: selectThreadOperations(sendOperationRecords),
          items: { ...currentState.items, [threadId]: (currentState.items[threadId] ?? []).filter((item) => item.type !== "localUserMessage" || item.clientOperationId !== clientOperationId) },
        };
      });
      if (get().sendOperationOverflow) reconcileStoredSendOperations();
      return true;
    },

    async checkThreadCreateOperation() {
      if (threadCreateCheckFlight) return threadCreateCheckFlight;
      let settleCheck!: (value: ThreadCreateOperation | null) => void;
      threadCreateCheckFlight = new Promise((resolve) => { settleCheck = resolve; });
      try {
        const operation = get().threadCreateOperation;
        if (!operation || operation.state !== "unknown") return operation;
        try {
        const result = await gateway.request("thread/start/operation", {
          clientOperationId: operation.clientOperationId,
        });
        if (get().threadCreateOperation?.clientOperationId !== operation.clientOperationId) {
          return get().threadCreateOperation;
        }
        if (!result || typeof result !== "object" ||
            !["not_received", "unknown", "rejected", "accepted"].includes(result.state)) {
          throw new Error("网关返回了无效的会话创建收据");
        }
        if (result.state === "accepted") {
          const threadId = boundedString(result.threadId, 256);
          const cwd = boundedString(result.cwd, 4096);
          if (!threadId || cwd !== operation.cwd) throw new Error("会话创建收据身份或项目不匹配");
          const accepted: ThreadCreateOperation = { ...operation, state: "accepted", threadId };
          set({ threadCreateOperation: accepted });
          const activated = cwd === get().currentProject && await activateCreatedThread(threadId, cwd);
          try { saveThreadCreateOperation(activated ? null : accepted); }
          catch { /* the accepted state remains visible for this browser lifetime */ }
          return accepted;
        }
        if (result.state === "not_received" || result.state === "rejected") {
          const next: ThreadCreateOperation = {
            ...operation,
            state: result.state,
            error: result.state === "not_received"
              ? "网关确认未收到该创建操作，可以安全重试。"
              : boundedString(result.error, 1_000) || "网关拒绝了该创建操作，可以修正后重试。",
          };
          try { saveThreadCreateOperation(null); } catch { /* stale local evidence remains conservative after reload */ }
          set({ threadCreateOperation: next });
          return next;
        }
        const next: ThreadCreateOperation = {
          ...operation,
          error: boundedString(result.error, 1_000) || "会话创建结果仍未知；不会自动重试。",
        };
        set({ threadCreateOperation: next });
        return next;
        } catch (error) {
          if (get().threadCreateOperation?.clientOperationId !== operation.clientOperationId) return get().threadCreateOperation;
          const next: ThreadCreateOperation = {
            ...operation,
            error: loadFailure("会话创建状态核对失败", error).error ?? "会话创建状态核对失败",
          };
          set({ threadCreateOperation: next });
          return next;
        }
      } finally {
        const result = get().threadCreateOperation;
        threadCreateCheckFlight = null;
        settleCheck(result);
      }
    },

    acknowledgeUnknownThreadCreate(clientOperationId) {
      const operation = get().threadCreateOperation;
      if (!operation || operation.clientOperationId !== clientOperationId || operation.state !== "unknown") return false;
      const acknowledged: ThreadCreateOperation = { ...operation, state: "acknowledged_unknown" };
      try { saveThreadCreateOperation(acknowledged); } catch { return false; }
      set({ threadCreateOperation: acknowledged });
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

    readAttachment(path, signal) {
      return queueAttachmentRead(path, signal);
    },

    deleteAttachment(path) {
      return gateway.rpc("attachment/delete", { path }).then(() => undefined);
    },

    async openThread(threadId) {
      threadId = boundedString(threadId, 256);
      if (!threadId || deletedThreads.has(threadId)) return;
      const fromHistory = historyNavigationTarget === threadId;
      if (fromHistory) historyNavigationTarget = undefined;
      overflowThreads.delete(threadId);
      newThreadRequestSeq += 1;
      const requestSeq = ++openThreadRequestSeq;
      const generation = gateway.generation;
      const previous = get().activeThreadId;
      if (previous && previous !== threadId) {
        const previousOwner = historyLoadOwners.get(previous);
        if (previousOwner) releaseHistoryLoad(previous, previousOwner);
        else {
          pendingHistoryDeltas.delete(previous);
          historyStarts.delete(previous);
        }
        set((s) => ({ historyLoading: { ...s.historyLoading, [previous]: false } }));
      }
      set({ activeThreadId: threadId, sidebarOpen: false });
      if (!fromHistory) syncUrl(threadId, "push");
      if (get().historyLoaded[threadId]) return;
      const previousOwner = historyLoadOwners.get(threadId);
      if (previousOwner) releaseHistoryLoad(threadId, previousOwner);
      else {
        pendingHistoryDeltas.delete(threadId);
        historyStarts.delete(threadId);
      }
      // A new authoritative snapshot supersedes uncertainty retained by an
      // earlier completed load for this thread.
      pausedStreams.delete(threadId);
      const loadOwner = Symbol(`history:${requestSeq}`);
      historyLoadOwners.set(threadId, loadOwner);
      historyStarts.set(threadId, new Set());
      set((s) => ({ historyLoading: { ...s.historyLoading, [threadId]: true } }));
      let preservePaused = false;
      let terminalConsistencyRereads = 0;
      let terminalObservedDuringLoad = false;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
            // Activate first so output is subscribed before reading the full
            // snapshot. Do not enable sending until activation completes.
            let activationError: unknown;
            try { await gateway.request("thread/resume", { threadId }); }
            catch (error) { activationError = error; }
            if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
            const activityVersion = activityVersions.get(threadId) ?? 0;
            const terminalEpochBefore = historyTerminalEpochs.get(threadId) ?? 0;
            const response: unknown = await gateway.request("thread/read", { threadId, includeTurns: true });
            if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
            const projection = projectThreadReadResponse(response, threadId);
            flushDeltas();
            if (get().activeThreadId === threadId) {
              const projectChanged = projection.cwd !== get().currentProject;
              const projectedProject = get().projects.find((project) => project.path === projection.cwd && project.available !== false);
              if (projectChanged && !projectedProject) {
                // Never retain a thread from cwd Q while the selected/usable
                // project is P. The project registry is authoritative for new
                // work; make the navigation failure explicit and leave P whole.
                sessionRequestSeq += 1;
                newThreadRequestSeq += 1;
                resetSessionWindow();
                set((state) => ({
                  activeThreadId: null,
                  historyLoading: { ...state.historyLoading, [threadId]: false },
                  sessionLoad: {
                    state: "error",
                    error: `会话所属项目当前不可用：${boundedString(projection.cwd, 512)}。未切换项目。`,
                  },
                }));
                syncUrl(null);
                return;
              }
              const terminalChanged = (historyTerminalEpochs.get(threadId) ?? 0) !== terminalEpochBefore;
              if (terminalChanged) terminalObservedDuringLoad = true;
              // A terminal event can arrive after the app-server chose its
              // read snapshot but before the response reaches us. Re-read
              // once with fresh stream evidence rather than committing the
              // stale in-progress snapshot indefinitely.
              if (terminalChanged && terminalConsistencyRereads < 1 && attempt < 2) {
                terminalConsistencyRereads += 1;
                pendingHistoryDeltas.delete(threadId);
                historyStarts.set(threadId, new Set());
                pausedStreams.delete(threadId);
                continue;
              }
              const items = projection.items;
              const uncertain = pendingHistoryDeltas.get(threadId);
              const terminalRaceUnresolved = terminalChanged;
              if (uncertain?.size && !terminalRaceUnresolved) {
                pausedStreams.set(threadId, new Set(uncertain));
                preservePaused = true;
                items.push({ ...makeErrorItem("重连期间的流片段没有序号，无法与快照安全对齐；暂时显示快照，等待完整条目或任务结束后刷新。"), threadId });
              }
              if (terminalRaceUnresolved) {
                items.push({ ...makeErrorItem("会话在历史加载期间结束，但一次一致性重读仍被更新事件追越；已保留当前快照，重新选择会话可再次核对。"), threadId, historyLoadError: true });
              }
              if (activationError) {
                const detail = loadFailure("会话无法激活", activationError).error ?? "会话无法激活";
                items.push({ ...makeErrorItem(`历史已加载，但${detail}（重新选择可重试）`, false), threadId, historyLoadError: true });
              }
              const unchanged = !terminalObservedDuringLoad && activityVersion === (activityVersions.get(threadId) ?? 0);
              if (projectChanged) {
                sessionRequestSeq += 1;
                projectSelectionSeq += 1;
                newThreadRequestSeq += 1;
                resetSessionWindow();
              }
              set((s) => ({
                items: { ...s.items, [threadId]: mergeHistory(items, (s.items[threadId] ?? []).filter((item) => item.type !== "errorItem" || !item.historyLoadError), historyStarts.get(threadId) ?? new Set()) },
                historyLoaded: { ...s.historyLoaded, [threadId]: !activationError && !terminalRaceUnresolved },
                historyLoading: { ...s.historyLoading, [threadId]: false },
                ...(unchanged ? {
                  turnActive: { ...s.turnActive, [threadId]: projection.statusType === "active" || !!projection.runningTurnId },
                  activeTurnId: { ...s.activeTurnId, [threadId]: projection.runningTurnId },
                } : s.turnActive[threadId] && !s.activeTurnId[threadId] && projection.runningTurnId ? {
                  activeTurnId: { ...s.activeTurnId, [threadId]: projection.runningTurnId },
                } : {}),
                ...(projectChanged ? { currentProject: projection.cwd, sessions: [], sessionCursor: null, sessionLoad: loadingStatus() } : {}),
              }));
              // The snapshot commit is the last consumer of starts/pending.
              // Release before the unrelated session-list refresh, which may
              // be slow or never settle on a broken connection.
              releaseHistoryLoad(threadId, loadOwner, preservePaused);
              if (projectChanged) {
                try { localStorage.setItem(PROJECT_KEY, projection.cwd); } catch { /* storage unavailable */ }
                await get().refreshSessions();
              }
            }
            return;
          } catch (err: unknown) {
            if (requestSeq !== openThreadRequestSeq || generation !== gateway.generation) return;
            if (attempt === 2) {
              // Never swallow a failed history load silently — that showed up
              // as "refresh loses all messages". Surface it and retry on click.
              const message = err instanceof Error ? err.message : String(err);
              appendToThread(threadId, {
                ...makeErrorItem(`会话历史加载失败: ${message}（切换会话后重进可重试）`),
                historyLoadError: true,
              });
              set((s) => ({ historyLoading: { ...s.historyLoading, [threadId]: false } }));
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
      } finally {
        if (releaseHistoryLoad(threadId, loadOwner, preservePaused) && get().historyLoading[threadId]) {
          set((s) => ({ historyLoading: { ...s.historyLoading, [threadId]: false } }));
        }
      }
    },

    newThread() {
      if (newThreadFlight) return newThreadFlight;
      const task = (async (): Promise<string | null> => {
        const { currentProject, settings, projects, threadCreateOperation } = get();
        if (!currentProject || !projects.some((project) => project.path === currentProject && project.available !== false)) {
          throw new Error("当前没有可用项目，会话未创建");
        }
        if (threadCreateOperation?.state === "unknown") {
          throw new Error("上一次会话创建结果未知；请先核对状态，不能重复创建");
        }
        const requestSeq = ++newThreadRequestSeq;
        const generation = gateway.generation;
        const clientOperationId = operationId();
        const operation: ThreadCreateOperation = { clientOperationId, cwd: currentProject, state: "unknown" };
        try { saveThreadCreateOperation(operation); }
        catch { throw new Error("浏览器无法保存会话创建标识，会话未创建；请允许本站本地存储后重试"); }
        set({ threadCreateOperation: operation });
        const params: Pick<ThreadStartParams, "cwd" | "model" | "approvalPolicy"> & { clientOperationId: string } = {
          cwd: currentProject,
          clientOperationId,
        };
        // A selection is sent only when it belongs to the current provider's
        // validated cache. Catalog failure falls back to server defaults.
        const models = get().models;
        if (settings.selectedModel && models.some((model) => model.id === settings.selectedModel)) {
          params.model = settings.selectedModel;
        }
        if (settings.selectedApprovalPolicy) params.approvalPolicy = settings.selectedApprovalPolicy;
        let res;
        try {
          res = await gateway.request("thread/start", params);
        } catch (error: any) {
          const definitive = error?.delivery === "not_sent" || error?.delivery === "rejected";
          const failed: ThreadCreateOperation = {
            ...operation,
            state: definitive ? "rejected" : "unknown",
            error: definitive
              ? boundedString(error?.message, 1_000) || "会话创建未派发，可以重试。"
              : `${boundedString(error?.message, 1_000) || "连接中断"}。创建结果未知；不会自动重试。`,
          };
          if (definitive) {
            try { saveThreadCreateOperation(null); } catch { /* a reload will reconcile the stale identifier */ }
          }
          set({ threadCreateOperation: failed });
          throw new Error(failed.error);
        }
        const threadId = boundedString(res?.thread?.id, 256);
        if (!threadId || res?.clientOperationId !== clientOperationId) {
          const unknown: ThreadCreateOperation = {
            ...operation,
            error: "thread/start 返回的会话或操作身份无效；创建结果未知，不会自动重试。",
          };
          set({ threadCreateOperation: unknown });
          throw new Error(unknown.error);
        }
        const accepted: ThreadCreateOperation = { ...operation, state: "accepted", threadId };
        set({ threadCreateOperation: accepted });
        if (
          requestSeq !== newThreadRequestSeq || generation !== gateway.generation ||
          currentProject !== get().currentProject
        ) {
          // Acceptance is known, but navigation moved. Never redirect or send
          // a draft across project/generation boundaries.
          try { saveThreadCreateOperation(accepted); } catch { /* in-memory confirmation remains visible */ }
          if (currentProject === get().currentProject) void get().refreshSessions().catch(() => {});
          return null;
        }
        let storageCleared = true;
        try { saveThreadCreateOperation(null); } catch { storageCleared = false; }
        void gateway.rpc("projects/touch", { path: currentProject }).catch(() => {});
        await activateCreatedThread(threadId, currentProject);
        if (storageCleared && get().threadCreateOperation?.clientOperationId === clientOperationId) {
          set({ threadCreateOperation: null });
        }
        return threadId;
      })();
      const flight = task.finally(() => { if (newThreadFlight === flight) newThreadFlight = null; });
      newThreadFlight = flight;
      return flight;
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
      if (get().sendOperationOverflow) {
        throw new Error("本地待核对发送记录超过浏览器预算；为避免重复执行，已暂停新发送。请先核对已有记录");
      }
      const existingRecords = mergedSendOperationRecords(get());
      let threadUnknown = false;
      let unknownCount = 0;
      for (const id in existingRecords) {
        if (!Object.prototype.hasOwnProperty.call(existingRecords, id)) continue;
        const entry = existingRecords[id];
        if (entry.state !== "unknown") continue;
        unknownCount += 1;
        if (entry.threadId === threadId) threadUnknown = true;
      }
      if (threadUnknown) {
        throw new Error("上一条消息是否已受理尚未确认；请先核对发送状态，不能重复发送");
      }
      if (unknownCount >= MAX_UNKNOWN_SEND_OPERATIONS) {
        throw new Error("待确认发送过多，请先核对已有会话");
      }
      const clientOperationId = operationId();
      const operation: SendOperation = { clientOperationId, threadId, state: "unknown" };
      try { saveSendOperation(operation); }
      catch { throw new Error("浏览器无法保存发送标识，消息未发送；请允许本站本地存储后重试"); }
      const pendingRecords = { ...existingRecords };
      // The replacement ID is already durable. Prune only same-thread records
      // that no longer block sending; every unresolved ID is preserved. A
      // failed cleanup can leave harmless historical localStorage evidence but
      // must not create a phantom "unsent" replacement.
      for (const id in pendingRecords) {
        if (!Object.prototype.hasOwnProperty.call(pendingRecords, id)) continue;
        const prior = pendingRecords[id];
        if (prior.threadId !== threadId || prior.state === "unknown") continue;
        delete pendingRecords[prior.clientOperationId];
        if (prior.state === "acknowledged_unknown") {
          try { localStorage.removeItem(`${OPERATIONS_KEY}${prior.clientOperationId}`); } catch { /* harmless stale acknowledgment */ }
        }
      }
      pendingRecords[clientOperationId] = operation;
      // Bind UI ownership only after a real thread and durable operation exist,
      // but before any observable state change or asynchronous delivery.
      onOperation?.({ threadId, clientOperationId });
      set({ sendOperationRecords: pendingRecords, sendOperations: selectThreadOperations(pendingRecords) });
      const activityVersion = (activityVersions.get(threadId) ?? 0) + 1;
      setActivityVersion(threadId, activityVersion);
      const atts = attachments ?? [];
      // The Composer keeps the originals while delivery remains retryable.
      // Give the optimistic timeline distinct owners so either side can be
      // released independently without invalidating the other's preview.
      const timelineAttachments = atts.map((attachment) => retainTimelineAttachment(attachment));
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      set((s) => ({
        turnActive: { ...s.turnActive, [threadId]: true },
        items: {
          ...s.items,
          [threadId]: [
            ...(s.items[threadId] ?? []),
            { id: localId, type: "localUserMessage", text, threadId, attachments: timelineAttachments, clientOperationId },
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
        const state = get();
        const selected = state.sendOperations[threadId];
        const exact = state.sendOperationRecords[clientOperationId] ??
          (selected?.clientOperationId === clientOperationId ? selected : undefined);
        if (!exact || exact.state === "acknowledged_unknown" || exact.state === "accepted") return;
        const accepted: SendOperation = { ...exact, state: "accepted" };
        try { saveSendOperation(accepted); } catch { /* Keep durable unknown; it resolves safely on next load. */ }
        set((currentState) => {
          const currentSelected = currentState.sendOperations[threadId];
          const currentExact = currentState.sendOperationRecords[clientOperationId] ??
            (currentSelected?.clientOperationId === clientOperationId ? currentSelected : undefined);
          if (!currentExact || currentExact.state === "acknowledged_unknown" || currentExact.state === "accepted") return {};
          const sendOperationRecords = {
            ...mergedSendOperationRecords(currentState),
            [clientOperationId]: { ...currentExact, state: "accepted" as const },
          };
          return { sendOperationRecords, sendOperations: selectThreadOperations(sendOperationRecords) };
        });
      } catch (err: any) {
        const state = get();
        const selected = state.sendOperations[threadId];
        const exact = state.sendOperationRecords[clientOperationId] ??
          (selected?.clientOperationId === clientOperationId ? selected : undefined);
        if (!exact || exact.state === "acknowledged_unknown") throw err;
        if (exact.state === "accepted") return;
        const definitive = err?.delivery === "not_sent" || err?.delivery === "rejected" && err?.code !== "OPERATION_UNKNOWN";
        const failed: SendOperation = { ...exact, state: definitive ? "rejected" : "unknown", error: String(err?.message ?? err).slice(0, 1000) };
        try { saveSendOperation(failed); } catch { /* Do not lose the in-memory lock. */ }
        set((currentState) => {
          const currentSelected = currentState.sendOperations[threadId];
          const currentExact = currentState.sendOperationRecords[clientOperationId] ??
            (currentSelected?.clientOperationId === clientOperationId ? currentSelected : undefined);
          if (!currentExact || currentExact.state === "acknowledged_unknown" || currentExact.state === "accepted") return {};
          const sendOperationRecords = {
            ...mergedSendOperationRecords(currentState),
            [clientOperationId]: { ...currentExact, state: failed.state, error: failed.error },
          };
          return { sendOperationRecords, sendOperations: selectThreadOperations(sendOperationRecords) };
        });
        if (runtime !== runtimeVersion || deletedThreads.has(threadId)) throw err;
        set((s) => ({
          ...(definitive && activityVersion === activityVersions.get(threadId)
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
        const owner = a.params?.threadId;
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
      } catch (error) {
        throw new Error(loadFailure("重命名失败", error).error ?? "重命名失败");
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
      } catch (error) {
        throw new Error(loadFailure("归档失败", error).error ?? "归档失败");
      }
      forgetThread(threadId);
    },

    async deleteThread(threadId) {
      try {
        await gateway.rpc("thread/delete", { threadId });
      } catch (error) {
        throw new Error(loadFailure("删除失败", error).error ?? "删除失败");
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
      const state = get();
      const approval = state.approvals.find((a) => a.requestId === requestId);
      const key = String(requestId);
      if (!approval || state.approvalSubmissions[key]) return;
      if (decision !== "decline" && !approvalCanAccept(approval, state.items)) return;
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
      // Enqueue is not resolution. Keep the card (and suppress duplicate
      // clicks) until the gateway broadcasts serverRequest/resolved. A
      // rejected answer explicitly unlocks it for a bounded manual retry.
      set((s) => {
        const approvalErrors = { ...s.approvalErrors }; delete approvalErrors[key];
        return { approvalSubmissions: { ...s.approvalSubmissions, [key]: true }, approvalErrors };
      });
      let queued = false;
      try { queued = gateway.respondServerRequest(requestId, payload); }
      catch { /* Treat a synchronous transport failure like a closed socket. */ }
      if (queued) return;
      set((s) => {
        if (!s.approvals.some((entry) => entry.requestId === requestId)) return {};
        return {
          approvalSubmissions: { ...s.approvalSubmissions, [key]: false },
          approvalErrors: { ...s.approvalErrors, [key]: "审批决定未能发送；连接恢复后请重试。" },
        };
      });
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
        const definitive = err?.delivery === "not_sent" || err?.delivery === "rejected";
        if (definitive) {
          set((s) => ({ compacting: { ...s.compacting, [threadId]: false } }));
          appendToThread(threadId, makeErrorItem(`上下文压缩失败: ${err?.message ?? err}`));
        } else {
          // A closed connection or timeout can happen after the server starts
          // compaction. Keep the lock until a completion/failure notification
          // or reconnect refresh proves the state; never submit it twice.
          appendToThread(threadId, makeErrorItem(`上下文压缩结果待确认：${err?.message ?? err}。未自动重试；请等待任务事件或重连后核对。`));
        }
      }
    },

    async startDeviceLogin() {
      if (get().deviceLogin?.status === "waiting") return;
      const runtime = runtimeVersion;
      const attempt = ++deviceLoginAttemptVersion;
      pendingDeviceLoginAttempt = attempt;
      earlyDeviceLoginCompletions.clear();
      set({ deviceLogin: { status: "waiting" } });
      try {
        const res = await gateway.request("account/login/start", { type: "chatgptDeviceCode" });
        if (runtime !== runtimeVersion || attempt !== deviceLoginAttemptVersion) return;
        if (res.type !== "chatgptDeviceCode") throw new Error("服务器未返回设备码登录信息");
        const id = loginId(res.loginId);
        if (!id) throw new Error("服务器返回了无效的设备码登录标识");
        pendingDeviceLoginAttempt = null;
        const early = earlyDeviceLoginCompletions.get(id);
        earlyDeviceLoginCompletions.clear();
        if (early?.attempt === attempt) {
          deviceLoginAttemptVersion += 1;
          set({
            deviceLogin: early.completion.success
              ? null
              : { status: "error", error: boundedString(early.completion.error, 1_000) || "登录失败" },
          });
          return;
        }
        set({
          deviceLogin: {
            status: "waiting",
            loginId: id,
            userCode: boundedString(res?.userCode, 128) || undefined,
            verificationUrl: boundedString(res?.verificationUrl, 2_048) || undefined,
          },
        });
      } catch (err: any) {
        if (runtime !== runtimeVersion || attempt !== deviceLoginAttemptVersion) return;
        pendingDeviceLoginAttempt = null;
        earlyDeviceLoginCompletions.clear();
        const message = boundedString(err?.message, 1_000) || "登录失败";
        const definitive = err?.delivery === "not_sent" || err?.delivery === "rejected";
        set({
          deviceLogin: definitive
            ? { status: "error", error: message }
            : { status: "waiting", error: `设备码登录启动结果待确认：${message}。未自动重试。` },
        });
        if (!definitive) void refreshDeviceLoginStatus();
      }
    },

    async cancelDeviceLogin() {
      const current = get().deviceLogin;
      const id = loginId(current?.loginId);
      if (current?.status !== "waiting" || !id || current.canceling) return;
      const runtime = runtimeVersion;
      const attempt = ++deviceLoginAttemptVersion;
      set({ deviceLogin: { ...current, canceling: true, error: undefined } });
      try {
        const res = await gateway.request("account/login/cancel", { loginId: id });
        const latest = get().deviceLogin;
        if (runtime !== runtimeVersion || attempt !== deviceLoginAttemptVersion ||
            latest?.status !== "waiting" || latest.loginId !== id) return;
        if (res?.status !== "canceled" && res?.status !== "notFound") {
          throw new Error("服务器返回了无效的取消结果");
        }
        deviceLoginAttemptVersion += 1;
        pendingDeviceLoginAttempt = null;
        earlyDeviceLoginCompletions.clear();
        set({ deviceLogin: null });
      } catch (err: any) {
        const latest = get().deviceLogin;
        if (runtime !== runtimeVersion || attempt !== deviceLoginAttemptVersion ||
            latest?.status !== "waiting" || latest.loginId !== id) return;
        const message = boundedString(err?.message, 1_000) || "取消失败";
        const definitive = err?.delivery === "not_sent" || err?.delivery === "rejected";
        set({
          deviceLogin: {
            ...latest,
            canceling: false,
            error: definitive
              ? `取消失败：${message}`
              : `取消结果待确认：${message}。未自动重试。`,
          },
        });
        if (!definitive) void refreshDeviceLoginStatus();
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
