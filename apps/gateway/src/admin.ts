/**
 * WebUI-facing administration: runs the SAME deploy scripts the interactive
 * installer uses for provider configuration, and
 * schedules the service restart that applies the changes.
 *
 * Security: these handlers are only reachable over the authenticated WS
 * (token + trusted host, same gate as every other RPC). Commands are fixed
 * script paths with env-var parameters — never shell strings from the client.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ProviderInfoReader } from "./provider-info.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** /opt/codex-harness/deploy (or the dev checkout equivalent). */
export const DEPLOY_DIR = path.resolve(HERE, "../../..", "deploy");
const SERVICE_UNIT = process.env.GATEWAY_UNIT ?? "codex-harness";
const SCRIPT_TIMEOUT_MS = 300_000;
const EXIT_CONFIRMATION_MS = 5_000;
const OUTPUT_CAP = 64 * 1024;
const ALLOWED_SCRIPTS = new Set([
  "providers/openai/setup.sh",
  "providers/zhipu-coding-plan/setup.sh",
  "providers/custom-openai/setup.sh",
]);
let scriptRunning = false;
const SECRET_ENV_NAMES = ["Z_AI_API_KEY", "ZHIPU_KEY", "CUSTOM_API_KEY", "CUSTOM_OPENAI_API_KEY", "GATEWAY_TOKEN", "EDGE_PASS", "AUTH_PASS"];
const execFileAsync = promisify(execFile);

/** Remove credential-shaped values before any script or journal output is
 * returned to the browser.  Deploy scripts must avoid printing secrets too;
 * this is the final containment boundary. */
export function redactSecrets(value: string, knownSecrets: string[] = []): string {
  // Remove labelled credentials first. A short literal value such as "token"
  // must not be allowed to rewrite the label before this pass sees it.
  let redacted = value
    .replace(/\b(Z_AI_API_KEY|ZHIPU_KEY|CUSTOM_API_KEY|CUSTOM_OPENAI_API_KEY|GATEWAY_TOKEN|EDGE_PASS|AUTH_PASS)\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s\r\n]*)/gi, "$1=[REDACTED]")
    .replace(/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|token|password|secret)|experimental_bearer_token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;\r\n]*)/gi, "$1=[REDACTED]")
    .replace(/\b(Authorization\s*:\s*Bearer|Bearer)\s+[A-Za-z0-9._~+\/-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
  const literals = [...new Set([...knownSecrets, ...SECRET_ENV_NAMES.map((name) => process.env[name] ?? "")])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of literals) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

interface LineCapture {
  push(chunk: string): void;
  flush(): void;
}

/**
 * A tail ring that only ever receives already-redacted complete lines.
 * stdout and stderr use separate LineCapture instances so partial lines from
 * different streams cannot be spliced together. Oversized lines are omitted
 * whole: truncating one before redaction could expose a credential suffix.
 */
export class RedactedOutputRing {
  private output = "";

  constructor(
    private readonly knownSecrets: string[],
    private readonly cap = OUTPUT_CAP,
    private readonly maxLineChars = OUTPUT_CAP,
  ) {}

  private appendSafe(value: string): void {
    this.output = (this.output + value).slice(-this.cap);
  }

  appendMessage(value: string): void {
    this.appendSafe(redactSecrets(value, this.knownSecrets));
  }

  stream(): LineCapture {
    let pending = "";
    let droppingOversizedLine = false;
    const omit = () => this.appendSafe("[admin] output line omitted: exceeded 64 KiB\n");
    return {
      push: (chunk: string) => {
        let rest = String(chunk);
        while (rest.length > 0) {
          const newline = rest.indexOf("\n");
          const part = newline < 0 ? rest : rest.slice(0, newline);
          if (!droppingOversizedLine) {
            if (pending.length + part.length > this.maxLineChars) {
              pending = "";
              omit();
              droppingOversizedLine = newline < 0;
            } else {
              pending += part;
              if (newline >= 0) {
                this.appendMessage(`${pending}\n`);
                pending = "";
              }
            }
          } else if (newline >= 0) {
            droppingOversizedLine = false;
          }
          if (newline < 0) break;
          rest = rest.slice(newline + 1);
        }
      },
      flush: () => {
        if (!droppingOversizedLine && pending) this.appendMessage(pending);
        pending = "";
        droppingOversizedLine = false;
      },
    };
  }

  value(): string {
    return this.output;
  }
}

export interface ScriptResult {
  code: number;
  output: string;
  changed?: boolean;
  restartRequired?: boolean;
  /** The caller returned, but a configuration process is not confirmed dead. */
  executionPending?: true;
}

export function scriptChangeResult(result: ScriptResult): ScriptResult {
  if (result.code !== 0) return { ...result, changed: false, restartRequired: false };
  const line = result.output.trimEnd().split("\n").reverse().find((entry) => entry.startsWith("[codex-harness-result] "));
  if (line) {
    try {
      const status = JSON.parse(line.slice("[codex-harness-result] ".length));
      if (status && typeof status.changed === "boolean" && typeof status.restartRequired === "boolean") {
        return { ...result, changed: status.changed, restartRequired: status.restartRequired };
      }
    } catch { /* old script: conservative successful change */ }
  }
  return { ...result, changed: true, restartRequired: true };
}

/** Run a deploy script unattended (env-var driven), capture combined output. */
export function runScript(
  script: string,
  env: Record<string, string>,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  spawnImpl: typeof spawn = spawn,
): Promise<ScriptResult> {
  if (!ALLOWED_SCRIPTS.has(script)) {
    return Promise.resolve({ code: -1, output: "deploy script is not allowlisted" });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return Promise.resolve({ code: -1, output: "invalid deploy script timeout" });
  const full = path.join(DEPLOY_DIR, script);
  if (!existsSync(full)) {
    return Promise.resolve({ code: -1, output: `script not found on the server: ${script}` });
  }
  if (scriptRunning) return Promise.resolve({ code: 75, executionPending: true, output: "已有服务器配置操作正在运行，请等待完成后重试" });
  scriptRunning = true;
  const secrets = SECRET_ENV_NAMES.map((name) => env[name]).filter((value): value is string => !!value);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl("bash", [full], {
        cwd: DEPLOY_DIR,
        env: { ...process.env, ...env, DEPLOY_NONINTERACTIVE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err: any) {
      scriptRunning = false;
      resolve({ code: -1, output: redactSecrets(`[admin] spawn failed: ${err?.message ?? String(err)}`, secrets) });
      return;
    }
    const ring = new RedactedOutputRing(secrets);
    const stdout = ring.stream();
    const stderr = ring.stream();
    let settled = false;
    let closed = false;
    let stopRequested = false;
    let failureCode: number | undefined;
    let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
    // Settling the caller is separate from releasing the operation lock. A
    // failed kill or delayed exit must not admit another configuration writer.
    const settle = (result: ScriptResult) => {
      if (settled) return;
      settled = true;
      stdout.flush();
      stderr.flush();
      if (result.output) ring.appendMessage(result.output);
      resolve({ ...result, output: ring.value() });
    };
    const confirmClosed = (result: ScriptResult) => {
      if (closed) return;
      closed = true;
      scriptRunning = false;
      clearTimeout(timer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
      settle(result);
    };
    const requestStop = (code: number, message: string) => {
      if (closed || stopRequested) return;
      stopRequested = true;
      failureCode = code;
      clearTimeout(timer);
      ring.appendMessage(message);
      confirmationTimer = setTimeout(() => {
        settle({ code, executionPending: true, output: "\n[admin] process termination is unconfirmed; the configuration lock remains held until close" });
      }, EXIT_CONFIRMATION_MS);
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        ring.appendMessage("\n[admin] could not confirm process termination after kill request");
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (!settled) stdout.push(chunk); });
    child.stderr?.on("data", (chunk: string) => { if (!settled) stderr.push(chunk); });
    child.stdout?.on("end", () => stdout.flush());
    child.stderr?.on("end", () => stderr.flush());
    const timer = setTimeout(() => {
      requestStop(124, "\n[admin] script timed out");
    }, timeoutMs);
    child.on("close", (code) => {
      confirmClosed({ code: failureCode ?? code ?? -1, output: "" });
    });
    child.on("error", (err) => {
      if (!child.pid) {
        // ENOENT/EACCES with no PID means no process was created. Its late
        // close event must not unlock a subsequently started operation.
        confirmClosed({ code: -1, output: `\n[admin] spawn failed: ${err.message}` });
      } else requestStop(-1, `\n[admin] child process error: ${err.message}`);
    });
  });
}

/**
 * Start the systemd restart ~1s from now so its acknowledgement can reach
 * the browser first. The returned promise tracks the actual restart command;
 * the management gate retains the pending state until it settles.
 */
export async function scheduleServiceRestart(): Promise<void> {
  // Worker data-plane code may configure its own provider, but can neither
  // restart the control plane nor inherit its sudo grant.
  if (process.env.CODEX_HARNESS_WORKER === "1") return;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const helper = process.env.CODEX_HARNESS_ADMIN_HELPER ?? "/usr/local/libexec/codex-harness-admin";
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const command = existsSync(helper) ? (isRoot ? helper : "sudo") : "systemctl";
  const args = existsSync(helper)
    ? (isRoot ? ["restart-service"] : ["-n", helper, "restart-service"])
    : ["restart", SERVICE_UNIT];
  await execFileAsync(command, args, { timeout: 15_000, maxBuffer: OUTPUT_CAP, windowsHide: true });
}

export async function serviceStatus(
  codexState: string,
  clients = 0,
  execute: typeof execFileAsync = execFileAsync,
): Promise<{ unit: string; active: string; healthz: string }> {
  let active = "unknown";
  try {
    const r = await execute("systemctl", ["is-active", SERVICE_UNIT], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    const out = String(r.stdout ?? "").trim();
    if (out) active = out;
  } catch (err: any) {
    // is-active uses a nonzero exit status for ordinary inactive units.
    const out = typeof err?.stdout === "string" ? err.stdout.trim() : "";
    if (out) active = out;
  }
  // This is the same in-process state used by /healthz. Never synchronously
  // request our own HTTP server: that blocks its event loop until timeout.
  return { unit: SERVICE_UNIT, active, healthz: JSON.stringify({ ok: true, codexState, clients }) };
}

export async function recentLogs(
  lines = 80,
  execute: typeof execFileAsync = execFileAsync,
  runtime: { helper?: string; exists?: typeof existsSync; isRoot?: boolean } = {},
): Promise<string> {
  const count = Number.isFinite(lines) ? Math.max(1, Math.min(300, Math.trunc(lines))) : 80;
  const helper = runtime.helper ?? process.env.CODEX_HARNESS_ADMIN_HELPER ?? "/usr/local/libexec/codex-harness-admin";
  const hasHelper = (runtime.exists ?? existsSync)(helper);
  const isRoot = runtime.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  // Installed services receive only the fixed instance-scoped helper grant.
  // Never pass caller-controlled line counts or unit names through sudo.
  const command = hasHelper ? (isRoot ? helper : "sudo") : "journalctl";
  const args = hasHelper
    ? (isRoot ? ["recent-logs"] : ["-n", helper, "recent-logs"])
    : ["-u", SERVICE_UNIT, "-n", String(count), "--no-pager", "-o", "short"];
  try {
    const r = await execute(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    // Redact before taking the tail. Clipping first can cut the label or the
    // leading bytes off a secret and leave an unrecognisable secret suffix in
    // the returned journal excerpt.
    const redacted = redactSecrets(r.stdout ?? "");
    const trailingNewline = redacted.endsWith("\n");
    const rows = redacted.split("\n");
    if (trailingNewline) rows.pop();
    return (rows.slice(-count).join("\n") + (trailingNewline ? "\n" : "")).slice(-OUTPUT_CAP);
  } catch (err) {
    return redactSecrets(`journalctl failed: ${err instanceof Error ? err.message : String(err)}`).slice(-OUTPUT_CAP);
  }
}

/**
 * One-click catalog sync: re-runs the ACTIVE provider's setup script
 * unattended with the current settings, which re-fetches the live model
 * catalog and rewrites models.json. Paid reasoning probes remain an explicit
 * setup-script opt-in. The caller schedules the restart afterwards.
 */
export async function syncCatalog(providerInfo: ProviderInfoReader): Promise<ScriptResult & { mode: string }> {
  const { mode, model, custom } = providerInfo.adminSnapshot();
  const env: Record<string, string> = { CODEX_HOME: process.env.CODEX_HOME ?? "" };
  if (mode === "zhipu") {
    env.ZHIPU_SYNC_CATALOG = "1";
    env.PROBE_REASONING = "0";
    const r = await runScript("providers/zhipu-coding-plan/setup.sh", env);
    return { ...scriptChangeResult(r), mode };
  }
  if (mode === "custom") {
    const ep = custom;
    if (!ep) return { code: -1, output: "custom 端点信息无法从 config.toml 解析（base_url 缺失）", mode };
    const r = await runScript("providers/custom-openai/setup.sh", {
      ...env,
      CUSTOM_BASE_URL: ep.baseUrl,
      CUSTOM_MODEL: model || "",
      CUSTOM_REUSE_API_KEY: "1",
      CUSTOM_SYNC_CATALOG: "1",
      PROBE_REASONING: "0",
      CUSTOM_CTX: String(ep.ctx),
      CUSTOM_VISION: ep.vision ? "1" : "0",
    });
    return { ...scriptChangeResult(r), mode };
  }
  return { code: 0, changed: false, restartRequired: false, output: "OpenAI 原生模式使用 codex 内置目录，无需同步。", mode };
}
