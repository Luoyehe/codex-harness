/**
 * WebUI-facing administration: runs the SAME deploy scripts the interactive
 * installer uses (single source of truth for provider/edge/service logic) and
 * schedules the service restart that applies the changes.
 *
 * Security: these handlers are only reachable over the authenticated WS
 * (token + trusted host, same gate as every other RPC). Commands are fixed
 * script paths with env-var parameters — never shell strings from the client.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderInfoReader } from "./provider-info.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** /opt/codex-harness/deploy (or the dev checkout equivalent). */
export const DEPLOY_DIR = path.resolve(HERE, "../../..", "deploy");
const SERVICE_UNIT = process.env.GATEWAY_UNIT ?? "codex-harness";
const SCRIPT_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 64 * 1024;

export interface ScriptResult {
  code: number;
  output: string;
}

/** Run a deploy script unattended (env-var driven), capture combined output. */
export function runScript(script: string, env: Record<string, string>, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ScriptResult> {
  const full = path.join(DEPLOY_DIR, script);
  if (!existsSync(full)) {
    return Promise.resolve({ code: -1, output: `script not found on the server: ${script}` });
  }
  return new Promise((resolve) => {
    const child = spawn("bash", [full], {
      cwd: DEPLOY_DIR,
      env: { ...process.env, ...env, DEPLOY_NONINTERACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const clip = (s: string) => {
      if (out.length < OUTPUT_CAP) out += s;
    };
    child.stdout.on("data", (d: Buffer) => clip(d.toString()));
    child.stderr.on("data", (d: Buffer) => clip(d.toString()));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      clip("\n[admin] script timed out");
      resolve({ code: 124, output: out });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: out });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${out}\n[admin] spawn failed: ${err.message}` });
    });
  });
}

/**
 * Restart the systemd unit ~1s from now, detached, so the HTTP/WS response
 * that triggered it can reach the browser first. The frontend's reconnect
 * logic picks the gateway back up automatically.
 */
export function scheduleServiceRestart(): void {
  setTimeout(() => {
    try {
      spawn("systemctl", ["restart", SERVICE_UNIT], { detached: true, stdio: "ignore" }).unref();
    } catch (err: any) {
      process.stderr.write(`[admin] restart scheduling failed: ${err?.message}\n`);
    }
  }, 1_000);
}

export function serviceStatus(): { unit: string; active: string; healthz: string } {
  let active = "unknown";
  try {
    const r = spawnSync("systemctl", ["is-active", SERVICE_UNIT], { encoding: "utf8", timeout: 5_000 });
    const out = (r.stdout ?? "").trim();
    if (out) active = out;
  } catch { /* keep unknown */ }
  let healthz = "";
  try {
    const port = process.env.PORT ?? "8410";
    const res = spawnSync("curl", ["-s", "-m", "3", `http://127.0.0.1:${port}/healthz`], { encoding: "utf8", timeout: 5_000 });
    healthz = (res.stdout ?? "").trim();
  } catch { /* empty */ }
  return { unit: SERVICE_UNIT, active, healthz };
}

export function recentLogs(lines = 80): string {
  try {
    const r = spawnSync("journalctl", ["-u", SERVICE_UNIT, "-n", String(lines), "--no-pager", "-o", "short"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    return (r.stdout ?? "").slice(-OUTPUT_CAP);
  } catch (err: any) {
    return `journalctl failed: ${err?.message}`;
  }
}

/**
 * One-click catalog sync: re-runs the ACTIVE provider's setup script
 * unattended with the current settings, which re-fetches the live model
 * catalog, re-probes the reasoning levels and rewrites models.json. The
 * caller schedules the restart afterwards.
 */
export async function syncCatalog(providerInfo: ProviderInfoReader): Promise<ScriptResult & { mode: string }> {
  const { mode, model } = providerInfo.readModeAndModel();
  const env: Record<string, string> = { CODEX_HOME: process.env.CODEX_HOME ?? "" };
  if (mode === "zhipu") {
    env.ZHIPU_MODEL = model || "glm-5.3";
    const r = await runScript("providers/zhipu-coding-plan/setup.sh", env);
    return { ...r, mode };
  }
  if (mode === "custom") {
    const ep = providerInfo.customEndpoint();
    if (!ep) return { code: -1, output: "custom 端点信息无法从 config.toml 解析（base_url 缺失）", mode };
    const r = await runScript("providers/custom-openai/setup.sh", {
      ...env,
      CUSTOM_BASE_URL: ep.baseUrl,
      CUSTOM_MODEL: model || "",
      CUSTOM_API_KEY: ep.token,
      CUSTOM_CTX: String(ep.ctx),
      CUSTOM_VISION: ep.vision ? "1" : "0",
    });
    return { ...r, mode };
  }
  return { code: 0, output: "OpenAI 原生模式使用 codex 内置目录，无需同步。", mode };
}
