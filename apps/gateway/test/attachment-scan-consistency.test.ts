import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttachmentStore } from "../src/attachments.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("attachment rollout scan consistency", () => {
  it("does not trust a path snapshot for a directory handle opened before replacement", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "attachment-directory-swap-"));
    homes.push(root);
    const store = new AttachmentStore(root);
    const saved = store.save("retained.txt", "eA==", "file");
    store.reservePaths("uncertain", [saved.path]);
    store.reconcileGeneration();
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const close = vi.fn(async () => undefined);
    vi.spyOn(fs, "opendir").mockImplementation((async (...args: Parameters<typeof fs.opendir>) => {
      if (String(args[0]) !== sessions) return native.opendir(...args);
      // The opened handle still enumerates the old, empty directory while its
      // pathname now identifies a replacement containing a live reference.
      renameSync(sessions, `${sessions}-old`);
      mkdirSync(sessions);
      writeFileSync(path.join(sessions, "fork.jsonl"), JSON.stringify({ path: saved.path }) + "\n");
      return { read: async () => null, close };
    }) as typeof fs.opendir);
    await store.recoverCleanup();
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(saved.path)).toBe(true);
    expect(store.registeredOwners(saved.path)).toContain("@codex-harness:scan-incomplete");
  });

  it.each(["unarchive", "append", "createRoot"])("preserves references added behind the traversal cursor (%s)", async (change) => {
    const root = mkdtempSync(path.join(tmpdir(), "attachment-snapshot-"));
    homes.push(root);
    const store = new AttachmentStore(root);
    const saved = store.save("retained.txt", "eA==", "file");
    store.reservePaths("uncertain", [saved.path]);
    store.reconcileGeneration();
    const sessions = path.join(root, "sessions");
    const archived = path.join(root, "archived_sessions");
    if (change !== "createRoot") mkdirSync(sessions);
    mkdirSync(archived);
    const source = path.join(archived, "fork.jsonl");
    const target = path.join(sessions, "fork.jsonl");
    const reference = JSON.stringify({ path: saved.path }) + "\n";
    if (change === "unarchive") writeFileSync(source, reference);
    if (change === "append") writeFileSync(target, "{}\n");
    vi.spyOn(fs, "opendir").mockImplementation(((...args: Parameters<typeof fs.opendir>) => {
      if (String(args[0]) === archived) {
        if (change === "unarchive") renameSync(source, target);
        else {
          if (change === "createRoot") mkdirSync(sessions);
          writeFileSync(target, reference);
        }
      }
      return native.opendir(...args);
    }) as typeof fs.opendir);
    await store.recoverCleanup();
    expect(existsSync(target)).toBe(true);
    expect(existsSync(saved.path)).toBe(true);
    expect(store.registeredOwners(saved.path)).toContain("@codex-harness:scan-incomplete");
  });
});
