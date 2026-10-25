import { jsonBytes, object, type JsonObject, type JsonValue } from './types.js';

/** Read-only views never activate a stored native thread. */
export class SessionSnapshots {
  private entries = new Map<string, { value: JsonObject; stale: boolean; revision: number; bytes: number }>();
  private bytes = 0;
  private metadata(thread: JsonObject): JsonObject { return Object.fromEntries(['id', 'cwd', 'status', 'parentThreadId', 'canAcceptDirectInput', 'historyMode', 'model', 'modelProvider', 'reasoningEffort', 'name'].filter(key => thread[key] !== undefined).map(key => [key, thread[key]! ])); }
  private store(id: string, value: JsonObject, stale: boolean): void {
    const bytes = Buffer.byteLength(jsonBytes(value, 256 * 1024)); const old = this.entries.get(id); const revision = (old?.revision ?? 0) + 1;
    if (old) { this.entries.delete(id); this.bytes -= old.bytes; }
    while (this.entries.size >= 128 || this.bytes + bytes > 8 * 1024 * 1024) { const [key, entry] = this.entries.entries().next().value!; this.entries.delete(key); this.bytes -= entry.bytes; }
    this.entries.set(id, { value, stale, revision, bytes }); this.bytes += bytes;
  }
  capture(result: JsonValue): void {
    const value = object(result); const thread = object(value.thread);
    if (typeof thread.id !== 'string' || typeof value.model !== 'string' || typeof value.cwd !== 'string' || value.approvalPolicy === undefined || value.sandbox === undefined) return;
    const snapshot: JsonObject = { thread: this.metadata(thread) };
    for (const key of ['model', 'modelProvider', 'serviceTier', 'disabledPluginIds', 'cwd', 'runtimeWorkspaceRoots', 'instructionSources', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'activePermissionProfile', 'reasoningEffort', 'collaborationMode']) if (value[key] !== undefined) snapshot[key] = value[key]!;
    this.store(thread.id, snapshot, false);
  }
  thread(value: JsonObject): void { if (typeof value.id !== 'string') return; const entry = this.entries.get(value.id); if (entry) this.store(value.id, { ...entry.value, thread: this.metadata(value) }, entry.stale); }
  invalidate(id: string): () => void { const entry = this.entries.get(id); if (!entry) return () => {}; const stale = entry.stale; entry.stale = true; const revision = ++entry.revision; return () => { if (this.entries.get(id) === entry && entry.revision === revision) entry.stale = stale; }; }
  settings(id: string, settings: JsonObject): void {
    const entry = this.entries.get(id); if (!entry) return;
    const value = { ...entry.value };
    for (const key of ['model', 'modelProvider', 'serviceTier', 'disabledPluginIds', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'activePermissionProfile', 'collaborationMode']) if (settings[key] !== undefined) value[key] = settings[key]!;
    if (settings.sandboxPolicy !== undefined) value.sandbox = settings.sandboxPolicy;
    if (settings.effort !== undefined) value.reasoningEffort = settings.effort;
    if (settings.summary !== undefined) value.summary = settings.summary;
    this.store(id, value, false);
  }
  read(id: string): JsonObject { const entry = this.entries.get(id); return !entry || entry.stale ? { requiresResume: true } : { requiresResume: false, ...entry.value }; }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
