import { AppServerConnection, initialize } from "./rpc.js";
import { redactSecrets } from "../admin.js";
import type { RequestMethod, RequestParams, ResponseFor } from "../protocol.js";

export type CodexState = "starting" | "ready" | "restarting" | "stopped";

export interface SupervisorEvents {
  onNotification(method: string, params: unknown): void;
  onServerRequest(id: number | string, method: string, params: unknown): Promise<unknown>;
  onStateChange(state: CodexState): void;
}

export interface SupervisorConnection {
  spawn(): void;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  kill(): void;
}

export type SupervisorConnectionFactory = (handlers: import("./rpc.js").AppServerHandlers) => SupervisorConnection;

const CLIENT_INFO = {
  name: "codex-harness-webui",
  title: "Codex Harness WebUI",
  version: "1.0.1",
};

const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const MAX_STDERR_LINE_CHARS = 64 * 1024;

/**
 * Keeps a single long-lived `codex app-server` child alive across crashes.
 * Because `command/exec` processes are scoped to this connection, keeping it
 * alive lets running turns survive browser disconnects. Browser-owned terminals
 * are separately terminated by the gateway when their owning connection closes.
 */
export class CodexSupervisor {
  state: CodexState = "stopped";
  private conn: SupervisorConnection | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private readyWaiters = new Set<{
    resolve(): void;
    reject(err: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stopping = false;
  /** Monotonic connection generation; stale child callbacks are ignored. */
  private generation = 0;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly events: SupervisorEvents,
    private readonly connectionFactory?: SupervisorConnectionFactory,
  ) {}

  start(): void {
    if (this.state !== "stopped" || this.conn || this.restartTimer) return;
    this.stopping = false;
    this.restartAttempt = 0;
    this.spawnConnection();
  }

  private setState(state: CodexState): void {
    if (this.state === state) return;
    this.state = state;
    try {
      this.events.onStateChange(state);
    } catch (err: any) {
      process.stderr.write(`[gateway] state-change handler failed: ${redactSecrets(err?.message ?? String(err))}\n`);
    }
    if (state === "ready") {
      const waiters = [...this.readyWaiters];
      this.readyWaiters.clear();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  private spawnConnection(): void {
    if (this.stopping) return;
    this.setState("starting");
    if (this.stopping) return;
    const generation = ++this.generation;
    let conn: SupervisorConnection;
    let stderrPending = "";
    let droppingOversizedLine = false;
    const writeStderrLine = (line: string) => {
      if (this.isCurrent(conn, generation)) {
        process.stderr.write(`[app-server] ${redactSecrets(line)}`);
      }
    };
    const consumeStderr = (chunk: string) => {
      let rest = String(chunk);
      while (rest.length > 0) {
        const newline = rest.indexOf("\n");
        const part = newline < 0 ? rest : rest.slice(0, newline);
        if (!droppingOversizedLine) {
          if (stderrPending.length + part.length > MAX_STDERR_LINE_CHARS) {
            // Never emit fragments of an oversized line: a credential name
            // and its value could straddle the truncation point.
            stderrPending = "";
            writeStderrLine("[stderr line omitted: exceeded 64 KiB]\n");
            droppingOversizedLine = newline < 0;
          } else {
            stderrPending += part;
            if (newline >= 0) {
              writeStderrLine(`${stderrPending}\n`);
              stderrPending = "";
            }
          }
        } else if (newline >= 0) {
          droppingOversizedLine = false;
        }
        if (newline < 0) break;
        rest = rest.slice(newline + 1);
      }
    };
    const flushStderr = () => {
      if (!droppingOversizedLine && stderrPending) writeStderrLine(stderrPending);
      stderrPending = "";
      droppingOversizedLine = false;
    };
    const handlers: import("./rpc.js").AppServerHandlers = {
      onNotification: (method, params) => {
        if (this.isCurrent(conn, generation)) this.events.onNotification(method, params);
      },
      onServerRequest: async (id, method, params) => {
        if (!this.isCurrent(conn, generation)) {
          throw new Error("request came from a stale app-server connection");
        }
        const result = await this.events.onServerRequest(id, method, params);
        // Browser approvals and remote tool calls can outlive a crash. Never
        // let a late result be treated as belonging to the replacement.
        if (!this.isCurrent(conn, generation)) {
          throw new Error("server request completed for a stale app-server connection");
        }
        return result;
      },
      onStderr: (chunk) => {
        if (this.isCurrent(conn, generation)) consumeStderr(chunk);
      },
      onExit: () => {
        if (this.isCurrent(conn, generation)) flushStderr();
        this.handleExit(conn, generation);
      },
    };
    try {
      conn = this.connectionFactory?.(handlers)
        ?? new AppServerConnection(this.command, this.args, this.env, handlers);
    } catch (err: any) {
      process.stderr.write(`[gateway] app-server connection creation failed: ${redactSecrets(err?.message ?? String(err))}\n`);
      this.scheduleRestart();
      return;
    }
    this.conn = conn;
    try {
      conn.spawn();
    } catch (err: any) {
      process.stderr.write(`[gateway] app-server spawn threw: ${redactSecrets(err?.message ?? String(err))}\n`);
      this.handleExit(conn, generation);
      return;
    }
    // A custom/future transport may report exit synchronously from spawn().
    if (!this.isCurrent(conn, generation)) return;
    void initialize(conn, CLIENT_INFO)
      .then(() => {
        if (!this.isCurrent(conn, generation)) return;
        this.restartAttempt = 0;
        this.setState("ready");
      })
      .catch((err) => {
        if (!this.isCurrent(conn, generation)) return;
        process.stderr.write(`[gateway] initialize failed: ${redactSecrets(String(err))}\n`);
        // Killing triggers onExit -> scheduleRestart, so no double restart here.
        try {
          conn.kill();
        } catch (killErr: any) {
          process.stderr.write(`[gateway] failed to kill uninitialized app-server: ${redactSecrets(killErr?.message ?? String(killErr))}\n`);
        }
        // A transport implementation is not required to synthesize onExit
        // from kill(); advance even when no child exit event follows.
        this.handleExit(conn, generation);
      });
  }

  private isCurrent(conn: SupervisorConnection, generation: number): boolean {
    return !this.stopping && this.conn === conn && this.generation === generation;
  }

  private handleExit(conn: SupervisorConnection, generation: number): void {
    // Spawn error + exit, or a late exit from an older generation, must not
    // tear down the replacement connection or schedule duplicate restarts.
    if (this.conn !== conn || this.generation !== generation) return;
    this.conn = null;
    if (this.stopping) {
      this.setState("stopped");
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    this.setState("restarting");
    if (this.stopping) return;
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartAttempt += 1;
    process.stderr.write(`[gateway] restarting app-server in ${delay}ms (attempt ${this.restartAttempt})\n`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnConnection();
    }, delay);
  }

  /** Resolves once the connection is ready; rejects if it takes too long. */
  async waitReady(timeoutMs = 60_000): Promise<void> {
    if (this.state === "ready") return;
    if (this.stopping || this.state === "stopped") throw new Error("app-server is stopped");
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.readyWaiters.delete(waiter);
          reject(new Error("app-server not ready in time"));
        }, timeoutMs),
      };
      this.readyWaiters.add(waiter);
    });
  }

  async request<M extends RequestMethod>(method: M, params: RequestParams<M>): Promise<ResponseFor<M>> {
    if (this.state !== "ready") await this.waitReady();
    if (!this.conn) throw new Error("app-server connection unavailable");
    return this.conn.request<ResponseFor<M>>(method, params);
  }

  stop(): void {
    this.stopping = true;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const conn = this.conn;
    this.conn = null;
    try { conn?.kill(); } catch (err: any) {
      process.stderr.write(`[gateway] app-server stop failed: ${redactSecrets(err?.message ?? String(err))}\n`);
    }
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("app-server stopped before becoming ready"));
    }
    this.setState("stopped");
  }
}
