import { createHash } from "node:crypto";
import { mkdirSync, opendirSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-file.js";
import { readBoundedRegularTextFileSync } from "./bounded-file.js";
import { OperationError } from "./operations.js";

interface ThreadStartRecord {
  clientOperationId: string;
  state: "accepted" | "unknown" | "rejected";
  fingerprint: string;
  cwd: string;
  threadId?: string;
  error?: string;
}

const MAX_RECORD_BYTES = 128 * 1024;
const MAX_DIRECTORY_ENTRIES = 200_000;
const MAX_THREAD_ID = 256;
const MAX_PATH = 4_096;
const MAX_SELECTOR = 256;
const FIELDS = new Set(["clientOperationId", "cwd", "model", "approvalPolicy", "sandbox"]);
const validId = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");

function validRecord(value: any, expectedId: string): value is ThreadStartRecord {
  return value && typeof value === "object" && !Array.isArray(value) && value.clientOperationId === expectedId
    && ["accepted", "unknown", "rejected"].includes(value.state)
    && typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && typeof value.cwd === "string" && value.cwd.length <= MAX_PATH && !value.cwd.includes("\0")
    && (value.threadId === undefined || validId(value.threadId, MAX_THREAD_ID))
    && (value.state !== "accepted" || value.threadId !== undefined)
    && (value.error === undefined || typeof value.error === "string" && value.error.length <= 64 * 1024);
}

function snapshot(params: Record<string, any>) {
  for (const key of Object.keys(params)) {
    if (!FIELDS.has(key)) {
      throw new OperationError(`thread/start 不支持字段 ${key.slice(0, 128)}，会话未创建。`, "OPERATION_REJECTED");
    }
  }
  const cwd = params.cwd === undefined || params.cwd === null ? "" : params.cwd;
  if (typeof cwd !== "string" || cwd.length > MAX_PATH || cwd.includes("\0")) {
    throw new OperationError("cwd 无效，会话未创建。", "OPERATION_REJECTED");
  }
  const semantic: Record<string, string | null> = { cwd };
  for (const key of ["model", "approvalPolicy", "sandbox"] as const) {
    const value = params[key];
    if (value !== undefined && value !== null &&
        (typeof value !== "string" || value.length > MAX_SELECTOR || value.includes("\0"))) {
      throw new OperationError(`${key} 无效，会话未创建。`, "OPERATION_REJECTED");
    }
    semantic[key] = value ?? null;
  }
  return {
    cwd,
    request: Object.fromEntries(Object.entries(semantic).filter(([, value]) => value !== null && value !== "")),
    fingerprint: createHash("sha256").update(JSON.stringify(semantic)).digest("hex"),
  };
}

/** Durable thread/start admission. An intent is persisted as unknown before
 * dispatch. A crash can therefore leave an explicit unknown result, but the
 * same operation ID is never automatically sent upstream a second time. */
export class ThreadStartLedger {
  private readonly dir: string;
  private count = 0;
  private readonly running = new Map<string, Promise<any>>();

  constructor(controlHome: string, private readonly capacity = 100_000) {
    this.dir = path.join(controlHome, "thread-start-operations");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const handle = opendirSync(this.dir);
    let entries = 0;
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        entries += 1;
        if (entries > MAX_DIRECTORY_ENTRIES) throw new Error(`thread-start operation directory exceeds ${MAX_DIRECTORY_ENTRIES} entries`);
        if (entry.isFile() && entry.name.endsWith(".json")) this.count += 1;
      }
    } finally { handle.closeSync(); }
  }

  private key(value: unknown): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(value)) {
      throw new OperationError("clientOperationId must be a stable 16-128 character identifier", "OPERATION_REJECTED");
    }
    return value;
  }

  private file(id: string): string { return path.join(this.dir, `${this.key(id)}.json`); }

  private get(idValue: unknown): ThreadStartRecord | { state: "not_received" } {
    const id = this.key(idValue);
    try {
      const value = JSON.parse(readBoundedRegularTextFileSync(this.file(id), MAX_RECORD_BYTES));
      if (!validRecord(value, id)) throw new Error("invalid thread-start operation record");
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { state: "not_received" };
      throw new OperationError("会话创建记录无法可靠读取；为避免重复创建，已禁止重发。");
    }
  }

  status(id: unknown) {
    const record = this.get(id);
    if (record.state === "not_received") return record;
    return { state: record.state, cwd: record.cwd, threadId: record.threadId, error: record.error };
  }

  private write(record: ThreadStartRecord): void {
    if (!validRecord(record, record.clientOperationId)) throw new Error("invalid thread-start operation metadata");
    const encoded = JSON.stringify(record);
    if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw new Error("thread-start operation metadata exceeds size budget");
    atomicWriteFileSync(this.file(record.clientOperationId), encoded);
  }

  async run(
    idValue: unknown,
    params: Record<string, any>,
    send: (request: Record<string, unknown>) => Promise<any>,
    isRejected: (error: unknown) => boolean,
  ): Promise<any> {
    const id = this.key(idValue);
    const projected = snapshot(params);
    params = Object.create(null);
    const previous = this.get(id);
    if (previous.state !== "not_received") {
      if (previous.fingerprint !== projected.fingerprint) {
        throw new OperationError("同一 clientOperationId 不能用于不同的会话创建参数", "OPERATION_REJECTED");
      }
      const inFlight = this.running.get(id);
      if (inFlight) return inFlight;
      if (previous.state === "accepted") {
        return { thread: { id: previous.threadId }, clientOperationId: id, replayed: true };
      }
      throw new OperationError(previous.error ?? "会话创建结果未知；请核对会话列表，不会自动重试。",
        previous.state === "rejected" ? "OPERATION_REJECTED" : "OPERATION_UNKNOWN");
    }
    if (this.count >= this.capacity) {
      throw new OperationError("会话创建记录已达到容量上限；本次未创建。", "OPERATION_REJECTED");
    }
    const record: ThreadStartRecord = {
      clientOperationId: id,
      state: "unknown",
      fingerprint: projected.fingerprint,
      cwd: projected.cwd,
    };
    try { this.write(record); }
    catch { throw new OperationError("无法持久化会话创建标识，本次未派发。", "OPERATION_REJECTED"); }
    this.count += 1;
    const task = (async () => {
      await Promise.resolve();
      try {
        const result = await send(projected.request);
        if (!validId(result?.thread?.id, MAX_THREAD_ID)) {
          throw new OperationError("上游响应缺少有效会话标识；创建结果未知。");
        }
        record.threadId = result.thread.id;
        record.state = "accepted";
        this.write(record);
        return { ...result, clientOperationId: id };
      } catch (error) {
        record.state = isRejected(error) ? "rejected" : "unknown";
        record.error = (error instanceof Error ? error.message : String(error)).slice(0, 64 * 1024);
        try { this.write(record); } catch { /* durable pre-send unknown intent remains fail-closed */ }
        throw new OperationError(record.error, record.state === "rejected" ? "OPERATION_REJECTED" : "OPERATION_UNKNOWN");
      } finally { this.running.delete(id); }
    })();
    this.running.set(id, task);
    return task;
  }
}
