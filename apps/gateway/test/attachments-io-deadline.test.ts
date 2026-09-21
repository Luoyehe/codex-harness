import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AttachmentStore } from "../src/attachments.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const originalBudget = AttachmentStore.MAX_SCAN_MS;
const homes: string[] = [];
const releases: Array<() => void> = [];
const physicalScans: Promise<unknown>[] = [];
const nativeClosers: Array<() => Promise<void>> = [];

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("scan did not honor its I/O deadline")), 2_000);
    })]);
  } finally { clearTimeout(timer!); }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "attachment-deadline-"));
  homes.push(root);
  const store = new AttachmentStore(root);
  const saved = store.save("orphan.txt", "eA==", "file");
  store.reservePaths("old-thread", [saved.path]);
  store.reconcileGeneration();
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions);
  writeFileSync(path.join(sessions, "rollout.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "other" } }) + "\n");
  const actualScan = (store as any).scanRollouts.bind(store);
  vi.spyOn(store as any, "scanRollouts").mockImplementation((...args) => {
    const scan = actualScan(...args);
    physicalScans.push(scan);
    return scan;
  });
  (AttachmentStore as any).MAX_SCAN_MS = 150;
  return { store, saved, sessions, root };
}

type Stage = "opendir" | "dir.read" | "unknown.lstat" | "lstat" | "open"
  | "file.stat" | "file.header" | "file.body" | "file.after" | "file.close" | "dir.close";

function stall(stage: Stage, options: { reject?: boolean; unknownEntry?: boolean } = {}) {
  const gate = deferred();
  const entered = deferred();
  const events: string[] = [];
  let used = false;
  let fileReads = 0;
  let fileStats = 0;
  releases.push(() => gate.resolve());
  const call = async <T>(name: Stage, operation: () => Promise<T>): Promise<T> => {
    events.push(`${name}:start`);
    if (!used && name === stage) {
      used = true;
      entered.resolve();
      await gate.promise;
      if (options.reject) throw new Error(`late ${name} failure`);
    }
    const value = await operation();
    events.push(`${name}:done`);
    return value;
  };
  vi.spyOn(fs, "opendir").mockImplementation(((...args: Parameters<typeof fs.opendir>) => call("opendir", async () => {
    const handle = await native.opendir(...args);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    nativeClosers.push(close);
    vi.spyOn(handle, "read").mockImplementation((() => call("dir.read", async () => {
      const entry = await read();
      if (entry && options.unknownEntry) {
        return { name: entry.name, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false } as typeof entry;
      }
      return entry;
    })) as typeof handle.read);
    vi.spyOn(handle, "close").mockImplementation((() => call("dir.close", close)) as typeof handle.close);
    return handle;
  })) as typeof fs.opendir);
  let metadataCalls = 0;
  vi.spyOn(fs, "lstat").mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
    metadataCalls += 1;
    return call(options.unknownEntry && metadataCalls === 1 ? "unknown.lstat" : "lstat", () => native.lstat(...args));
  }) as typeof fs.lstat);
  vi.spyOn(fs, "open").mockImplementation((...args) => call("open", async () => {
    const handle = await native.open(...args);
    const read = handle.read.bind(handle);
    const stat = handle.stat.bind(handle);
    const close = handle.close.bind(handle);
    nativeClosers.push(close);
    vi.spyOn(handle, "read").mockImplementation(((...readArgs: Parameters<typeof read>) => {
      fileReads += 1;
      return call(fileReads === 1 ? "file.header" : "file.body", () => read(...readArgs));
    }) as typeof handle.read);
    vi.spyOn(handle, "stat").mockImplementation(((...statArgs: Parameters<typeof stat>) => {
      fileStats += 1;
      return call(fileStats === 1 ? "file.stat" : "file.after", () => stat(...statArgs));
    }) as typeof handle.stat);
    vi.spyOn(handle, "close").mockImplementation(() => call("file.close", close));
    return handle;
  }));
  return { entered: entered.promise, release: () => gate.resolve(), events };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  await bounded(Promise.allSettled(physicalScans.splice(0)));
  await Promise.allSettled(nativeClosers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  (AttachmentStore as any).MAX_SCAN_MS = originalBudget;
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("attachment history I/O deadlines", () => {
  it.each<Stage>(["opendir", "dir.read", "unknown.lstat", "lstat", "open", "file.stat", "file.header", "file.body", "file.after", "file.close", "dir.close"])(
    "bounds stalled %s, retains the upload, closes late handles and recovers",
    async (stage) => {
      const { store, saved } = fixture();
      const fault = stall(stage, { unknownEntry: stage === "unknown.lstat" });
      const started = performance.now();
      const deleting = store.removeUnreferenced(saved.path).catch((error: Error) => error.message);
      await bounded(fault.entered);
      expect(await bounded(deleting)).toMatch(/历史扫描尚未完成/);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(existsSync(saved.path)).toBe(true);
      expect(store.registeredOwners(saved.path)).toEqual(["@codex-harness:scan-incomplete"]);
      expect((store as any).queuedScans).toBe(0);
      expect((store as any).scanIoInFlight).toBe(true);

      // Repeated requests must neither wait on the abandoned scan nor launch
      // more native I/O while its operation or its close is still outstanding.
      const callsAtTimeout = fault.events.length;
      const retries = await bounded(Promise.all(Array.from({ length: 20 }, () =>
        store.removeUnreferenced(saved.path).catch((error: Error) => error.message))));
      expect(retries.every((result) => /历史扫描尚未完成/.test(String(result)))).toBe(true);
      expect(fault.events).toHaveLength(callsAtTimeout);
      expect((store as any).queuedScans).toBe(0);

      fault.release();
      await bounded(Promise.allSettled(physicalScans));
      expect((store as any).scanIoInFlight).toBe(false);
      // Late completion may only finish the outstanding call and close owned
      // handles; it must not restart traversal or change the earlier result.
      expect(fault.events.slice(callsAtTimeout).filter((event) => event.endsWith(":start"))
        .every((event) => event === "file.close:start" || event === "dir.close:start")).toBe(true);
      expect(fault.events.filter((event) => event === "dir.close:done")).toHaveLength(1);
      const openedFile = fault.events.includes("open:done");
      expect(fault.events.filter((event) => event === "file.close:done")).toHaveLength(openedFile ? 1 : 0);
      expect(existsSync(saved.path)).toBe(true);

      // A fresh complete scan can prove the file is unreferenced and delete it.
      (AttachmentStore as any).MAX_SCAN_MS = originalBudget;
      await store.removeUnreferenced(saved.path);
      expect(existsSync(saved.path)).toBe(false);
    },
  );

  it("releases scans queued before a timeout without issuing another opendir", async () => {
    const { store, saved, sessions } = fixture();
    const fault = stall("opendir");
    const scans = Array.from({ length: AttachmentStore.MAX_SCAN_QUEUE }, () =>
      (store as any).scheduleRolloutScan([saved.path], "", [sessions]));
    expect((store as any).queuedScans).toBe(AttachmentStore.MAX_SCAN_QUEUE);
    const results = await bounded(Promise.all(scans));
    expect(results.every((result) => !result.complete)).toBe(true);
    expect((store as any).queuedScans).toBe(0);
    expect(fault.events).toEqual(["opendir:start"]);
    fault.release();
    await bounded(Promise.allSettled(physicalScans));
    expect(fault.events).toEqual(["opendir:start", "opendir:done", "dir.close:start", "dir.close:done"]);
  });

  it("uses one deadline across successive operations instead of renewing it", async () => {
    const { store, saved } = fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const opening = deferred<Awaited<ReturnType<typeof fs.opendir>>>();
    const reading = deferred<null>();
    const handle = { read: vi.fn(() => reading.promise), close: vi.fn(async () => {}) };
    releases.push(() => {
      opening.resolve(handle as unknown as Awaited<ReturnType<typeof fs.opendir>>);
      reading.resolve(null);
    });
    vi.spyOn(fs, "opendir").mockImplementation(() => opening.promise);
    let result: string | undefined;
    const deleting = store.removeUnreferenced(saved.path).catch((error: Error) => { result = error.message; });
    now = 100;
    await vi.advanceTimersByTimeAsync(100);
    opening.resolve(handle as unknown as Awaited<ReturnType<typeof fs.opendir>>);
    await vi.advanceTimersByTimeAsync(0);
    expect(handle.read).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
    now = 150;
    await vi.advanceTimersByTimeAsync(50);
    await deleting;
    expect(result).toMatch(/历史扫描尚未完成/);
    expect(handle.close).not.toHaveBeenCalled();
    expect((store as any).queuedScans).toBe(0);
    reading.resolve(null);
    await Promise.allSettled(physicalScans);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each<Stage>(["file.close", "dir.close"])("stops admitting I/O when %s fails with uncertain handle ownership", async (stage) => {
    const { store, saved } = fixture();
    const fault = stall(stage, { reject: true });
    await expect(bounded(store.removeUnreferenced(saved.path))).rejects.toThrow(/历史扫描尚未完成/);
    fault.release();
    await bounded(Promise.allSettled(physicalScans));
    expect((store as any).scanIoInFlight).toBe(true);
    expect((store as any).queuedScans).toBe(0);
    const events = [...fault.events];
    await expect(store.removeUnreferenced(saved.path)).rejects.toThrow(/历史扫描尚未完成/);
    expect(fault.events).toEqual(events);
    expect(existsSync(saved.path)).toBe(true);
    // afterEach explicitly closes the real fixture handle behind the injected
    // close failure; production conservatively retains its one scan lease.
  });

  it.each<Stage>(["opendir", "open", "file.header"])("consumes a late %s rejection and allows a later scan", async (stage) => {
    const { store, saved } = fixture();
    const fault = stall(stage, { reject: true });
    await expect(bounded(store.removeUnreferenced(saved.path))).rejects.toThrow(/历史扫描尚未完成/);
    fault.release();
    await bounded(Promise.allSettled(physicalScans));
    expect((store as any).scanIoInFlight).toBe(false);
    (AttachmentStore as any).MAX_SCAN_MS = originalBudget;
    await store.removeUnreferenced(saved.path);
    expect(existsSync(saved.path)).toBe(false);
  });

  it("preserves a reservation acquired after timeout when late I/O completes", async () => {
    const { store, saved } = fixture();
    const fault = stall("file.header");
    await expect(bounded(store.removeUnreferenced(saved.path))).rejects.toThrow(/历史扫描尚未完成/);
    const reservation = store.reservePaths("new-thread", [saved.path]);
    fault.release();
    await bounded(Promise.allSettled(physicalScans));
    expect(store.registeredOwners(saved.path)).toContain(reservation.owner);
    await expect(store.removeUnreferenced(saved.path)).rejects.toThrow(/引用/);
    expect(existsSync(saved.path)).toBe(true);
  });

  it("rechecks a late rollout reference without ever deleting the attachment", async () => {
    const { store, saved, sessions } = fixture();
    writeFileSync(path.join(sessions, "rollout.jsonl"), JSON.stringify({ path: saved.path }) + "\n");
    const fault = stall("file.body");
    await expect(bounded(store.removeUnreferenced(saved.path))).rejects.toThrow(/历史扫描尚未完成/);
    fault.release();
    await bounded(Promise.allSettled(physicalScans));
    expect(existsSync(saved.path)).toBe(true);
    (AttachmentStore as any).MAX_SCAN_MS = originalBudget;
    await expect(store.removeUnreferenced(saved.path)).rejects.toThrow(/历史引用/);
    expect(store.registeredOwners(saved.path)).toEqual(["@codex-harness:rollout-reference"]);
    expect(existsSync(saved.path)).toBe(true);
  });

  it("releases the background recovery guard and persists a retry marker on timeout", async () => {
    const { store, saved } = fixture();
    const fault = stall("opendir");
    await bounded(store.recoverCleanup());
    expect((store as any).recovering).toBe(false);
    expect((store as any).queuedScans).toBe(0);
    expect(store.registeredOwners(saved.path)).toEqual(["@codex-harness:scan-incomplete"]);
    expect(existsSync(saved.path)).toBe(true);
    fault.release();
    await bounded(Promise.allSettled(physicalScans));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + AttachmentStore.INCOMPLETE_RETRY_BASE_MS + 1);
    (AttachmentStore as any).MAX_SCAN_MS = originalBudget;
    await store.recoverCleanup();
    expect(existsSync(saved.path)).toBe(false);
  });
});
