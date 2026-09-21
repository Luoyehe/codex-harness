import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { realpath, stat, mkdir } from "node:fs/promises";
import { ProjectRegistry } from "../src/projects.js";

const io = vi.hoisted(() => ({
  now: 0,
  registries: new Map<string, string[]>(),
  blocked: new Set<string>(),
  missing: new Set<string>(),
  pending: [] as Array<{ kind: string; target: string; resolve(value: any): void; reject(error: Error): void }>,
  unfinished: 0,
  peak: 0,
}));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => io.now } }));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  existsSync: (file: string) => String(file).endsWith("webui-projects.json"),
}));
vi.mock("../src/bounded-file.js", () => ({
  readBoundedRegularTextFile: async (file: string) => JSON.stringify({
    projects: (io.registries.get(file) ?? []).map((target, index) => ({ path: target, addedAt: 1, lastUsedAt: index + 1 })),
  }),
}));
vi.mock("../src/atomic-file.js", () => ({ atomicWriteFile: vi.fn(async () => {}), atomicWriteFileSync: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  realpath: vi.fn(), stat: vi.fn(), mkdir: vi.fn(),
}));

const fixtureRoot = path.join(path.parse(process.cwd()).root, "project-io-fixture");
const identity = (target: string) => process.platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target);
const key = (kind: string, target: string) => `${kind}:${identity(target)}`;
const directory = { isDirectory: () => true };
const flush = async () => { for (let count = 0; count < 40; count++) await Promise.resolve(); };
const advance = async (milliseconds: number) => {
  io.now += milliseconds;
  await vi.advanceTimersByTimeAsync(milliseconds);
};
function probe(kind: string, target: string): Promise<any> {
  if (kind === "stat" && io.missing.has(identity(target))) return Promise.reject(Object.assign(new Error("absent"), { code: "ENOENT" }));
  if (!io.blocked.has(key(kind, target))) return Promise.resolve(kind === "realpath" ? path.resolve(target) : kind === "stat" ? directory : undefined);
  io.unfinished += 1;
  io.peak = Math.max(io.peak, io.unfinished);
  return new Promise((resolve, reject) => io.pending.push({ kind, target,
    resolve: (value) => { io.unfinished -= 1; resolve(value); },
    reject: (error) => { io.unfinished -= 1; reject(error); },
  }));
}
function registry(name: string, projects: string[], restricted = false) {
  const home = path.join(fixtureRoot, name);
  io.registries.set(path.join(home, "webui-projects.json"), projects);
  return new ProjectRegistry(home, fixtureRoot, restricted ? [fixtureRoot] : []);
}
function block(kind: string, targets: string[]) {
  for (const target of targets) io.blocked.add(key(kind, target));
}
function settleAll() {
  io.blocked.clear();
  for (const pending of io.pending.splice(0)) pending.resolve(pending.kind === "realpath" ? path.resolve(pending.target) : pending.kind === "stat" ? directory : undefined);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  io.now = 0; io.unfinished = 0; io.peak = 0;
  io.registries.clear(); io.blocked.clear(); io.missing.clear();
  vi.spyOn(ProjectRegistry as any, "runningInContainer").mockReturnValue(false);
  vi.mocked(realpath).mockImplementation(((target: string) => probe("realpath", target)) as typeof realpath);
  vi.mocked(stat).mockImplementation(((target: string) => probe("stat", target)) as typeof stat);
  vi.mocked(mkdir).mockImplementation(((target: string) => probe("mkdir", target)) as typeof mkdir);
});
afterEach(async () => {
  // Settle the mocked physical work, not just its timed-out wrapper. The pool
  // intentionally survives registry disposal and therefore survives each test.
  settleAll();
  await flush();
  expect(io.unfinished).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("ProjectRegistry physical filesystem work", () => {
  it("keeps three expired snapshot rounds at eight unfinished probes and recovers after settlement", async () => {
    const targets = Array.from({ length: 8 }, (_, index) => path.join(fixtureRoot, `slow-${index}`));
    const projects = registry("rounds", targets);
    block("realpath", targets);
    for (let round = 0; round < 3; round++) {
      const one = projects.list();
      const two = projects.list();
      await flush();
      expect(realpath).toHaveBeenCalledTimes(8);
      await advance(2_500);
      const result = await one;
      expect(await two).toEqual(result);
      expect(result.every((entry) => entry.available === false)).toBe(true);
      expect(io.unfinished).toBe(8);
      expect(await projects.list()).toEqual(result);
      await advance(1_001);
    }
    settleAll();
    await flush();
    expect((await projects.list()).every((entry) => entry.available === true)).toBe(true);
    expect(io.peak).toBe(8);
  });

  it("shares saturation across instances and routes without queuing a cached healthy selection", async () => {
    const healthy = path.join(fixtureRoot, "healthy");
    const healthyRegistry = registry("healthy-registry", [healthy]);
    expect(await healthyRegistry.list()).toEqual([expect.objectContaining({ path: healthy, available: true })]);
    const targets = Array.from({ length: 8 }, (_, index) => path.join(fixtureRoot, `hung-${index}`));
    block("realpath", targets);
    const listing = registry("hung-registry", targets).list();
    await flush();
    const calls = vi.mocked(realpath).mock.calls.length;
    const other = registry("other-registry", [path.join(fixtureRoot, "uncached")], true);
    expect(await other.list()).toEqual([expect.objectContaining({ available: false })]);
    expect(await other.isPersistent(fixtureRoot)).toBe(false);
    expect(await healthyRegistry.resolveRegistered(healthy)).toBeNull();
    // Cached presentation data is still immediate, but it cannot authorize a
    // new cwd without the required fresh path proof while capacity is full.
    expect(await healthyRegistry.list()).toEqual([expect.objectContaining({ available: true })]);
    expect(io.now).toBe(0);
    expect(realpath).toHaveBeenCalledTimes(calls);
    expect(io.unfinished).toBe(8);
    await advance(2_500);
    await listing;
    // A late rejection releases exactly one physical slot despite having no
    // remaining subscribers, and fresh healthy probes can then complete.
    io.pending.shift()!.reject(new Error("late filesystem failure"));
    await flush();
    expect(await healthyRegistry.resolveRegistered(healthy)).toBe(healthy);
    expect(io.unfinished).toBe(7);
    expect(io.peak).toBe(8);
  });

  it("coalesces the same path across snapshots, selection and persistent-root checks", async () => {
    const target = path.join(fixtureRoot, "shared");
    block("realpath", [target]);
    const one = registry("shared-one", [target], true);
    const two = registry("shared-two", [target], true);
    const listing = one.list();
    const selection = two.resolveRegistered(target);
    const persistent = one.isPersistent(target);
    await flush();
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(io.unfinished).toBe(1);
    await advance(2_500);
    expect((await listing)[0].available).toBe(false);
    expect(await selection).toBeNull();
    expect(await persistent).toBe(false);
    expect(io.unfinished).toBe(1);
  });

  it("keeps different methods on one path distinct and counts both physical operations", async () => {
    const target = path.join(fixtureRoot, "method-identity");
    const projects = registry("method-registry", [target]);
    block("realpath", [target]); block("stat", [target]);
    const selection = projects.resolveRegistered(target);
    const addition = projects.add(target, false).catch((error) => error);
    await flush();
    expect(realpath).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(io.unfinished).toBe(2);
    await advance(2_500);
    expect(await selection).toBeNull();
    expect(await addition).toBeInstanceOf(Error);
    expect(io.unfinished).toBe(2);
  });

  it("bounds and removes deadline subscribers while retaining only one unfinished physical call", async () => {
    const target = path.join(fixtureRoot, "many-callers");
    const projects = registry("subscriber-registry", [target]);
    block("realpath", [target]);
    for (let round = 0; round < 3; round++) {
      let finished = 0;
      const callers = Array.from({ length: 100 }, () => projects.resolveRegistered(target).then((value) => { finished++; return value; }));
      await flush();
      expect(finished).toBe(36);
      expect(vi.getTimerCount()).toBe(64);
      expect(realpath).toHaveBeenCalledTimes(1);
      await advance(2_500);
      expect((await Promise.all(callers)).every((value) => value === null)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(io.unfinished).toBe(1);
    }
    io.pending.shift()!.reject(new Error("late rejection after all deadlines"));
    await flush();
    io.blocked.clear();
    expect(await projects.resolveRegistered(target)).toBe(target);
  });

  it("uses the host path grammar for dot aliases and case identity", async () => {
    const target = path.join(fixtureRoot, "CaseIdentity");
    const caseVariant = process.platform === "win32" ? target.toUpperCase() : path.join(fixtureRoot, "caseidentity");
    const dotAlias = `${fixtureRoot}${path.sep}.${path.sep}CaseIdentity`;
    const projects = registry("path-grammar", [target, caseVariant]);
    block("realpath", [target, caseVariant]);
    const calls = [projects.resolveRegistered(target), projects.resolveRegistered(dotAlias), projects.resolveRegistered(caseVariant)];
    await flush();
    expect(realpath).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 2);
    await advance(2_500);
    expect(await Promise.all(calls)).toEqual([null, null, null]);
  });

  it("retains a timed-out mkdir slot and coalesces retries until physical completion", async () => {
    const target = path.join(fixtureRoot, "creating");
    const projects = registry("creation-registry", []);
    io.missing.add(identity(target));
    block("mkdir", [target]);
    for (let round = 0; round < 3; round++) {
      const addition = projects.add(target, true).catch((error) => error);
      await flush();
      expect(mkdir).toHaveBeenCalledTimes(1);
      expect(io.unfinished).toBe(1);
      await advance(2_500);
      expect(await addition).toBeInstanceOf(Error);
    }
    settleAll();
    io.missing.clear();
    await flush();
    expect(await projects.add(target, true)).toMatchObject({ path: target });
    expect(await projects.resolveRegistered(target)).toBe(target);
  });
});
