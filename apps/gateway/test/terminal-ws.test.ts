import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { verifyWebSocketAuth } from "../../../deploy/ws-auth-probe.mjs";

const gatewayEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// Run after the gateway build. The fixture is Node itself executing this file
// named "app-server" in its temporary cwd, so no executable shim, real Codex,
// shell, provider, or inherited user credentials participate on any platform.
const fakeAppServer = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const home = process.env.CODEX_HOME;
const journal = path.join(home, "events.jsonl");
const hold = path.join(home, "hold-initialize");
const restart = path.join(home, "restart-now");
const pendingExec = new Map();
const pendingModels = [];
let initialize;
const record = (event) => fs.appendFileSync(journal, JSON.stringify(event) + "\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
record({ method: "fixture/launched", pid: process.pid });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  record({ method, params });
  if (id == null) return;
  if (method === "initialize") {
    if (fs.existsSync(hold)) initialize = id;
    else reply(id, { userAgent: "synthetic-app-server" });
  } else if (method === "command/exec") {
    // Deliberately do not execute params.command. A deferred response models
    // the actual exec lifecycle until this exact simulated process is stopped.
    pendingExec.set(params.processId, id);
  } else if (method === "command/exec/terminate") {
    const execId = pendingExec.get(params.processId);
    pendingExec.delete(params.processId);
    reply(id, {});
    if (execId != null) reply(execId, { exitCode: 0, stdout: "", stderr: "" });
  } else if (method === "model/list") {
    if (fs.existsSync(path.join(home, "hold-models"))) pendingModels.push(id);
    else reply(id, { data: [], nextCursor: null });
  }
  else if (method === "account/read") reply(id, { account: null, requiresOpenaiAuth: true });
  else reply(id, {});
});
input.on("close", () => process.exit(0));
setInterval(() => {
  if (!fs.existsSync(path.join(home, "hold-models"))) {
    for (const id of pendingModels.splice(0)) reply(id, { data: [], nextCursor: null });
  }
  if (fs.existsSync(restart)) {
    fs.unlinkSync(restart);
    record({ method: "fixture/restarting" });
    process.exit(0);
  }
  if (initialize != null && !fs.existsSync(hold)) {
    reply(initialize, { userAgent: "synthetic-app-server" });
    initialize = undefined;
  }
}, 25);
// A failed test cannot leave this harmless fixture alive indefinitely.
setTimeout(() => process.exit(0), 20000).unref();
`;

type WireMessage = { kind: string; id?: number; method?: string; params?: any; result?: any; error?: string };
type Recorded = { method: string; params?: { processId?: string }; pid?: number };

class BrowserClient {
  readonly socket: WebSocket;
  readonly notifications: WireMessage[] = [];
  readonly opened: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(url: string, token: string) {
    // This protocol fixture is not a browser cookie jar. Authenticate using
    // the supported non-browser header; cookie naming/bootstrap is covered by
    // the HTTP authentication tests and must not be hard-coded here.
    this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}`, Origin: url.replace(/^ws:/, "http:").replace(/\/ws$/, "") } });
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.terminate(); reject(new Error("fixture WebSocket open timed out")); }, 3000);
      this.socket.once("open", () => { clearTimeout(timer); resolve(); });
      this.socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as WireMessage;
      if (message.kind === "notification") this.notifications.push(message);
      if (message.kind !== "rpcResult" || message.id == null) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    });
    const closed = () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("fixture socket closed")); }
      this.pending.clear();
    };
    this.socket.on("close", closed);
    this.socket.on("error", closed);
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("fixture socket is not open"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`fixture RPC timed out: ${method}`)); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ kind: "rpc", id, method, params }));
    });
  }

  close(): void { this.socket.terminate(); }
}

async function reservePort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to reserve port");
  return { server, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function makeFixture(port: number) {
  const scratch = mkdtempSync(path.join(tmpdir(), "gateway ws lifecycle "));
  const codexHome = path.join(scratch, "codex-home");
  const workspace = path.join(scratch, "workspace");
  mkdirSync(codexHome); mkdirSync(workspace);
  writeFileSync(path.join(workspace, "app-server"), fakeAppServer);
  const token = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { CODEX_BIN: process.execPath, CODEX_HOME: codexHome, CODEX_WORKSPACE: workspace,
    GATEWAY_TOKEN: token, GATEWAY_CONTROL_HOME: path.join(scratch, "control"), GATEWAY_UNSAFE_SINGLE_USER: "1",
    HOST: "127.0.0.1", PORT: String(port), GATEWAY_BOOTSTRAP_AUTH: "required", ALLOW_QUERY_TOKEN: "0" });
  const clients: BrowserClient[] = [];
  let child: ChildProcess | undefined;
  let errors = "";
  const events = (): Recorded[] => {
    const journal = path.join(codexHome, "events.jsonl");
    return existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  return {
    codexHome, workspace, events,
    verifyAuth: () => verifyWebSocketAuth({ port, token, timeoutMs: 2000, log: () => {} }),
    launch() {
      child = spawn(process.execPath, [gatewayEntry], { cwd: workspace, env, stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true, detached: process.platform !== "win32" });
      child.stderr?.on("data", (chunk) => { errors = (errors + chunk.toString()).slice(-8000); });
      child.on("error", (error) => { errors += error.message; });
      return child;
    },
    async ready() {
      await vi.waitFor(async () => {
        expect(child?.exitCode, errors).toBeNull();
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        expect((await response.json() as { codexState: string }).codexState, errors).toBe("ready");
      }, { timeout: 6000, interval: 30 });
    },
    async browser() {
      const browser = new BrowserClient(`ws://127.0.0.1:${port}/ws`, token);
      clients.push(browser);
      await browser.opened;
      return browser;
    },
    errors: () => errors,
    async cleanup() {
      for (const browser of clients) browser.close();
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        } else {
          try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
        }
        try {
          await vi.waitFor(() => expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true), { timeout: 3000 });
        } catch {
          if (process.platform === "win32") {
            spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 3000 });
          } else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
          }
          await vi.waitFor(() => expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true), { timeout: 2000 });
        }
      }
      // Only the exact directory returned by mkdtemp is removed. All fixture
      // descendants also self-exit on EOF or the bounded watchdog above.
      await vi.waitFor(() => rmSync(scratch, { recursive: true, force: true }), { timeout: 3000 });
    },
  };
}

describe.runIf(existsSync(gatewayEntry))("built gateway WebSocket terminal lifecycle (synthetic app-server)", () => {
  it("bounds actual socket concurrency without starving operation reconciliation", async () => {
    const reserved = await reservePort(); await closeServer(reserved.server);
    const fixture = makeFixture(reserved.port);
    const work: Promise<any>[] = [];
    try {
      fixture.launch(); await fixture.ready();
      const clients = await Promise.all(Array.from({ length: 5 }, () => fixture.browser()));
      const initial = fixture.events().filter((event) => event.method === "model/list").length;
      writeFileSync(path.join(fixture.codexHome, "hold-models"), "synthetic flow control");
      for (const client of clients.slice(0, 4)) {
        for (let index = 0; index < 8; index++) {
          const pending = client.rpc("model/list");
          void pending.catch(() => {});
          work.push(pending);
        }
      }
      await vi.waitFor(() => expect(fixture.events().filter((event) => event.method === "model/list")).toHaveLength(initial + 32));
      await expect(clients[0].rpc("model/list")).rejects.toThrow("队列");
      await expect(clients[4].rpc("model/list")).rejects.toThrow("队列");
      // This read-only lookup must use the reserved control budget even when
      // ordinary calls exhaust both the socket and global admissions.
      const reconciliation = await clients[0].rpc("turn/operation", { clientOperationId: randomUUID() });
      expect(reconciliation).toBeDefined();
      await expect(clients[0].rpc("management/status")).resolves.toMatchObject({ state: "idle" });
      expect(fixture.events().filter((event) => event.method === "model/list")).toHaveLength(initial + 32);
      rmSync(path.join(fixture.codexHome, "hold-models"));
      await Promise.all(work);
      await expect(clients[4].rpc("model/list")).resolves.toEqual({ data: [], nextCursor: null });
    } finally { await fixture.cleanup(); await Promise.allSettled(work); }
  }, 15000);

  it("routes disconnect cleanup to the owner and refuses creation while the app-server restarts", async () => {
    const reserved = await reservePort(); await closeServer(reserved.server);
    const fixture = makeFixture(reserved.port);
    try {
      fixture.launch(); await fixture.ready();
      expect(await fixture.verifyAuth()).toBe(true);
      const a = await fixture.browser(), b = await fixture.browser();
      const aid = randomUUID(), bid = randomUUID();
      expect(await a.rpc("terminal/exec", { processId: aid, cols: 120, rows: 40 })).toEqual({ processId: aid });
      expect(await b.rpc("terminal/exec", { processId: bid, cols: 100, rows: 30 })).toEqual({ processId: bid });
      await vi.waitFor(() => expect(fixture.events().filter((event) => event.method === "command/exec")).toHaveLength(2));
      await expect(b.rpc("terminal/write", { processId: aid, base64: Buffer.from("synthetic input").toString("base64") })).rejects.toThrow("connection");
      await expect(b.rpc("terminal/terminate", { processId: aid })).rejects.toThrow("connection");
      a.close();
      await vi.waitFor(() => expect(fixture.events().filter((event) => event.method === "command/exec/terminate").map((event) => event.params?.processId)).toEqual([aid]), { timeout: 3000 });
      await b.rpc("terminal/write", { processId: bid, base64: Buffer.from("still owned by B").toString("base64") });
      await b.rpc("terminal/resize", { processId: bid, cols: 144, rows: 48 });
      expect(fixture.events().filter((event) => event.method === "command/exec/terminate").map((event) => event.params?.processId)).toEqual([aid]);
      expect(fixture.events().filter((event) => event.method === "command/exec/write").map((event) => event.params?.processId)).toEqual([bid]);

      writeFileSync(path.join(fixture.codexHome, "hold-initialize"), "synthetic control");
      writeFileSync(path.join(fixture.codexHome, "restart-now"), "synthetic control");
      await vi.waitFor(() => expect(b.notifications.some((event) => event.method === "appServer/stateChanged" && event.params?.state === "restarting")).toBe(true), { timeout: 3000 });
      const rejectedId = randomUUID();
      await expect(b.rpc("terminal/exec", { processId: rejectedId })).rejects.toThrow("not ready");
      rmSync(path.join(fixture.codexHome, "hold-initialize"));
      await fixture.ready();
      expect(fixture.events().filter((event) => event.method === "command/exec").map((event) => event.params?.processId)).toEqual([aid, bid]);
      await expect(b.rpc("terminal/write", { processId: bid, base64: "eA==" })).rejects.toThrow("not active");
      expect(b.notifications.some((event) => event.method === "terminal/allExited")).toBe(true);
    } finally { await fixture.cleanup(); }
  }, 15000);

  it("does not start an app-server child when the gateway listener is already occupied", async () => {
    const reserved = await reservePort();
    const fixture = makeFixture(reserved.port);
    try {
      const child = fixture.launch();
      await vi.waitFor(() => expect(child.exitCode, fixture.errors()).toBe(1), { timeout: 5000 });
      expect(fixture.errors()).toContain("failed to listen");
      expect(fixture.events()).toEqual([]);
    } finally { await fixture.cleanup(); await closeServer(reserved.server); }
  }, 10000);
});
