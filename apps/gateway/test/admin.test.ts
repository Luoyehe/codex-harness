import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { recentLogs, redactSecrets, RedactedOutputRing, runScript, scriptChangeResult, serviceStatus } from "../src/admin.js";

function logExecutor(stdout: string, failure?: string) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const execute = (async (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    if (failure) throw new Error(failure);
    return { stdout, stderr: "" };
  }) as Parameters<typeof recentLogs>[1];
  return { execute, calls };
}

describe("administrator journal access", () => {
  const helper = "/usr/local/libexec/codex-harness-admin-fixture";

  it("uses only the instance helper's fixed sudo command for an unprivileged installed service", async () => {
    const fixture = logExecutor("old\nsecond\nGATEWAY_TOKEN=fixture-secret\nnewest\n");
    const checkedPaths: string[] = [];
    const logs = await recentLogs(2, fixture.execute, {
      helper, isRoot: false, exists: (value) => { checkedPaths.push(String(value)); return true; },
    });
    expect(checkedPaths).toEqual([helper]);
    expect(fixture.calls).toEqual([{
      command: "sudo",
      args: ["-n", helper, "recent-logs"],
      options: { encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true },
    }]);
    expect(logs).toBe("GATEWAY_TOKEN=[REDACTED]\nnewest\n");
  });

  it("invokes the same fixed helper operation directly when already root", async () => {
    const fixture = logExecutor("fixture log\n");
    expect(await recentLogs(80, fixture.execute, { helper, exists: () => true, isRoot: true })).toBe("fixture log\n");
    expect(fixture.calls[0].command).toBe(helper);
    expect(fixture.calls[0].args).toEqual(["recent-logs"]);
  });

  it("keeps the bounded direct journalctl path only when no installed helper exists", async () => {
    const fixture = logExecutor("fixture log\n");
    await recentLogs(12, fixture.execute, { helper, exists: () => false, isRoot: false });
    expect(fixture.calls[0].command).toBe("journalctl");
    expect(fixture.calls[0].args).toEqual(["-u", process.env.GATEWAY_UNIT ?? "codex-harness", "-n", "12", "--no-pager", "-o", "short"]);
  });

  it("clamps direct line counts and takes the requested tail of the helper's 300-line output", async () => {
    const output = Array.from({ length: 350 }, (_, i) => `line-${i + 1}`).join("\n");
    for (const [requested, expected] of [[5.9, 5], [999, 300], [-2, 1], [NaN, 80], [Infinity, 80]]) {
      const fixture = logExecutor(output);
      const logs = await recentLogs(requested, fixture.execute, { helper, exists: () => true, isRoot: false });
      expect(logs.split("\n")).toHaveLength(expected);
      expect(logs.split("\n")[0]).toBe(`line-${351 - expected}`);
      expect(fixture.calls[0].args).toEqual(["-n", helper, "recent-logs"]);
      const direct = logExecutor("");
      await recentLogs(requested, direct.execute, { exists: () => false });
      expect(direct.calls[0].args[3]).toBe(String(expected));
    }
  });

  it("redacts before line and character clipping and caps returned success and error output", async () => {
    const fixture = logExecutor(`token=${"credential".repeat(9000)}\n${"safe ".repeat(15000)}\n`);
    const logs = await recentLogs(2, fixture.execute, { helper, exists: () => true });
    expect(logs).not.toContain("credential");
    expect(logs.length).toBeLessThanOrEqual(64 * 1024);
    const failure = logExecutor("", `GATEWAY_TOKEN=${"private".repeat(15000)}\n${"failure ".repeat(15000)}`);
    const error = await recentLogs(2, failure.execute, { helper, exists: () => true });
    expect(error).not.toContain("private");
    expect(error.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("reports and redacts denied helper access without attempting a broader fallback", async () => {
    const fixture = logExecutor("", "sudo denied GATEWAY_TOKEN=fixture-credential");
    expect(await recentLogs(80, fixture.execute, { helper, exists: () => true, isRoot: false }))
      .toBe("journalctl failed: sudo denied GATEWAY_TOKEN=[REDACTED]");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].command).toBe("sudo");
  });
});

describe("administrator service status", () => {
  it("does not block the event loop or request its own health endpoint", async () => {
    const commands: string[] = [];
    let release!: (value: { stdout: string; stderr: string }) => void;
    const execute = ((command: string) => {
      commands.push(command);
      return new Promise((resolve) => { release = resolve; });
    }) as Parameters<typeof serviceStatus>[2];
    const pending = serviceStatus("ready", 2, execute);
    let eventLoopRan = false;
    await new Promise<void>((resolve) => setImmediate(() => { eventLoopRan = true; resolve(); }));
    expect(eventLoopRan).toBe(true);
    expect(commands).toEqual(["systemctl"]);
    release({ stdout: "active\n", stderr: "" });
    const status = await pending;
    expect(status.active).toBe("active");
    expect(JSON.parse(status.healthz)).toEqual({ ok: true, codexState: "ready", clients: 2 });
  });
});

describe("administrator output redaction", () => {
  it("redacts environment, TOML, bearer and JWT credentials", () => {
    const input = [
      "Z_AI_API_KEY=super-secret-value",
      'experimental_bearer_token = "another-secret"',
      "Authorization: Bearer abcdefghijklmnop",
      "eyJabcdefghijk.abcdefghijk.abcdefghijk",
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).not.toContain("super-secret-value");
    expect(out).not.toContain("another-secret");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("eyJabcdefghijk");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a known secret split across stream chunks before tail clipping", () => {
    const knownValue = ["very-long", "credential-value", "across-chunks"].join("-");
    const ring = new RedactedOutputRing([knownValue], 48, 1024);
    const stream = ring.stream();
    stream.push(`prefix ${knownValue.slice(0, 12)}`);
    stream.push(`${knownValue.slice(12)} suffix\n`);
    stream.flush();
    expect(ring.value()).not.toContain(knownValue);
    expect(ring.value()).not.toContain(knownValue.slice(-12));
    expect(ring.value()).toContain("[REDACTED]");
    expect(ring.value().length).toBeLessThanOrEqual(48);
  });

  it("keeps stdout/stderr partial lines separate and omits oversized lines whole", () => {
    const knownValue = ["standalone", "credential-value"].join("-");
    const ring = new RedactedOutputRing([knownValue], 256, 64);
    const stdout = ring.stream();
    const stderr = ring.stream();
    stdout.push("ZHIPU_KEY=");
    stderr.push("ordinary stderr\n");
    stdout.push(`${knownValue}\n`);
    stderr.push(`${"x".repeat(80)}${knownValue}\nkept\n`);
    stdout.flush();
    stderr.flush();
    expect(ring.value()).toContain("ordinary stderr");
    expect(ring.value()).toContain("ZHIPU_KEY=[REDACTED]");
    expect(ring.value()).toContain("output line omitted");
    expect(ring.value()).toContain("kept");
    expect(ring.value()).not.toContain(knownValue);
  });
});

describe("administrator script allowlist", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const throwingSpawn = (() => { throw new Error("spawn exploded"); }) as typeof import("node:child_process").spawn;
  function fakeChild(pid: number | undefined = 123456) {
    const child = Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    const spawn = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
    return { child, spawn };
  }

  it("keeps timeout work locked until actual close and then returns the timeout result", async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const { child, spawn } = fakeChild();
    const completed = vi.fn();
    const first = runScript("providers/openai/setup.sh", {}, 100, spawn);
    void first.then(completed);
    try {
      await vi.advanceTimersByTimeAsync(100);
      if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      else expect(processKill).toHaveBeenCalledWith(-123456, "SIGKILL");
      expect(completed).not.toHaveBeenCalled();
      await expect(runScript("providers/openai/setup.sh", {}, 100, spawn)).resolves.toMatchObject({ code: 75, executionPending: true });
      expect(spawn).toHaveBeenCalledTimes(1);
      child.emit("close", null);
      await expect(first).resolves.toMatchObject({ code: 124, output: expect.stringContaining("timed out") });
      expect((await first).executionPending).toBeUndefined();
      await expect(runScript("providers/openai/setup.sh", {}, 100, throwingSpawn)).resolves.toMatchObject({ code: -1 });
    } finally { child.emit("close", null); await first; }
  });

  it("returns a bounded unconfirmed result without unlocking and ignores an old duplicate close", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
    const firstFixture = fakeChild(), secondFixture = fakeChild(123457);
    const first = runScript("providers/openai/setup.sh", {}, 100, firstFixture.spawn);
    let second: ReturnType<typeof runScript> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(5100);
      await expect(first).resolves.toMatchObject({ code: 124, executionPending: true, output: expect.stringContaining("unconfirmed") });
      await expect(runScript("providers/openai/setup.sh", {}, 100, secondFixture.spawn)).resolves.toMatchObject({ code: 75, executionPending: true });
      expect(secondFixture.spawn).not.toHaveBeenCalled();
      firstFixture.child.emit("close", null);
      second = runScript("providers/openai/setup.sh", {}, 100, secondFixture.spawn);
      firstFixture.child.emit("close", null);
      await expect(runScript("providers/openai/setup.sh", {}, 100, throwingSpawn)).resolves.toMatchObject({ code: 75 });
      secondFixture.child.emit("close", 0);
      await expect(second).resolves.toMatchObject({ code: 0 });
    } finally { firstFixture.child.emit("close", null); secondFixture.child.emit("close", null); await first; if (second) await second; }
  });

  it("does not treat an error event on an existing process as an exit confirmation", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockReturnValue(true);
    const { child, spawn } = fakeChild();
    const first = runScript("providers/openai/setup.sh", {}, 100, spawn);
    const completed = vi.fn();
    void first.then(completed);
    try {
      child.emit("error", new Error("synthetic process failure"));
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();
      await expect(runScript("providers/openai/setup.sh", {}, 100, spawn)).resolves.toMatchObject({ code: 75 });
      child.emit("close", 1);
      await expect(first).resolves.toMatchObject({ code: -1, output: expect.stringContaining("child process error") });
    } finally { child.emit("close", null); await first; }
  });

  it("releases an asynchronous spawn failure with no PID and ignores its late close", async () => {
    const firstFixture = fakeChild(), secondFixture = fakeChild();
    firstFixture.child.pid = undefined;
    const first = runScript("providers/openai/setup.sh", {}, 100, firstFixture.spawn);
    firstFixture.child.emit("error", new Error("spawn ENOENT"));
    await expect(first).resolves.toMatchObject({ code: -1 });
    const second = runScript("providers/openai/setup.sh", {}, 100, secondFixture.spawn);
    try {
      firstFixture.child.emit("close", -1);
      await expect(runScript("providers/openai/setup.sh", {}, 100, throwingSpawn)).resolves.toMatchObject({ code: 75 });
      secondFixture.child.emit("close", 0);
      await expect(second).resolves.toMatchObject({ code: 0 });
    } finally { secondFixture.child.emit("close", null); await second; }
  });

  it("copies only allowlisted boolean status fields from script output", () => {
    const output = '[codex-harness-result] {"changed":false,"restartRequired":false,"code":999,"output":"replace-output","executionPending":true,"other":"ignored"}\n';
    expect(scriptChangeResult({ code: 0, output })).toEqual({ code: 0, output, changed: false, restartRequired: false });
    expect(scriptChangeResult({ code: 124, output, executionPending: true })).toEqual({ code: 124, output, executionPending: true, changed: false, restartRequired: false });
  });
  it("cannot execute a caller-selected path", async () => {
    await expect(runScript("../../bin/anything", {})).resolves.toEqual({
      code: -1,
      output: "deploy script is not allowlisted",
    });
  });

  it("releases the single-operation lock when spawn throws synchronously", async () => {
    const first = await runScript("providers/openai/setup.sh", {}, 100, throwingSpawn);
    const second = await runScript("providers/openai/setup.sh", {}, 100, throwingSpawn);
    expect(first).toMatchObject({ code: -1 });
    expect(second).toMatchObject({ code: -1 });
    expect(second.output).not.toContain("正在运行");
  });
});
