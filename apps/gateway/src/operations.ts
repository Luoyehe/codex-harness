import { createHash } from "node:crypto";
import { mkdirSync, opendirSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";
import { readBoundedRegularTextFileSync } from "./bounded-file.js";

export interface MessageAttachment { path: string; name: string; kind: "file" | "image"; size?: number }
export interface OperationRecord {
  clientOperationId: string;
  state: "accepted" | "unknown" | "rejected";
  fingerprint: string;
  threadId: string;
  turnId?: string;
  error?: string;
  attachments: MessageAttachment[];
}
export class OperationError extends Error {
  readonly delivery: "rejected" | "unknown";
  readonly operationState?: "unknown";
  constructor(message: string, readonly errorCode = "OPERATION_UNKNOWN") {
    super(message);
    this.delivery = errorCode === "OPERATION_REJECTED" ? "rejected" : "unknown";
    if (this.delivery === "unknown") this.operationState = "unknown";
  }
}
const MAX_THREAD_ID = 256;
const MAX_ATTACHMENT_PATH = 4096;
const MAX_ATTACHMENT_NAME = 255;
const MAX_ATTACHMENTS = 32;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_SELECTOR_CHARS = 256;
const MAX_LEDGER_DIRECTORY_ENTRIES = 200_000;
const MAX_METADATA_READS_PER_HISTORY = 128;
const MAX_DECORATED_NOTIFICATION_ITEMS = 4096;
const TURN_START_FIELDS = new Set([
  "clientOperationId", "threadId", "text", "attachments",
  "model", "approvalPolicy", "sandbox", "effort",
]);
const validText = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const validAttachment = (value: any) => value && typeof value === "object" && !Array.isArray(value)
  && validText(value.path, MAX_ATTACHMENT_PATH) && validText(value.name, MAX_ATTACHMENT_NAME) && ["file", "image"].includes(value.kind)
  && (value.size === undefined || Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_ATTACHMENT_BYTES);
function validRecord(entry: any, expectedId?: string): entry is OperationRecord {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    && (expectedId === undefined ? /^[a-zA-Z0-9_-]{16,128}$/.test(entry.clientOperationId) : entry.clientOperationId === expectedId)
    && ["accepted", "rejected", "unknown"].includes(entry.state)
    && typeof entry.fingerprint === "string" && /^[a-f0-9]{64}$/.test(entry.fingerprint)
    && validText(entry.threadId, MAX_THREAD_ID)
    && (entry.turnId === undefined || validText(entry.turnId, MAX_THREAD_ID))
    && (entry.state !== "accepted" || entry.turnId !== undefined)
    && (entry.error === undefined || typeof entry.error === "string" && entry.error.length <= 64 * 1024)
    && Array.isArray(entry.attachments) && entry.attachments.length <= MAX_ATTACHMENTS && entry.attachments.every(validAttachment);
}
function operationSnapshot(params: Record<string, any>): {
  threadId: string;
  attachments: MessageAttachment[];
  fingerprint: string;
  request: Record<string, unknown>;
} {
  for (const key of Object.keys(params)) {
    if (!TURN_START_FIELDS.has(key)) {
      const displayKey = key.length > 128 ? `${key.slice(0, 128)}…` : key;
      throw new OperationError(`turn/start 不支持字段 ${displayKey}，本次发送未派发。`, "OPERATION_REJECTED");
    }
  }
  if (!validText(params.threadId, MAX_THREAD_ID)) throw new OperationError("threadId 无效，本次发送未派发。", "OPERATION_REJECTED");
  if (params.attachments !== undefined && !Array.isArray(params.attachments)) {
    throw new OperationError("attachments 必须是数组，本次发送未派发。", "OPERATION_REJECTED");
  }
  if ((params.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
    throw new OperationError(`附件数量超过 ${MAX_ATTACHMENTS}，本次发送未派发。`, "OPERATION_REJECTED");
  }
  const attachments = (params.attachments ?? []).map((item: any) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !validText(item.path, MAX_ATTACHMENT_PATH)) {
      throw new OperationError("附件路径无效，本次发送未派发。", "OPERATION_REJECTED");
    }
    if (item.name !== undefined && item.name !== null && item.name !== "" && !validText(item.name, MAX_ATTACHMENT_NAME)) {
      throw new OperationError("附件名称无效，本次发送未派发。", "OPERATION_REJECTED");
    }
    if (item.kind !== undefined && item.kind !== "file" && item.kind !== "image") {
      throw new OperationError("附件类型无效，本次发送未派发。", "OPERATION_REJECTED");
    }
    const name = typeof item.name === "string" && item.name ? item.name : path.basename(item.path);
    if (!validText(name, MAX_ATTACHMENT_NAME)) {
      throw new OperationError("无法从附件路径得到有效名称，本次发送未派发。", "OPERATION_REJECTED");
    }
    const size = Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= MAX_ATTACHMENT_BYTES ? item.size : undefined;
    return { path: item.path, name, kind: item.kind === "image" ? "image" as const : "file" as const, ...(size !== undefined ? { size } : {}) };
  });
  const text = typeof params.text === "string" ? params.text : "";
  if (text.length > MAX_TEXT_CHARS || text.includes("\0")) {
    throw new OperationError(`text 无效或超过 ${MAX_TEXT_CHARS} 字符，本次发送未派发。`, "OPERATION_REJECTED");
  }
  if (!text.trim() && attachments.length === 0) throw new OperationError("消息和附件不能同时为空，本次发送未派发。", "OPERATION_REJECTED");
  const selectors: Record<string, string | null | undefined> = {};
  for (const key of ["model", "approvalPolicy", "sandbox", "effort"] as const) {
    const value = params[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > MAX_SELECTOR_CHARS || value.includes("\0"))) {
      throw new OperationError(`${key} 无效，本次发送未派发。`, "OPERATION_REJECTED");
    }
    selectors[key] = value;
  }
  // Fingerprint only fields with turn/start semantics. This both matches what
  // the curated API forwards and prevents a large ignored property from being
  // synchronously copied/hashed in the control process before validation.
  const semantic = { threadId: params.threadId, text, attachments, ...selectors };
  return { threadId: params.threadId, attachments,
    fingerprint: createHash("sha256").update(JSON.stringify(semantic)).digest("hex"),
    request: semantic };
}

/** Durable admission, NOT a claim of upstream exactly-once execution. The
 * pre-send intent is already 'unknown': a crash between write and send cannot
 * be distinguished from a lost accepted response. Such an id is never resent.
 * Records are never silently evicted, since that would turn retries into new
 * paid turns. Capacity exhaustion rejects BEFORE sending anything upstream. */
export class OperationLedger {
  private readonly dir: string;
  private readonly turnsDir: string;
  private count: number;
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly metadataFiles = new Set<string>();
  constructor(controlHome: string, private readonly capacity = 100_000) {
    this.dir = path.join(controlHome, "operations");
    this.turnsDir = path.join(controlHome, "message-metadata");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.turnsDir, { recursive: true, mode: 0o700 });
    this.count = this.scanDirectory(this.dir, (name) => name.endsWith(".json"));
    this.scanDirectory(this.turnsDir, (name) => {
      if (/^[a-f0-9]{64}\.json$/.test(name)) this.metadataFiles.add(name);
      return false;
    });
  }
  private scanDirectory(dir: string, visit: (name: string) => boolean): number {
    const handle = opendirSync(dir);
    let entries = 0;
    let matches = 0;
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        entries += 1;
        if (entries > MAX_LEDGER_DIRECTORY_ENTRIES) throw new Error(`operation metadata directory exceeds ${MAX_LEDGER_DIRECTORY_ENTRIES} entries`);
        if (entry.isFile() && visit(entry.name)) matches += 1;
      }
    } finally { handle.closeSync(); }
    return matches;
  }
  private key(id: unknown): string {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(id)) {
      throw new OperationError("clientOperationId must be a stable 16-128 character identifier", "OPERATION_REJECTED");
    }
    return id;
  }
  private recordPath(id: string): string { return path.join(this.dir, `${this.key(id)}.json`); }
  private metadataPath(threadId: string, turnId: string): string {
    return path.join(this.turnsDir, createHash("sha256").update(JSON.stringify([threadId, turnId])).digest("hex") + ".json");
  }
  get(id: unknown): OperationRecord | { state: "not_received" } {
    const file = this.recordPath(this.key(id));
    try {
      const entry = JSON.parse(readBoundedRegularTextFileSync(file, 256 * 1024));
      if (!validRecord(entry, id as string)) throw new Error("invalid operation record");
      return entry;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { state: "not_received" };
      throw new OperationError("发送记录无法可靠读取；为避免重复执行，已禁止重发。");
    }
  }
  status(id: unknown) {
    const entry = this.get(id);
    if (entry.state === "not_received") return entry;
    const { state, threadId, turnId, error } = entry;
    return { state, threadId, turnId, error };
  }
  private write(entry: OperationRecord): void {
    if (!validRecord(entry, entry.clientOperationId)) throw new Error("invalid operation metadata");
    const encoded = JSON.stringify(entry);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error("operation metadata exceeds size budget");
    atomicWriteFileSync(this.recordPath(entry.clientOperationId), encoded);
  }
  async run(id: unknown, params: Record<string, any>, send: (request: Record<string, unknown>) => Promise<any>, isRejected: (error: unknown) => boolean): Promise<any> {
    const key = this.key(id);
    const snapshot = operationSnapshot(params);
    // Do not retain the caller's potentially large transport object while the
    // upstream turn is running. Only the validated semantic projection crosses
    // the private worker boundary.
    params = Object.create(null);
    const fingerprint = snapshot.fingerprint;
    const previous = this.get(key);
    if (previous.state !== "not_received") {
      if (previous.fingerprint !== fingerprint) throw new OperationError("同一 clientOperationId 不能用于不同的发送内容", "OPERATION_REJECTED");
      const inFlight = this.running.get(key);
      if (inFlight) return inFlight;
      if (previous.state === "accepted") return { turn: { id: previous.turnId }, clientOperationId: key, harnessAttachments: previous.attachments, replayed: true };
      throw new OperationError(previous.error ?? "发送结果未知，请检查会话记录；不会重复执行此操作。", previous.state === "rejected" ? "OPERATION_REJECTED" : "OPERATION_UNKNOWN");
    }
    if (this.count >= this.capacity) throw new OperationError("发送记录已达到容量上限，请管理员归档实例后继续；本次未发送。", "OPERATION_REJECTED");
    const entry: OperationRecord = { clientOperationId: key, threadId: snapshot.threadId, state: "unknown", fingerprint, attachments: snapshot.attachments };
    try {
      this.write(entry);
    } catch {
      // No worker callback has run yet. Whether the atomic file became visible
      // is irrelevant to delivery: this particular attempt was definitely not
      // dispatched, so the browser must not freeze it as an unknown operation.
      throw new OperationError("无法持久化发送记录，本次发送未派发。", "OPERATION_REJECTED");
    }
    this.count += 1;
    const task = (async () => {
      // Defer the send until the in-flight map is installed, even if send throws.
      await Promise.resolve();
      try {
        const result = await send(snapshot.request);
        if (!validText(result?.turn?.id, MAX_THREAD_ID)) throw new OperationError("上游响应缺少有效回合标识；执行结果未知。");
        entry.turnId = result.turn.id;
        entry.state = "accepted";
        // Persist display metadata before publishing acceptance. Natural-language
        // attachment path notes are never parsed back as an identity mechanism.
        const metadataFile = this.metadataPath(entry.threadId, entry.turnId!);
        atomicWriteFileSync(metadataFile, JSON.stringify(entry));
        const metadataName = path.basename(metadataFile);
        this.metadataFiles.add(metadataName);
        this.write(entry);
        return { ...result, clientOperationId: key, harnessAttachments: entry.attachments };
      } catch (error) {
        entry.state = isRejected(error) ? "rejected" : "unknown";
        entry.error = (error instanceof Error ? error.message : String(error)).slice(0, 64 * 1024);
        try { this.write(entry); } catch { /* pre-send unknown intent remains */ }
        throw new OperationError(entry.error, entry.state === "rejected" ? "OPERATION_REJECTED" : "OPERATION_UNKNOWN");
      } finally { this.running.delete(key); }
    })();
    this.running.set(key, task);
    return task;
  }
  private decorateItemBounded(
    threadId: string,
    turnId: string,
    item: any,
    cache?: Map<string, OperationRecord | null>,
    budget?: { remaining: number },
  ): any {
    if (item?.type !== "userMessage") return item;
    const file = this.metadataPath(threadId, turnId);
    const name = path.basename(file);
    if (!this.metadataFiles.has(name)) return item;
    try {
      let entry = cache?.get(name);
      if (entry === undefined) {
        if (budget && budget.remaining <= 0) return item;
        if (budget) budget.remaining -= 1;
        const parsed = JSON.parse(readBoundedRegularTextFileSync(file, 256 * 1024));
        entry = validRecord(parsed) ? parsed : null;
        cache?.set(name, entry);
      }
      if (!entry || entry.state !== "accepted" || entry.threadId !== threadId || entry.turnId !== turnId) return item;
      return { ...item, clientOperationId: entry.clientOperationId, harnessAttachments: entry.attachments };
    } catch { cache?.set(name, null); return item; }
  }
  decorateItem(threadId: string, turnId: string, item: any): any {
    return this.decorateItemBounded(threadId, turnId, item);
  }
  /** A single notification may repeat many user-message items. Read its one
   * metadata record at most once, and skip cosmetic decoration altogether for
   * implausibly large arrays rather than synchronously walking attacker-sized
   * worker output in the control process. */
  decorateNotificationItems(threadId: string, turnId: string, items: unknown[]): unknown[] {
    if (items.length > MAX_DECORATED_NOTIFICATION_ITEMS) return items;
    const cache = new Map<string, OperationRecord | null>();
    const budget = { remaining: 1 };
    return items.map((item) => this.decorateItemBounded(threadId, turnId, item, cache, budget));
  }
  decorateThreadResult(result: any): any {
    if (this.metadataFiles.size === 0 || !result?.thread?.id || !Array.isArray(result.thread.turns)) return result;
    const cache = new Map<string, OperationRecord | null>();
    const budget = { remaining: MAX_METADATA_READS_PER_HISTORY };
    const turns = result.thread.turns.map((turn: any) => ({
      ...turn, items: Array.isArray(turn.items) ? [...turn.items] : turn.items,
    }));
    // History is ordered oldest-to-newest. Spend the bounded disk-read budget
    // from the end while preserving output order, so recent visible messages
    // keep their attachment labels when history exceeds the cosmetic budget.
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = turns[turnIndex];
      if (!Array.isArray(turn.items)) continue;
      for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        turn.items[itemIndex] = this.decorateItemBounded(result.thread.id, turn.id, turn.items[itemIndex], cache, budget);
      }
    }
    return { ...result, thread: { ...result.thread, turns } };
  }
}
