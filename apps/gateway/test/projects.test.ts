import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../src/projects.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(restricted: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), "gateway-projects-"));
  dirs.push(dir);
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  const extra = path.join(dir, "extra");
  const outside = path.join(dir, "outside");
  for (const entry of [home, workspace, extra, outside]) mkdirSync(entry);
  vi.spyOn(ProjectRegistry as any, "runningInContainer").mockReturnValue(false);
  const registry = new ProjectRegistry(home, workspace, restricted ? [extra] : []);
  return { dir, home, workspace, extra, outside, registry };
}

describe("ProjectRegistry filesystem identities", () => {
  it("allows every host drive in bare-metal mode and preserves root directories", () => {
    const { registry, workspace } = fixture(false);
    if (process.platform === "win32") {
      expect(registry.isPersistent("C:\\Windows")).toBe(true);
      expect(registry.isPersistent("D:\\Document")).toBe(true);
    }
    const root = path.parse(workspace).root;
    expect(registry.add(root, false).path).toBe(root);
    expect(registry.resolveRegistered(root)).toBe(root);
    registry.remove(root);
    expect(registry.resolveRegistered(root)).toBeNull();
  });

  it("treats configured persistent roots as additions to workspace and codex home", () => {
    const { registry, workspace, home, extra, outside } = fixture(true);
    for (const root of [workspace, home, extra]) expect(registry.isPersistent(path.join(root, "new"))).toBe(true);
    expect(registry.isPersistent(outside)).toBe(false);
    const project = path.join(workspace, "new-project");
    expect(registry.add(project, true).path).toBe(project);
    expect(existsSync(project)).toBe(true);
  });

  it("rejects a nonexistent leaf beneath a junction/symlink escaping its persistent root", () => {
    const { registry, workspace, outside } = fixture(true);
    const link = path.join(workspace, "escape");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(link, "not-created-yet", "project");
    expect(registry.isPersistent(target)).toBe(false);
    expect(() => registry.add(target, true)).toThrow(/持久化/);
    expect(existsSync(path.join(outside, "not-created-yet"))).toBe(false);
  });
});
