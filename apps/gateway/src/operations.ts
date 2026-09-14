import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";

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
  constructor(message: string, readonly errorCode = "OPERATION_UNKNOWN") { super(message); }
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
  constructor(controlHome: string, private readonly capacity = 100_000) {
    this.dir = path.join(controlHome, "operations");
    this.turnsDir = path.join(controlHome, "message-metadata");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.turnsDir, { recursive: true, mode: 0o700 });
    this.count = readdirSync(this.dir).filter((name) => name.endsWith(".json")).length;
  }
  private key(id: unknown): string {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(id)) throw new Error("clientOperationId must be a stable 16-128 character identifier");
    return id;
  }
  private recordPath(id: string): string { return path.join(this.dir, `${this.key(id)}.json`); }
  private metadataPath(threadId: string, turnId: string): string {
    return path.join(this.turnsDir, createHash("sha256").update(JSON.stringify([threadId, turnId])).digest("hex") + ".json");
  }
  get(id: unknown): OperationRecord | { state: "not_received" } {
    const file = this.recordPath(this.key(id));
    try {
      if (statSync(file).size > 256 * 1024) throw new Error("operation record too large");
      const entry = JSON.parse(readFileSync(file, "utf8"));
      if (entry?.clientOperationId !== id || !["accepted", "rejected", "unknown"].includes(entry?.state)) throw new Error("invalid operation record");
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
    const encoded = JSON.stringify(entry);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error("operation metadata exceeds size budget");
    atomicWriteFileSync(this.recordPath(entry.clientOperationId), encoded);
  }
  async run(id: unknown, params: Record<string, any>, send: () => Promise<any>, isRejected: (error: unknown) => boolean): Promise<any> {
    const key = this.key(id);
    const fingerprint = createHash("sha256").update(JSON.stringify(params)).digest("hex");
    const previous = this.get(key);
    if (previous.state !== "not_received") {
      if (previous.fingerprint !== fingerprint) throw new Error("同一 clientOperationId 不能用于不同的发送内容");
      const inFlight = this.running.get(key);
      if (inFlight) return inFlight;
      if (previous.state === "accepted") return { turn: { id: previous.turnId }, clientOperationId: key, replayed: true };
      throw new OperationError(previous.error ?? "发送结果未知，请检查会话记录；不会重复执行此操作。", previous.state === "rejected" ? "OPERATION_REJECTED" : "OPERATION_UNKNOWN");
    }
    if (this.count >= this.capacity) throw new Error("发送记录已达到容量上限，请管理员归档实例后继续；本次未发送。");
    const attachments = Array.isArray(params.attachments) ? params.attachments.map((item: any) => ({
      path: item?.path, name: item?.name, kind: item?.kind ?? "file", ...(typeof item?.size === "number" ? { size: item.size } : {}),
    })) : [];
    const entry: OperationRecord = { clientOperationId: key, threadId: params.threadId, state: "unknown", fingerprint, attachments };
    this.write(entry);
    this.count += 1;
    const task = (async () => {
      // Defer the send until the in-flight map is installed, even if send throws.
      await Promise.resolve();
      try {
        const result = await send();
        if (typeof result?.turn?.id !== "string" || !result.turn.id) throw new OperationError("上游响应缺少回合标识；执行结果未知。");
        entry.turnId = result.turn.id;
        entry.state = "accepted";
        // Persist display metadata before publishing acceptance. Natural-language
        // attachment path notes are never parsed back as an identity mechanism.
        atomicWriteFileSync(this.metadataPath(entry.threadId, entry.turnId!), JSON.stringify(entry));
        this.write(entry);
        return { ...result, clientOperationId: key };
      } catch (error) {
        entry.state = isRejected(error) ? "rejected" : "unknown";
        entry.error = error instanceof Error ? error.message : String(error);
        try { this.write(entry); } catch { /* pre-send unknown intent remains */ }
        throw new OperationError(entry.error, entry.state === "rejected" ? "OPERATION_REJECTED" : "OPERATION_UNKNOWN");
      } finally { this.running.delete(key); }
    })();
    this.running.set(key, task);
    return task;
  }
  decorateItem(threadId: string, turnId: string, item: any): any {
    if (item?.type !== "userMessage") return item;
    const file = this.metadataPath(threadId, turnId);
    if (!existsSync(file)) return item;
    try {
      if (statSync(file).size > 256 * 1024) return item;
      const entry = JSON.parse(readFileSync(file, "utf8"));
      if (entry.threadId !== threadId || entry.turnId !== turnId) return item;
      return { ...item, clientOperationId: entry.clientOperationId, harnessAttachments: entry.attachments };
    } catch { return item; }
  }
  decorateThreadResult(result: any): any {
    if (!result?.thread?.id || !Array.isArray(result.thread.turns)) return result;
    return { ...result, thread: { ...result.thread, turns: result.thread.turns.map((turn: any) => ({
      ...turn, items: Array.isArray(turn.items) ? turn.items.map((item: any) => this.decorateItem(result.thread.id, turn.id, item)) : turn.items,
    })) } };
  }
}
