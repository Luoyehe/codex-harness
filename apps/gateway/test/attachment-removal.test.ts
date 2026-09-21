import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttachmentStore } from "../src/attachments.js";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

it.each(["explicit", "recovery"])("a failed %s unlink remains visible and retryable", async (mode) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-unlink-failure-")); homes.push(home);
  const store = new AttachmentStore(home);
  const saved = store.save("fixture.txt", "eA==", "file");
  if (mode === "recovery") { store.reservePaths("old-thread", [saved.path]); store.reconcileGeneration(); }
  const original = fs.rmSync;
  const failing = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (file === saved.path) throw Object.assign(new Error("synthetic unlink denial"), { code: "EACCES" });
    return original(file, options);
  });
  const remove = () => mode === "explicit" ? store.removeUnreferenced(saved.path) : store.recoverCleanup();
  await expect(remove()).rejects.toThrow();
  expect(fs.existsSync(saved.path)).toBe(true);
  if (mode === "recovery") expect(store.registeredOwners(saved.path)).toContain("@codex-harness:scan-incomplete");
  failing.mockRestore();
  await remove();
  expect(fs.existsSync(saved.path)).toBe(false);
});
