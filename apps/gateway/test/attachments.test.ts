import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("AttachmentStore containment and cleanup", () => {
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
    expect(store.registeredOwners(equivalent)).toContain("deleted-thread");

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
