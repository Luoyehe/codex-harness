import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ProjectRegistry } from "../src/projects.js";

const dirs: string[] = [];
const python = process.env.CODEX_TEST_PYTHON || "python3";
const pythonAvailable = spawnSync(python, ["-c", "import tomllib"], { windowsHide: true, timeout: 10000 }).status === 0;
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
  it.runIf(pythonAvailable)("the uninstall guard reads the real persisted registry and protects added projects", () => {
    const { dir, home, workspace, extra, registry } = fixture(false);
    const program = path.join(dir, "program"), units = path.join(dir, "units");
    mkdirSync(program); mkdirSync(units);
    const deploy = fileURLToPath(new URL("../../../deploy/", import.meta.url));
    const guard = () => spawnSync(python, [path.join(deploy, "lifecycle.py"), "guard-uninstall", program,
      home, path.join(home, "secrets.env"), workspace, "fixture", units], {
      encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
    });
    // The constructor's actual on-disk format, not a duplicated fixture schema.
    let result = guard();
    expect(result.status, result.stderr).toBe(0);
    registry.add(extra, false);
    result = guard();
    expect(result.status, result.stderr).toBe(0);
    const retained = path.join(program, "retained-project");
    registry.add(retained, true);
    result = guard();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("retained registered project");
    expect(existsSync(retained)).toBe(true);
    registry.remove(retained);
    result = guard();
    expect(result.status, result.stderr).toBe(0);
  });
  it("a stale ENOTDIR entry does not block later valid projects and remains removable", () => {
    const { registry, home, extra, workspace, dir } = fixture(false);
    const notDirectory = path.join(dir, "not-directory");
    writeFileSync(notDirectory, "fixture");
    const bad = path.join(notDirectory, "child");
    writeFileSync(path.join(home, "webui-projects.json"), JSON.stringify({ projects: [
      { path: bad, addedAt: 1, lastUsedAt: 3 }, { path: extra, addedAt: 1, lastUsedAt: 2 },
    ] }));
    expect(registry.resolveRegistered(extra)).toBe(extra);
    expect(registry.list()).toContainEqual(expect.objectContaining({ path: bad, available: false }));
    registry.remove(bad);
    expect(registry.list().some((entry) => entry.path === bad)).toBe(false);
  });
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
