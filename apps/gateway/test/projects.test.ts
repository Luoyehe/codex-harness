import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ProjectRegistry } from "../src/projects.js";
import * as atomicFiles from "../src/atomic-file.js";

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
  it("accepts only absolute paths in the current host grammar", () => {
    expect(ProjectRegistry.validPath(path.resolve("fixture"))).toBe(true);
    expect(ProjectRegistry.validPath("relative/project")).toBe(false);
    expect(ProjectRegistry.validPath("C:relative\\project")).toBe(false);
    if (process.platform !== "win32") expect(ProjectRegistry.validPath("C:\\deceptive-relative-on-linux")).toBe(false);
  });

  it("fails closed on malformed or multiply-linked durable registry metadata", async () => {
    const { home, workspace } = fixture(false);
    const file = path.join(home, "webui-projects.json");
    const valid = { path: workspace, addedAt: 1, lastUsedAt: 2 };
    for (const projects of [
      [{ ...valid, path: "relative" }],
      [{ ...valid, addedAt: -1 }],
      [{ ...valid, lastUsedAt: 2.5 }],
    ]) {
      writeFileSync(file, JSON.stringify({ projects }));
      await expect(new ProjectRegistry(home, workspace).list()).rejects.toThrow(/无法可靠读取/);
    }
    writeFileSync(file, JSON.stringify({ projects: [valid] }));
    linkSync(file, path.join(home, "registry-alias.json"));
    await expect(new ProjectRegistry(home, workspace).list()).rejects.toThrow(/无法可靠读取/);
  });

  it.each(['{"projects":', '{"projects":null}', '{"projects":[null]}'])("refuses to overwrite an unreadable registry instead of silently replacing registrations (%s)", async (contents) => {
    const { registry, home, extra } = fixture(false);
    const file = path.join(home, "webui-projects.json");
    writeFileSync(file, contents);
    await expect(registry.add(extra, false)).rejects.toThrow(/注册|registry/);
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("merges historical symlink and dot-segment aliases in list without losing timestamps", async () => {
    const { registry, home, workspace, extra } = fixture(false);
    const project = path.join(extra, "canonical-project");
    const alias = path.join(extra, "project-alias");
    mkdirSync(project);
    symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
    const dotAlias = `${extra}${path.sep}.${path.sep}canonical-project`;
    writeFileSync(path.join(home, "webui-projects.json"), JSON.stringify({ projects: [
      { path: workspace, addedAt: 5, lastUsedAt: 6 },
      { path: project, addedAt: 30, lastUsedAt: 40 },
      { path: alias, addedAt: 20, lastUsedAt: 70 },
      { path: dotAlias, addedAt: 10, lastUsedAt: 50 },
    ] }));

    const listed = await registry.list();
    expect(listed).toHaveLength(2);
    expect(listed.find((entry) => entry.path === project)).toEqual({
      path: project,
      addedAt: 10,
      lastUsedAt: 70,
      available: true,
    });
    expect(listed.some((entry) => entry.path === alias || entry.path === dotAlias)).toBe(false);

    // Any later add persists the same canonical view instead of writing the
    // hidden historical aliases back to disk.
    await registry.add(workspace, false);
    const persisted = JSON.parse(readFileSync(path.join(home, "webui-projects.json"), "utf8"));
    expect(persisted.projects).toHaveLength(2);
    expect(persisted.projects.find((entry: { path: string }) => entry.path === project)).toEqual({
      path: project,
      addedAt: 10,
      lastUsedAt: 70,
    });
  });

  it("uses one canonical identity for alias add, touch, list, persistence, and remove", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100);
    const { registry, home, workspace, extra } = fixture(false);
    const project = path.join(extra, "identity-project");
    const alias = path.join(extra, "identity-alias");
    mkdirSync(project);
    symlinkSync(project, alias, process.platform === "win32" ? "junction" : "dir");
    const dotAlias = `${extra}${path.sep}.${path.sep}identity-project`;

    vi.mocked(Date.now).mockReturnValue(200);
    expect((await registry.add(project, false)).path).toBe(project);
    vi.mocked(Date.now).mockReturnValue(300);
    expect((await registry.add(alias, false)).path).toBe(project);
    expect((await registry.add(dotAlias, false)).path).toBe(project);
    expect(await registry.list()).toHaveLength(2);
    expect(JSON.parse(readFileSync(path.join(home, "webui-projects.json"), "utf8")).projects).toHaveLength(2);

    vi.mocked(Date.now).mockReturnValue(400);
    await registry.touch(alias);
    expect((await registry.list()).find((entry) => entry.path === project)?.lastUsedAt).toBe(400);
    expect(await registry.resolveRegistered(dotAlias)).toBe(project);

    await registry.remove(dotAlias);
    expect(await registry.list()).toEqual([expect.objectContaining({ path: workspace })]);
    expect(await registry.resolveRegistered(project)).toBeNull();
    expect(await registry.resolveRegistered(alias)).toBeNull();
  });

  it("compacts legacy duplicates before applying the project-count limit", async () => {
    const { registry, home, workspace, extra } = fixture(false);
    const duplicates = Array.from({ length: 10_000 }, (_, index) => ({
      path: workspace,
      addedAt: index,
      lastUsedAt: index,
    }));
    writeFileSync(path.join(home, "webui-projects.json"), JSON.stringify({ projects: duplicates }));

    expect((await registry.add(extra, false)).path).toBe(extra);
    const persisted = JSON.parse(readFileSync(path.join(home, "webui-projects.json"), "utf8"));
    expect(persisted.projects).toHaveLength(2);
    expect(persisted.projects[0]).toEqual({ path: workspace, addedAt: 0, lastUsedAt: 9_999 });
    expect(await registry.list()).toHaveLength(2);
  });

  it("limits concurrent filesystem inspection and yields the event loop", async () => {
    const { registry, home, dir } = fixture(false);
    const projects = Array.from({ length: 64 }, (_, index) => ({
      path: path.join(dir, `network-project-${index}`),
      addedAt: index,
      lastUsedAt: index,
    }));
    writeFileSync(path.join(home, "webui-projects.json"), JSON.stringify({
      projects,
    }));
    let active = 0;
    let maximum = 0;
    let announce!: () => void;
    const began = new Promise<void>((resolve) => { announce = resolve; });
    let announced = false;
    vi.spyOn(ProjectRegistry as any, "canonical").mockImplementation(async (target: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (!announced) { announced = true; announce(); }
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return path.resolve(target);
    });
    const listing = registry.list();
    let completed = false;
    void listing.then(() => { completed = true; });
    await began;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(await listing).toHaveLength(projects.length);
    expect(maximum).toBeLessThanOrEqual(8);
  });

  it("serializes concurrent mutations so neither successful add is lost", async () => {
    const { registry, dir } = fixture(false);
    const one = path.join(dir, "one");
    const two = path.join(dir, "two");
    mkdirSync(one); mkdirSync(two);
    await Promise.all([registry.add(one, false), registry.add(two, false)]);
    const paths = (await registry.list()).map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining([one, two]));
  });

  it.each(["add", "remove", "touch"])("a failed %s persistence keeps the previous in-memory and on-disk registry", async (operation) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { registry, home, workspace, extra } = fixture(false);
    const before = await registry.list();
    const disk = readFileSync(path.join(home, "webui-projects.json"), "utf8");
    vi.mocked(Date.now).mockReturnValue(2000);
    const failure = vi.spyOn(atomicFiles, "atomicWriteFile").mockRejectedValueOnce(new Error("synthetic disk write failure"));
    await expect(operation === "add" ? registry.add(extra, false) : operation === "remove" ? registry.remove(workspace) : registry.touch(workspace)).rejects.toThrow("synthetic disk write failure");
    failure.mockRestore();
    expect(await registry.list()).toEqual(before);
    expect(readFileSync(path.join(home, "webui-projects.json"), "utf8")).toBe(disk);
    expect(await registry.resolveRegistered(extra)).toBeNull();
    expect(await registry.resolveRegistered(workspace)).toBe(workspace);
  });
  it.runIf(pythonAvailable)("the uninstall guard reads the real persisted registry and protects added projects", async () => {
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
    await registry.add(extra, false);
    result = guard();
    expect(result.status, result.stderr).toBe(0);
    const retained = path.join(program, "retained-project");
    await registry.add(retained, true);
    result = guard();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("retained registered project");
    expect(existsSync(retained)).toBe(true);
    await registry.remove(retained);
    result = guard();
    expect(result.status, result.stderr).toBe(0);
  });
  it("a stale ENOTDIR entry does not block later valid projects and remains removable", async () => {
    const { registry, home, extra, workspace, dir } = fixture(false);
    const notDirectory = path.join(dir, "not-directory");
    writeFileSync(notDirectory, "fixture");
    const bad = path.join(notDirectory, "child");
    writeFileSync(path.join(home, "webui-projects.json"), JSON.stringify({ projects: [
      { path: bad, addedAt: 1, lastUsedAt: 3 }, { path: extra, addedAt: 1, lastUsedAt: 2 },
    ] }));
    expect(await registry.resolveRegistered(extra)).toBe(extra);
    expect(await registry.list()).toContainEqual(expect.objectContaining({ path: bad, available: false }));
    await registry.remove(bad);
    expect((await registry.list()).some((entry) => entry.path === bad)).toBe(false);
  });
  it("allows every host drive in bare-metal mode and preserves root directories", async () => {
    const { registry, workspace } = fixture(false);
    if (process.platform === "win32") {
      expect(await registry.isPersistent("C:\\Windows")).toBe(true);
      expect(await registry.isPersistent("D:\\Document")).toBe(true);
    }
    const root = path.parse(workspace).root;
    expect((await registry.add(root, false)).path).toBe(root);
    expect(await registry.resolveRegistered(root)).toBe(root);
    await registry.remove(root);
    expect(await registry.resolveRegistered(root)).toBeNull();
  });

  it("treats configured persistent roots as additions to workspace and codex home", async () => {
    const { registry, workspace, home, extra, outside } = fixture(true);
    for (const root of [workspace, home, extra]) expect(await registry.isPersistent(path.join(root, "new"))).toBe(true);
    expect(await registry.isPersistent(outside)).toBe(false);
    const project = path.join(workspace, "new-project");
    expect((await registry.add(project, true)).path).toBe(project);
    expect(existsSync(project)).toBe(true);
  });

  it("rejects a nonexistent leaf beneath a junction/symlink escaping its persistent root", async () => {
    const { registry, workspace, outside } = fixture(true);
    const link = path.join(workspace, "escape");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(link, "not-created-yet", "project");
    expect(await registry.isPersistent(target)).toBe(false);
    await expect(registry.add(target, true)).rejects.toThrow(/持久化/);
    expect(existsSync(path.join(outside, "not-created-yet"))).toBe(false);
  });

  it("stops resolving a registered project after its path is replaced by an escape link", async () => {
    const { registry, workspace, outside } = fixture(true);
    const project = path.join(workspace, "mutable-project");
    mkdirSync(project);
    await registry.add(project, false);
    expect(await registry.resolveRegistered(project)).toBe(project);

    rmSync(project, { recursive: true });
    symlinkSync(outside, project, process.platform === "win32" ? "junction" : "dir");
    expect(await registry.list()).toContainEqual(expect.objectContaining({ path: project, available: true }));
    expect(await registry.resolveRegistered(project)).toBeNull();
    expect(await registry.resolveRegistered(outside)).toBeNull();
  });
});
