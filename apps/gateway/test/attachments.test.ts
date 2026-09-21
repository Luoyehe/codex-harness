import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttachmentStore } from "../src/attachments.js";

const homes: string[] = [];
function home(): string {
  const value = mkdtempSync(path.join(tmpdir(), "attachment-store-"));
  homes.push(value);
  return value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("AttachmentStore containment and cleanup", () => {
  it("durably reclaims a browser-crash upload only after the draft grace period", async () => {
    const root = home();
    const createdAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const saved = new AttachmentStore(root).save("abandoned.txt", "eA==", "file");

    const restarted = new AttachmentStore(root);
    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS + 1);
    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(false);
  });

  it("keeps an aged draft when a turn reserves it during the recovery scan", async () => {
    const root = home();
    const createdAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const saved = new AttachmentStore(root).save("race.txt", "eA==", "file");
    const restarted = new AttachmentStore(root);
    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS + 1);

    let finish!: (value: { referenced: Set<string>; complete: boolean }) => void;
    (restarted as any).findReferencedByOtherRollout = () => new Promise((resolve) => { finish = resolve; });
    const recovering = restarted.recoverCleanup();
    const lease = restarted.reservePaths("new-thread", [saved.path]);
    finish({ referenced: new Set(), complete: true });
    await recovering;

    expect(existsSync(saved.path)).toBe(true);
    expect(restarted.registeredOwners(saved.path)).toContain(lease.owner);
  });

  it("ages a definitively rejected send back into recoverable draft state", async () => {
    const root = home();
    const createdAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const first = new AttachmentStore(root);
    const saved = first.save("rejected.txt", "eA==", "file");
    const lease = first.reservePaths("rejected-thread", [saved.path]);
    first.settleReservation(lease, false);

    const restarted = new AttachmentStore(root);
    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS + 1);
    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(false);
  });

  it("promotes an aged draft to a rollout marker when history proves a reference", async () => {
    const root = home();
    const createdAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const saved = new AttachmentStore(root).save("survived.txt", "eA==", "file");
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    writeFileSync(path.join(sessions, "survived.jsonl"), JSON.stringify({ path: saved.path }));
    const restarted = new AttachmentStore(root);
    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS + 1);

    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(true);
    expect(restarted.registeredOwners(saved.path)).toEqual(["@codex-harness:rollout-reference"]);
  });

  it("backs off incomplete scans and daily rechecks of confirmed rollout references", async () => {
    const createdAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const incompleteStore = new AttachmentStore(home());
    const incomplete = incompleteStore.save("incomplete.txt", "eA==", "file");
    incompleteStore.reservePaths("old-thread", [incomplete.path]);
    incompleteStore.reconcileGeneration();
    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS + 1);
    const incompleteScan = vi.spyOn(incompleteStore as any, "findReferencedByOtherRollout")
      .mockResolvedValue({ referenced: new Set<string>(), complete: false });

    await incompleteStore.recoverCleanup();
    expect(incompleteScan).toHaveBeenCalledOnce();
    await incompleteStore.recoverCleanup();
    expect(incompleteScan).toHaveBeenCalledOnce();

    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS
      + AttachmentStore.INCOMPLETE_RETRY_BASE_MS + 2);
    await incompleteStore.recoverCleanup();
    expect(incompleteScan).toHaveBeenCalledTimes(2);

    vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const rolloutStore = new AttachmentStore(home());
    const rollout = rolloutStore.save("rollout.txt", "eA==", "file");
    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS + 1);
    const rolloutScan = vi.spyOn(rolloutStore as any, "findReferencedByOtherRollout")
      .mockResolvedValue({ referenced: new Set([rollout.path]), complete: true });
    await rolloutStore.recoverCleanup();
    expect(rolloutStore.registeredOwners(rollout.path)).toEqual(["@codex-harness:rollout-reference"]);
    await rolloutStore.recoverCleanup();
    expect(rolloutScan).toHaveBeenCalledOnce();
    vi.spyOn(Date, "now").mockReturnValue(createdAt + AttachmentStore.UNCLAIMED_GRACE_MS
      + AttachmentStore.ROLLOUT_RECHECK_MS + 2);
    await rolloutStore.recoverCleanup();
    expect(rolloutScan).toHaveBeenCalledTimes(2);
  });

  it("excludes only an exact session_meta thread id, never a filename substring", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("data.csv", "eA==", "file");
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    writeFileSync(path.join(sessions, "rollout-other-thread-copy.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "different" } }),
      JSON.stringify({ path: saved.path }),
    ].join("\n"));
    const other = await (store as any).findReferencedByOtherRollout([saved.path], "thread", [sessions]);
    expect(other).toMatchObject({ complete: true });
    expect(other.referenced).toContain(saved.path);

    writeFileSync(path.join(sessions, "own.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread" } }),
      JSON.stringify({ path: saved.path }),
    ].join("\n"));
    rmSync(path.join(sessions, "rollout-other-thread-copy.jsonl"));
    const own = await (store as any).findReferencedByOtherRollout([saved.path], "thread", [sessions]);
    expect(own).toMatchObject({ complete: true });
    expect(own.referenced).not.toContain(saved.path);
  });

  it("finds modern and legacy attachment tokens split across rollout chunks", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const modern = store.save("boundary.txt", "eA==", "file").path;
    const legacy = path.join(root, "webui-uploads", "legacy boundary name.txt");
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const boundary = 256 * 1024;
    const modernName = path.basename(modern);
    const modernPrefix = "x".repeat(boundary - Math.floor(modernName.length / 2));
    writeFileSync(path.join(sessions, "modern.jsonl"), modernPrefix + modernName);
    const modernResult = await (store as any).findReferencedByOtherRollout([modern], "", [sessions]);
    expect(modernResult).toMatchObject({ complete: true });
    expect(modernResult.referenced).toContain(modern);

    rmSync(path.join(sessions, "modern.jsonl"));
    const legacyPrefix = "x".repeat(boundary - Math.floor(legacy.length / 2));
    writeFileSync(path.join(sessions, "legacy.jsonl"), legacyPrefix + legacy);
    const legacyResult = await (store as any).findReferencedByOtherRollout([legacy], "", [sessions]);
    expect(legacyResult).toMatchObject({ complete: true });
    expect(legacyResult.referenced).toContain(legacy);
  });

  it.each(["你", "😀"])("accepts valid %s split by the header cap and reclaims only unreferenced uploads", async (character) => {
    const root = home();
    const store = new AttachmentStore(root);
    const orphan = store.save("orphan.txt", "eA==", "file");
    const referenced = store.save("referenced.txt", "eA==", "file");
    store.reservePaths("old-thread", [orphan.path, referenced.path]);
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const prefix = `${JSON.stringify({ type: "session_meta", payload: { id: "other-thread" } })}\n{"text":"`;
    const text = prefix + "x".repeat(256 * 1024 - 1 - Buffer.byteLength(prefix)) + character
      + `"}\n${JSON.stringify({ path: referenced.path })}\n`;
    for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    writeFileSync(path.join(sessions, "other.jsonl"), text);
    const restarted = new AttachmentStore(root);
    const scanned = await (restarted as any).findReferencedByOtherRollout([orphan.path, referenced.path], "old-thread", [sessions]);
    expect(scanned).toEqual({ complete: true, referenced: new Set([referenced.path]) });
    await restarted.recoverCleanup();
    expect(existsSync(orphan.path)).toBe(false);
    expect(existsSync(referenced.path)).toBe(true);
  });

  it.each(["inside-header", "at-eof", "past-header"])("keeps orphan candidates when UTF-8 is actually invalid (%s)", async (position) => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("retained.txt", "eA==", "file");
    store.reservePaths("old-thread", [saved.path]);
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const padding = position === "inside-header" ? 10 : position === "at-eof" ? 256 * 1024 - 1 : 256 * 1024 + 1;
    // 0xE4 is a valid lead byte only when two continuation bytes follow.
    writeFileSync(path.join(sessions, "invalid.jsonl"), Buffer.concat([
      Buffer.alloc(padding, 0x20), Buffer.from([0xe4]),
    ]));
    const restarted = new AttachmentStore(root);
    const scanned = await (restarted as any).findReferencedByOtherRollout([saved.path], "", [sessions]);
    expect(scanned.complete).toBe(false);
    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(true);
  });

  it("yields repeatedly while scanning a near-limit no-match rollout", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    writeFileSync(path.join(sessions, "large.jsonl"), "x".repeat(2 * 1024 * 1024));
    const nativeImmediate = globalThis.setImmediate;
    let yields = 0;
    vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback: (...args: any[]) => void, ...args: any[]) => {
      yields += 1;
      return nativeImmediate(callback, ...args);
    }) as typeof setImmediate);

    const missing = path.join(root, "webui-uploads", "00000000-0000-4000-8000-000000000000.txt");
    const result = await (store as any).findReferencedByOtherRollout([missing], "", [sessions]);
    expect(result).toMatchObject({ complete: true, referenced: new Set() });
    expect(yields).toBeGreaterThan(4);
  });

  it("discovers uploads omitted by a missing or multiply-linked legacy sidecar", async () => {
    for (const problem of ["missing", "hardlink"] as const) {
      const root = home();
      const first = new AttachmentStore(root);
      const saved = first.save("legacy.txt", "eA==", "file");
      const refs = path.join(root, "webui-uploads", "refs.json");
      if (problem === "missing") rmSync(refs);
      else linkSync(refs, path.join(root, "refs-alias.json"));

      const restarted = new AttachmentStore(root);
      expect(restarted.registeredOwners(saved.path)).toContain("@codex-harness:scan-incomplete");
      await restarted.recoverCleanup();
      expect(existsSync(saved.path)).toBe(false);
    }
  });

  it("rolls back a new upload when its draft lease cannot be persisted", () => {
    const root = home();
    mkdirSync(path.join(root, "webui-uploads", "refs.json"), { recursive: true });
    const store = new AttachmentStore(root);
    expect(() => store.save("unsafe.txt", "eA==", "file")).toThrow(/持久化失败/);
    expect(readdirSync(path.join(root, "webui-uploads")).filter((name) => /^[0-9a-f-]+\.txt$/.test(name))).toEqual([]);
  });

  it("fails closed when the upload inventory is ambiguous or its instance quota is exhausted", () => {
    const ambiguousRoot = home();
    mkdirSync(path.join(ambiguousRoot, "webui-uploads", "unexpected-directory"), { recursive: true });
    const ambiguous = new AttachmentStore(ambiguousRoot);
    expect(() => ambiguous.save("blocked.txt", "eA==", "file")).toThrow(/盘点不完整/);

    const quota = new AttachmentStore(home());
    (quota as any).storedFiles = 4096;
    expect(() => quota.save("blocked.txt", "eA==", "file")).toThrow(/实例上限/);
    (quota as any).storedFiles = 0;
    (quota as any).storedBytes = 4 * 1024 * 1024 * 1024;
    expect(() => quota.save("blocked.txt", "eA==", "file")).toThrow(/实例上限/);
  });

  it("bounds queued history scans while retaining durable placeholders for overflow", () => {
    const store = new AttachmentStore(home());
    const scan = vi.spyOn(store as any, "findReferencedByOtherRollout").mockImplementation(() => new Promise(() => {}));
    const files = Array.from({ length: AttachmentStore.MAX_SCAN_QUEUE + 1 }, (_, index) => {
      const saved = store.save(`${index}.txt`, "eA==", "file");
      store.rememberPaths(`thread-${index}`, [saved.path]);
      store.cleanupForThread(`thread-${index}`, { thread: { turns: [] } });
      return saved.path;
    });
    expect((store as any).queuedScans).toBe(AttachmentStore.MAX_SCAN_QUEUE);
    expect(scan).toHaveBeenCalledOnce();
    for (const file of files) expect(store.registeredOwners(file)).toContain("@codex-harness:scan-incomplete");
  });

  it("treats multiply-linked rollout entries as incomplete", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("data.csv", "eA==", "file");
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const special = path.join(sessions, "special.jsonl");
    const original = path.join(root, "outside-rollout.jsonl");
    writeFileSync(original, "synthetic linked entry");
    linkSync(original, special);
    const result = await (store as any).findReferencedByOtherRollout([saved.path], "", [sessions]);
    expect(result.complete).toBe(false);
    expect(existsSync(saved.path)).toBe(true);
  });

  it("rejects an oversized rollout-needle batch without traversing history", async () => {
    const store = new AttachmentStore(home());
    const needles = Array.from({ length: AttachmentStore.MAX_SCAN_NEEDLES + 1 }, (_, index) => `/upload/${index}`);
    await expect((store as any).findReferencedByOtherRollout(needles, "", ["missing"])).resolves.toEqual({
      referenced: new Set(), complete: false,
    });
  });

  it("does not expand one thread deletion to unrelated global recovery markers", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const unrelated = store.save("unrelated.txt", "eA==", "file");
    store.rememberPaths("old-thread", [unrelated.path]);
    store.beginThreadDeletion("old-thread");
    store.reconcileGeneration();
    const owned = store.save("owned.txt", "eA==", "file");
    store.rememberPaths("deleted-thread", [owned.path]);
    const scan = vi.spyOn(store as any, "findReferencedByOtherRollout").mockResolvedValue({ referenced: new Set(), complete: false });
    store.cleanupForThread("deleted-thread", { thread: { turns: [] } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(scan).toHaveBeenCalledOnce();
    expect(scan.mock.calls[0][0]).toEqual([owned.path]);
    expect(store.registeredOwners(unrelated.path)).toContain("@codex-harness:scan-incomplete");
  });
  it("uses bounded ASCII disk filenames for multibyte names and long extensions", () => {
    const store = new AttachmentStore(home());
    for (const name of ["中".repeat(120) + ".csv", "😀".repeat(120) + ".png", "a." + "é".repeat(300)]) {
      const saved = store.save(name, "eA==", "file");
      expect(Buffer.byteLength(path.basename(saved.path))).toBeLessThan(64);
      expect(store.read(saved.path).base64).toBe("eA==");
    }
  });

  it("recovers a crash after delete intent or during background GC without immortal owners", async () => {
    for (const phase of ["before-response", "during-scan"]) {
      const root = home();
      const store = new AttachmentStore(root);
      const saved = store.save("data.csv", "eA==", "file");
      store.rememberPaths("deleted", [saved.path]);
      store.beginThreadDeletion("deleted");
      if (phase === "during-scan") {
        (store as any).findReferencedByOtherRollout = () => new Promise(() => {});
        store.cleanupForThread("deleted", {});
      }
      const restarted = new AttachmentStore(root);
      expect(restarted.registeredOwners(saved.path)).toEqual(["@codex-harness:scan-incomplete"]);
      await restarted.recoverCleanup();
      expect(existsSync(saved.path)).toBe(false);
    }
  });

  it("recovered pending sends retain surviving rollouts and incomplete scans", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("data.csv", "eA==", "file");
    store.reservePaths("thread", [saved.path]);
    mkdirSync(path.join(root, "sessions"));
    const rollout = path.join(root, "sessions", "thread.jsonl");
    writeFileSync(rollout, JSON.stringify({ input: saved.path }));
    const restarted = new AttachmentStore(root);
    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(true);
    rmSync(rollout);
    (restarted as any).findReferencedByOtherRollout = async () => ({ referenced: new Set(), complete: false });
    await restarted.recoverCleanup();
    expect(existsSync(saved.path)).toBe(true);
  });

  it("reconciles same-process stale leases only after a confirmed new generation", async () => {
    const store = new AttachmentStore(home());
    const saved = store.save("data.csv", "eA==", "file");
    store.reservePaths("thread", [saved.path]);
    await store.recoverCleanup();
    expect(existsSync(saved.path)).toBe(true);
    store.reconcileGeneration();
    await store.recoverCleanup();
    expect(existsSync(saved.path)).toBe(false);
  });

  it.each([false, true])("reconciles uncertain deletes on an inner restart without losing surviving rollouts (%s)", async (survived) => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("data.csv", "eA==", "file");
    store.rememberPaths("deleting", [saved.path]);
    store.beginThreadDeletion("deleting");
    if (survived) {
      mkdirSync(path.join(root, "sessions"));
      writeFileSync(path.join(root, "sessions", "survived.jsonl"), JSON.stringify({ input: saved.path }));
    }
    await store.recoverCleanup();
    expect(store.registeredOwners(saved.path)).toEqual(["deleting"]);
    store.reconcileGeneration();
    expect(store.registeredOwners(saved.path)).toEqual(["@codex-harness:scan-incomplete"]);
    await store.recoverCleanup();
    expect(existsSync(saved.path)).toBe(survived);
  });

  it("persists a moving recovery cursor so 128 retained entries cannot starve later orphans", async () => {
    const startedAt = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const root = home();
    const store = new AttachmentStore(root);
    const files = Array.from({ length: 129 }, () => store.save("data.csv", "eA==", "file").path).sort();
    // One reservation persists the same owners without 129 unrelated index
    // rewrites during setup. Keep real files and both restarted stores below.
    store.reservePaths("old-thread", files);
    const first = new AttachmentStore(root);
    (first as any).findReferencedByOtherRollout = async (needles: string[]) => ({ referenced: new Set(needles.filter((file) => file !== files[128])), complete: true });
    await first.recoverCleanup();
    expect(existsSync(files[128])).toBe(true);
    // Make the retained entries eligible again: reaching the orphan must
    // depend on the persisted cursor, not on the earlier entries' backoff.
    clock.mockReturnValue(startedAt + AttachmentStore.ROLLOUT_RECHECK_MS + 1);
    const next = new AttachmentStore(root);
    (next as any).findReferencedByOtherRollout = (first as any).findReferencedByOtherRollout;
    await next.recoverCleanup();
    expect(existsSync(files[128])).toBe(false);
    expect(existsSync(files[0])).toBe(true);
    // Durable creation of 129 files can exceed the default 5s on Windows CI.
  }, 15_000);
  it.each(["missing", "corrupt", "array", "invalid-owners", "unreadable"])("recovers conservatively from a %s reference index", async (problem) => {
    const root = home();
    const first = new AttachmentStore(root);
    const saved = first.save("historical.txt", Buffer.from("keep").toString("base64"), "file");
    first.rememberPaths("live-thread", [saved.path]);
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const rollout = path.join(sessions, "live-thread.jsonl");
    writeFileSync(rollout, JSON.stringify({ path: saved.path }));
    const refs = path.join(root, "webui-uploads", "refs.json");
    if (problem === "missing" || problem === "unreadable") rmSync(refs);
    if (problem === "unreadable") mkdirSync(refs); // portable read failure, even under an administrator
    if (problem === "corrupt") writeFileSync(refs, "{");
    if (problem === "array") writeFileSync(refs, "[]");
    if (problem === "invalid-owners") writeFileSync(refs, JSON.stringify({ [saved.path]: [null] }));
    const store = new AttachmentStore(root);
    await expect(store.removeUnreferenced(saved.path)).rejects.toThrow(/历史|扫描/);
    expect(existsSync(saved.path)).toBe(true);
    rmSync(rollout);
    await store.removeUnreferenced(saved.path);
    expect(existsSync(saved.path)).toBe(false);
  });

  it("persists uncertainty when another upload records owners before restart", async () => {
    const root = home();
    const first = new AttachmentStore(root);
    const old = first.save("old.txt", Buffer.from("old").toString("base64"), "file");
    writeFileSync(path.join(root, "webui-uploads", "refs.json"), "null");
    const recovered = new AttachmentStore(root);
    const other = recovered.save("new.txt", Buffer.from("new").toString("base64"), "file");
    recovered.rememberPaths("new-thread", [other.path]);
    const reloaded = new AttachmentStore(root);
    (reloaded as any).findReferencedByOtherRollout = async () => ({ referenced: new Set(), complete: false });
    await expect(reloaded.removeUnreferenced(old.path)).rejects.toThrow(/扫描/);
    expect(existsSync(old.path)).toBe(true);
  });

  it("allows an unused upload in a genuinely new store to be removed without historical recovery", async () => {
    const store = new AttachmentStore(home());
    const saved = store.save("unused.txt", Buffer.from("unused").toString("base64"), "file");
    (store as any).findReferencedByOtherRollout = () => { throw new Error("unexpected recovery"); };
    await store.removeUnreferenced(saved.path);
    expect(existsSync(saved.path)).toBe(false);
  });
  it("rejects malformed base64 before decoding", () => {
    const store = new AttachmentStore(home());
    expect(() => store.save("a.txt", "not base64!!!", "file")).toThrow(/base64/);
  });

  it("accepts a maximum-size file without overflowing the base64 validator", () => {
    const store = new AttachmentStore(home());
    const encoded = Buffer.alloc(store.maxFileBytes).toString("base64");
    const saved = store.save("large.bin", encoded, "file");
    expect(saved.size).toBe(store.maxFileBytes);
  });

  it("reapplies the image cap and identity checks immediately before send", () => {
    const root = home();
    const store = new AttachmentStore(root);
    const oversized = store.save(
      "oversized.png",
      Buffer.alloc(store.maxImageBytes + 1).toString("base64"),
      "file",
    );
    expect(() => store.validateImageForSend(oversized.path)).toThrow(/图片.*5MB/);

    const valid = store.save("valid.png", "eA==", "file");
    expect(store.validateImageForSend(valid.path)).toBe(valid.path);
    linkSync(valid.path, path.join(root, "valid-alias.png"));
    expect(() => store.validateImageForSend(valid.path)).toThrow(/图片附件.*替换/);
  });

  it("does not treat a symlink escape as an owned upload", (context) => {
    const root = home();
    const store = new AttachmentStore(root);
    const outside = path.join(root, "outside.txt");
    const link = path.join(root, "webui-uploads", "link.txt");
    writeFileSync(outside, "secret");
    try {
      symlinkSync(outside, link, "file");
    } catch (error: any) {
      if (error?.code === "EPERM") {
        context.skip(); // Report missing Windows symlink privilege explicitly.
        return;
      }
      throw error;
    }
    expect(store.isOwned(link)).toBe(false);
  });

  it("does not read or delete a multiply-linked upload identity", () => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("linked.txt", "eA==", "file");
    const alias = path.join(root, "outside-alias.txt");
    linkSync(saved.path, alias);
    expect(store.isOwned(saved.path)).toBe(false);
    expect(() => store.read(saved.path)).toThrow(/上传目录|替换|限制/);
    store.remove(saved.path);
    expect(existsSync(saved.path)).toBe(true);
    expect(existsSync(alias)).toBe(true);
  });

  it("uses one refcount identity for equivalent path spellings", () => {
    const store = new AttachmentStore(home());
    const saved = store.save("kept.txt", Buffer.from("kept").toString("base64"), "file");
    const equivalent = `${path.dirname(saved.path)}${path.sep}.${path.sep}${path.basename(saved.path)}`;
    expect(equivalent).not.toBe(saved.path);

    store.rememberPaths("live-thread", [saved.path]);
    expect(store.registeredOwners(equivalent)).toEqual(["live-thread"]);
    expect(Buffer.from(store.read(equivalent).base64, "base64").toString()).toBe("kept");
  });

  it("migrates equivalent keys from an existing refs sidecar", () => {
    const root = home();
    const first = new AttachmentStore(root);
    const saved = first.save("legacy.txt", Buffer.from("legacy").toString("base64"), "file");
    const equivalent = `${path.dirname(saved.path)}${path.sep}.${path.sep}${path.basename(saved.path)}`;
    writeFileSync(
      path.join(root, "webui-uploads", "refs.json"),
      JSON.stringify({ [equivalent]: ["legacy-thread"] }),
    );

    const reloaded = new AttachmentStore(root);
    expect(reloaded.registeredOwners(saved.path)).toEqual(["legacy-thread"]);
  });

  it("retains an owner placeholder while the rollout scan is pending", async () => {
    const store = new AttachmentStore(home());
    const saved = store.save("pending.txt", Buffer.from("pending").toString("base64"), "file");
    store.rememberPaths("deleted-thread", [saved.path]);

    let releaseScan!: (result: { referenced: Set<string>; complete: boolean }) => void;
    const scan = new Promise<{ referenced: Set<string>; complete: boolean }>((resolve) => {
      releaseScan = resolve;
    });
    (store as any).findReferencedByOtherRollout = () => scan;
    store.cleanupForThread("deleted-thread", { thread: { turns: [] } });

    const equivalent = `${path.dirname(saved.path)}${path.sep}.${path.sep}${path.basename(saved.path)}`;
    // attachment/delete performs this lookup before unlinking. It must not
    // observe a zero-owner gap while the fallback scan is outstanding.
    expect(store.registeredOwners(equivalent)).toContain("@codex-harness:scan-incomplete");

    releaseScan({ referenced: new Set(), complete: true });
    await scan;
    await Promise.resolve();
    expect(existsSync(saved.path)).toBe(false);
  });

  it("keeps an attachment when the fallback rollout scan is incomplete", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("keep.txt", Buffer.from("keep").toString("base64"), "file");
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions, { recursive: true });
    const oversized = path.join(sessions, "other.jsonl");
    writeFileSync(oversized, "{}");
    truncateSync(oversized, 65 * 1024 * 1024);

    store.cleanupForThread("deleted-thread", {
      turns: [{ items: [{ type: "userMessage", content: [{ type: "mention", path: saved.path }] }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(saved.path)).toBe(true);
    expect(store.registeredOwners(saved.path)).toContain("@codex-harness:scan-incomplete");
  });

  it("keeps a file referenced by an archived fork with JSON-escaped paths", async () => {
    const root = home();
    const store = new AttachmentStore(root);
    const saved = store.save("keep.txt", Buffer.from("keep").toString("base64"), "file");
    const archived = path.join(root, "archived_sessions");
    mkdirSync(archived);
    writeFileSync(path.join(archived, "fork.jsonl"), JSON.stringify({ path: saved.path }) + "\n");
    store.rememberPaths("deleted-thread", [saved.path]);
    store.cleanupForThread("deleted-thread", { thread: { turns: [] } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(saved.path)).toBe(true);
    expect(store.registeredOwners(saved.path)).toContain("@codex-harness:rollout-reference");
    // The final fork goes away: a previous scan marker must not become an
    // immortal owner which bypasses this new scan.
    rmSync(path.join(archived, "fork.jsonl"));
    store.cleanupForThread("fork", {
      thread: { turns: [{ items: [{ type: "userMessage", content: [{ type: "localImage", path: saved.path }] }] }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(saved.path)).toBe(false);
  });

  it("rechecks an incomplete scan when explicit deletion is retried", async () => {
    const store = new AttachmentStore(home());
    const saved = store.save("retry.txt", Buffer.from("retry").toString("base64"), "file");
    (store as any).findReferencedByOtherRollout = async () => ({ referenced: new Set(), complete: false });
    store.rememberPaths("t1", [saved.path]);
    store.cleanupForThread("t1", {});
    await new Promise((resolve) => setImmediate(resolve));
    await expect(store.removeUnreferenced(saved.path)).rejects.toThrow(/扫描/);
    (store as any).findReferencedByOtherRollout = async () => ({ referenced: new Set(), complete: true });
    await store.removeUnreferenced(saved.path);
    expect(existsSync(saved.path)).toBe(false);
  });

  it("does not unlink a file reserved while explicit deletion was rescanning", async () => {
    const store = new AttachmentStore(home());
    const saved = store.save("race.txt", Buffer.from("race").toString("base64"), "file");
    (store as any).findReferencedByOtherRollout = async () => ({ referenced: new Set(), complete: false });
    store.rememberPaths("t1", [saved.path]);
    store.cleanupForThread("t1", {});
    await new Promise((resolve) => setImmediate(resolve));
    let finish!: (value: unknown) => void;
    (store as any).findReferencedByOtherRollout = () => new Promise((resolve) => { finish = resolve; });
    const deleting = store.removeUnreferenced(saved.path);
    const assertion = expect(deleting).rejects.toThrow(/引用/);
    const lease = store.reservePaths("new-thread", [saved.path]);
    finish({ referenced: new Set(), complete: true });
    await assertion;
    expect(existsSync(saved.path)).toBe(true);
    store.settleReservation(lease, true);
    expect(store.registeredOwners(saved.path)).toContain("new-thread");
  });

  it("cleans a registered generic file from a wrapped thread/read result", async () => {
    const store = new AttachmentStore(home());
    const saved = store.save("unused.txt", Buffer.from("unused").toString("base64"), "file");
    store.rememberPaths("deleted-thread", [saved.path]);
    store.cleanupForThread("deleted-thread", { thread: { turns: [] } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(saved.path)).toBe(false);
  });
});
