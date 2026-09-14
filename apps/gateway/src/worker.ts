/** Private data plane. No listening socket, gateway token or sudo grant.
 * Installed launchers execute this entrypoint as the data/Agent OS account. */
import { StringDecoder } from "node:string_decoder";
import process from "node:process";
import { createEngine } from "./engine.js";
import { redactSecrets } from "./admin.js";

const FRAME_CAP = 36 * 1024 * 1024;
const QUEUE_CAP = 48 * 1024 * 1024;
let stopping = false;
let pending = "";
let pendingBytes = 0;
const decoder = new StringDecoder("utf8");
let inFlight = 0;
// Only the installed Linux launcher supplies this marker after dropping UID.
// UNSAFE Linux and Windows/macOS development have no equivalent cleanup owner.
const managed = process.platform === "linux" && process.env.CODEX_HARNESS_MANAGED_WORKER === "1";
const engine = createEngine((clientId, message) => send({ method: "gateway/clientMessage", params: { clientId, message } }), {
  ...(managed ? { onFatalConnectionLoss: () => {
    stopping = true;
    process.stdin.pause();
    process.stderr.write("[worker] app-server connection lost; exiting for managed descendant cleanup\n");
    // Waiting for inner process-group cleanup can deadlock or miss reparented
    // PTYs. The root launcher owns this entire worker tree and waits for ECHILD.
    process.exit(1);
  } } : {}),
});

function send(value: unknown): void {
  if (stopping) return;
  const line = JSON.stringify(value) + "\n";
  const size = Buffer.byteLength(line);
  if (size > FRAME_CAP || process.stdout.writableLength + size > QUEUE_CAP) {
    void stop(1);
    return;
  }
  process.stdout.write(line);
}
async function handle(message: any): Promise<void> {
  if (typeof message?.method !== "string") return;
  const p = message.params ?? {};
  const id = message.id;
  if (inFlight >= 72) {
    if (id !== undefined) send({ id, error: { code: -32000, message: "worker request limit reached", data: { delivery: "rejected" } } });
    return;
  }
  inFlight++;
  try {
    let result: unknown;
    switch (message.method) {
      case "initialize": result = { userAgent: "codex-harness-private-worker" }; break;
      case "initialized": result = {}; break;
      case "gateway/connect": engine.connect(p.clientId); result = {}; break;
      case "gateway/disconnect": engine.disconnect(p.clientId); result = {}; break;
      case "gateway/answer": result = engine.answer(p.requestId, p.payload, p.error); break;
      case "gateway/dispatch": result = await engine.dispatch(p.method, p.params, p.clientId); break;
      default: throw new Error("unknown private worker method");
    }
    if (id !== undefined) send({ id, result });
  } catch (error: any) {
    if (id !== undefined) send({ id, error: { code: -32000, message: redactSecrets(error?.message ?? String(error)), data: { delivery: error?.delivery === "unknown" ? "unknown" : "rejected" } } });
  } finally { inFlight--; }
}
async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdin.pause();
  await engine.stop();
  process.exit(code);
}
process.stdin.on("data", (chunk: Buffer) => {
  if (stopping) return;
  const text = decoder.write(chunk);
  let offset = 0;
  for (;;) {
    const end = text.indexOf("\n", offset);
    const part = end < 0 ? text.slice(offset) : text.slice(offset, end);
    pendingBytes += Buffer.byteLength(part);
    if (pendingBytes > FRAME_CAP) { void stop(1); return; }
    pending += part;
    if (end < 0) break;
    const line = pending;
    pending = ""; pendingBytes = 0;
    try { void handle(JSON.parse(line)); } catch { void stop(1); return; }
    offset = end + 1;
  }
});
process.stdin.on("end", () => { void stop(); });
process.stdin.on("error", () => { void stop(1); });
process.stdout.on("error", () => { void stop(1); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stop(); });
engine.start();
