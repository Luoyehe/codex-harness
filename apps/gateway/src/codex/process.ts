import { AppServerConnection, initialize } from "./rpc.js";

export type CodexState = "starting" | "ready" | "restarting" | "stopped";

export interface SupervisorEvents {
  onNotification(method: string, params: unknown): void;
  onServerRequest(id: number | string, method: string, params: unknown): Promise<unknown>;
  onStateChange(state: CodexState): void;
}

const CLIENT_INFO = {
  name: "codex-harness-webui",
  title: "Codex Harness WebUI",
  version: "1.0.0",
};

const RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * Keeps a single long-lived `codex app-server` child alive across crashes.
 * Because `command/exec` processes are scoped to this connection, keeping it
 * alive is what lets terminals and running turns survive browser disconnects.
 */
export class CodexSupervisor {
  state: CodexState = "stopped";
  private conn: AppServerConnection | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private readyWaiters: Array<() => void> = [];
  private stopping = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
    private readonly events: SupervisorEvents,
  ) {}

  start(): void {
    this.stopping = false;
    this.spawnConnection();
  }

  private setState(state: CodexState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange(state);
    if (state === "ready") {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w();
    }
  }

  private spawnConnection(): void {
    this.setState("starting");
    const conn = new AppServerConnection(this.command, this.args, this.env, {
      onNotification: (method, params) => this.events.onNotification(method, params),
      onServerRequest: (id, method, params) => this.events.onServerRequest(id, method, params),
      onStderr: (chunk) => process.stderr.write(`[app-server] ${chunk}`),
      onExit: () => this.handleExit(),
    });
    this.conn = conn;
    conn.spawn();
    void initialize(conn, CLIENT_INFO)
      .then(() => {
        this.restartAttempt = 0;
        this.setState("ready");
      })
      .catch((err) => {
        process.stderr.write(`[gateway] initialize failed: ${err}\n`);
        // Killing triggers onExit -> scheduleRestart, so no double restart here.
        conn.kill();
      });
  }

  private handleExit(): void {
    this.conn = null;
    if (this.stopping) {
      this.setState("stopped");
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    this.setState("restarting");
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("app-server not ready in time")), timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== "ready") await this.waitReady();
    if (!this.conn) throw new Error("app-server connection unavailable");
    return this.conn.request<T>(method, params);
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.conn?.kill();
    this.setState("stopped");
  }
}
