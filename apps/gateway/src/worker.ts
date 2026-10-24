/** Private data plane. No listening socket, gateway token or sudo grant.
 * Installed launchers execute this entrypoint as the data/Agent OS account. */
import { StringDecoder } from "node:string_decoder";
import process from "node:process";
import { createEngine } from "./engine.js";
import { redactSecrets } from "./admin.js";
import { ControlRequests } from "./control-requests.js";
import { encodeBounded, FLOW_LIMITS, HISTORY_READ_METHODS, WorkerRequestBudget } from "./flow-control.js";

const FRAME_CAP = 36 * 1024 * 1024;
const QUEUE_CAP = 48 * 1024 * 1024;
let stopping = false;
let pending = "";
let pendingBytes = 0;
const decoder = new StringDecoder("utf8");
const incoming = new WorkerRequestBudget();
const controlRequests = new ControlRequests(send);
// Only the installed Linux launcher supplies this marker after dropping UID.
// UNSAFE Linux and Windows/macOS development have no equivalent cleanup owner.
const managed = process.platform === "linux" && process.env.CODEX_HARNESS_MANAGED_WORKER === "1";
const engine = createEngine((clientId, message) => send({ method: "gateway/clientMessage", params: { clientId, message } }), {
  requestAutoCompaction: (threadId) => controlRequests.compact(threadId),
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
async function handle(message: any, frameBytes: number): Promise<void> {
  if (controlRequests.receive(message)) return;
  if (typeof message?.method !== "string") return;
  const p = message.params ?? {};
  const id = message.id;
  let release: () => void;
  try { release = incoming.acquire(message.method, p.method, frameBytes); }
  catch {
    if (id !== undefined) send({ id, error: { code: -32000, message: "worker request count/byte limit reached", data: { delivery: "rejected" } } });
    return;
  }
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
    if (id !== undefined) {
      // Validate history before serializing a private IPC response. The outer
      // HTTP limit is too late: an oversized worker frame would stop the tree.
      if (message.method === "gateway/dispatch" && HISTORY_READ_METHODS.has(p.method)) {
        try { encodeBounded(result, FLOW_LIMITS.historyBytes); }
        catch (error) { throw Object.assign(error as Error, { delivery: "unknown" }); }
      }
      send({ id, result });
    }
  } catch (error: any) {
    if (id !== undefined) send({ id, error: { code: -32000, message: redactSecrets(error?.message ?? String(error)), data: {
      delivery: error?.delivery === "unknown" ? "unknown" : "rejected",
      ...(error?.errorCode === "RESPONSE_TOO_LARGE" ? { errorCode: "RESPONSE_TOO_LARGE" } : {}),
    } } });
  } finally { release(); }
}
async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  controlRequests.close();
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
    const frameBytes = pendingBytes;
    pending = ""; pendingBytes = 0;
    try { void handle(JSON.parse(line), frameBytes); } catch { void stop(1); return; }
    offset = end + 1;
  }
});
process.stdin.on("end", () => { void stop(); });
process.stdin.on("error", () => { void stop(1); });
process.stdout.on("error", () => { void stop(1); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stop(); });
engine.start();
