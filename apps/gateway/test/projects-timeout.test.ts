import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../src/projects.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath) };
});

const directories: string[] = [];
const pendingIo: Array<() => void> = [];
afterEach(async () => {
  for (const settle of pendingIo.splice(0)) settle();
  await Promise.resolve();
  vi.mocked(realpath).mockReset();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "projects-disconnected-"));
  directories.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const file = path.join(root, "webui-projects.json");
  const slow = path.join(root, "disconnected");
  const projects = [
    { path: slow, addedAt: 1, lastUsedAt: 2 },
    { path: workspace, addedAt: 3, lastUsedAt: 4 },
    { path: workspace, addedAt: 5, lastUsedAt: 6 },
  ];
  writeFileSync(file, JSON.stringify({ projects }));
  const registry = new ProjectRegistry(root, workspace);
  const original = vi.mocked(realpath).getMockImplementation()!;
  let inspected!: () => void;
  const began = new Promise<void>((resolve) => { inspected = resolve; });
  vi.mocked(realpath).mockImplementation(((target: string, ...options: unknown[]) => {
    if (String(target) === slow) {
      inspected();
      return new Promise<string>((resolve) => pendingIo.push(() => resolve(slow)));
    }
    return (original as (...args: unknown[]) => Promise<string>)(target, ...options);
  }) as typeof realpath);
  return { root, registry, file, slow, workspace, projects, began };
}

describe("ProjectRegistry timeout recovery", () => {
  it.each(["selected", "unrelated"])("removes an exact registration when a %s path is disconnected without compacting uncertain peers", async (disconnected) => {
    const { registry, file, slow, workspace, projects, began } = fixture();
    const target = disconnected === "selected" ? slow : workspace;
    const removing = registry.remove(`${target}${path.sep}`);
    await began;
    // The unresolved OS call must not stall other event-loop work.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await removing;
    expect(JSON.parse(readFileSync(file, "utf8")).projects).toEqual(projects.filter((entry) => entry.path !== target));
  }, 10_000);

  it("does not guess an alias identity or rewrite other records after a timeout", async () => {
    const { registry, file, root } = fixture();
    const before = readFileSync(file, "utf8");
    await expect(registry.remove(path.join(root, "unknown-alias"))).rejects.toThrow("项目目录检查超时");
    expect(readFileSync(file, "utf8")).toBe(before);
  }, 10_000);
});
