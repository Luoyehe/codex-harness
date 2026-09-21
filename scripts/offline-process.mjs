import { spawn, spawnSync } from "node:child_process";

// Only processes created here can be stopped. POSIX children receive their own
// process group; Windows uses taskkill against the exact freshly spawned PID.
const owned = new WeakMap();
export function spawnOfflineChild(command, args, options) {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32", windowsHide: true });
  const state = { closed: false, stopped: false };
  owned.set(child, state);
  child.once("close", () => { state.closed = true; });
  // Callers can additionally observe errors; an unsuccessful spawn must not
  // crash before their finally block can clean up the disposable fixture.
  child.on("error", () => {});
  return child;
}

async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return predicate();
}

export async function stopOfflineChild(child, { graceMs = 2000, forceMs = 5000, requireCleanExit = false } = {}) {
  const state = owned.get(child);
  if (!state) throw new Error("offline process cleanup refused: child is not owned by this verifier");
  for (const value of [graceMs, forceMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) throw new Error("invalid offline cleanup timeout");
  if (state.stopped || !child.pid) return; // Spawn failure created no process tree.
  const failed = () => new Error("offline process cleanup unconfirmed; disposable fixture retained for inspection");
  if (process.platform === "win32") {
    // Once an unexpected parent exit loses the tree's identity, taskkill can
    // no longer certify descendants. Retain the fixture instead of guessing.
    if (state.closed) throw failed();
    const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: forceMs });
    if (killed.status !== 0) throw failed();
    if (!await until(() => state.closed, forceMs)) throw failed();
    state.stopped = true;
    return;
  }
  const signal = value => {
    try { process.kill(-child.pid, value); return true; }
    catch (error) { if (error?.code === "ESRCH") return false; throw failed(); }
  };
  const stopped = () => !signal(0) && state.closed;
  const confirm = () => {
    // Gateway workers own separate POSIX groups. Only the gateway's orderly
    // exit confirms its nested supervisors finished; killing its group alone
    // cannot certify those detached workers and must not produce a smoke PASS.
    if (requireCleanExit && child.exitCode !== 0) throw failed();
    state.stopped = true;
  };
  signal("SIGTERM");
  if (await until(stopped, graceMs)) { confirm(); return; }
  signal("SIGKILL");
  if (!await until(stopped, forceMs)) throw failed();
  confirm();
}
