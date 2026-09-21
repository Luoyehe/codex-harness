// Shared authenticated, bounded client for explicit deployment verification.
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { wsOptions } from "./ws-token.mjs";

export function requirePaidVerification() {
  if (process.env.HARNESS_ALLOW_PAID_TESTS !== "1") {
    throw new Error("This verification starts model/MCP requests and may incur charges. Set HARNESS_ALLOW_PAID_TESTS=1 explicitly; use pnpm test:smoke for isolated no-inference checks.");
  }
}

const declineReason = "Unattended verification declines interactive requests";
const MAX_INCOMING_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_OUTGOING_RPC_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_NOTIFICATION_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_NOTIFICATIONS = 4096;
const MAX_PENDING_RPCS = 64;
const MAX_OWNED_THREADS = 64;
// A verifier shares the same broadcast stream as real browser sessions. Only
// a successful creation (or its durable accepted receipt) establishes ownership.
const verificationOwnership = new WeakMap();

function ownership(client) {
  let state = verificationOwnership.get(client);
  if (!state) {
    state = { threads: new Set(), mcpApprovalRequired: new Set() };
    verificationOwnership.set(client, state);
  }
  return state;
}

export function inheritVerificationThreads(client, previous) {
  verificationOwnership.set(client, ownership(previous));
}

export function verificationMcpApprovalRequired(client, threadId) {
  return verificationOwnership.get(client)?.mcpApprovalRequired.has(threadId) ?? false;
}

/** Only a correlated, explicit gateway error proves RPC rejection. Socket
 * loss, malformed data and local timeouts must not satisfy negative probes. */
export class VerificationRpcError extends Error {
  constructor(method, delivery) {
    super(`RPC ${method} rejected`); this.method = method;
    this.delivery = ["rejected", "not_sent", "unknown"].includes(delivery) ? delivery : "unknown";
  }
}

function declineRequest(message) {
  let payload;
  switch (message.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": payload = { decision: "decline" }; break;
    case "item/permissions/requestApproval": payload = { permissions: {}, scope: "turn" }; break;
    case "mcpServer/elicitation/request": payload = { action: "decline", content: null, _meta: null }; break;
    case "item/tool/requestUserInput": payload = { answers: {} }; break;
    case "applyPatchApproval":
    case "execCommandApproval": payload = { decision: { denied: { rejection: declineReason } } }; break;
    default: return { kind: "serverRequestResponse", requestId: message.requestId, payload: null, error: declineReason };
  }
  return { kind: "serverRequestResponse", requestId: message.requestId, payload };
}

function validTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new Error("Verification timeout must be a positive finite timer duration");
  }
  return timeoutMs;
}

export function verificationTimeout(env = process.env) {
  const value = Number(env.HARNESS_VERIFY_TIMEOUT_MS ?? 15000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 120000) throw new Error("Invalid verification timeout (1..120000 ms)");
  return value;
}

export class VerificationClient {
  notes = [];
  pending = new Map();
  nextId = 1;
  closed = false;
  notesBytes = 0;
  noteSizes = new WeakMap();

  constructor(url = process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws", options = wsOptions(), { openTimeoutMs = 10000 } = {}) {
    validTimeout(openTimeoutMs);
    this.url = url;
    const requestedMax = Number(options?.maxPayload);
    this.options = { ...options, maxPayload: Number.isSafeInteger(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, MAX_INCOMING_FRAME_BYTES) : MAX_INCOMING_FRAME_BYTES };
    this.openTimeoutMs = openTimeoutMs;
    try { this.ws = new WebSocket(url, this.options); }
    catch { throw new Error("Invalid verification WebSocket connection options"); }
    this.opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("WebSocket connection timed out");
        reject(error);
        this.rejectPending(error);
        this.ws.terminate();
      }, openTimeoutMs);
      this.ws.once("open", () => { clearTimeout(timer); resolve(); });
      this.ws.once("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); });
      this.ws.once("close", () => { clearTimeout(timer); reject(new Error("WebSocket closed before verification")); });
    });
    // A server may close before the caller starts its first RPC. Retain the
    // rejection for that RPC without creating an unhandled rejection meanwhile.
    this.opened.catch(() => {});
    this.ws.on("close", () => this.rejectPending(new Error("WebSocket closed")));
    this.ws.on("error", () => this.rejectPending(new Error("WebSocket failed")));
    this.ws.on("message", data => {
      let message;
      const raw = data.toString();
      const rawBytes = Buffer.byteLength(raw);
      if (rawBytes > MAX_INCOMING_FRAME_BYTES) {
        this.rejectPending(new Error("Gateway frame exceeded verification limit"));
        this.ws.terminate();
        return;
      }
      try { message = JSON.parse(raw); }
      catch { this.rejectPending(new Error("Invalid gateway JSON")); this.ws.terminate(); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.rejectPending(new Error("Invalid gateway envelope"));
        this.ws.terminate();
        return;
      }
      if (message.kind === "rpcResult") {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(message.id);
          if (message.error != null) {
            waiter.reject(typeof message.error === "string" && message.error.length
              ? new VerificationRpcError(waiter.method, message.delivery) : new Error("Invalid gateway RPC error"));
          } else {
            // Register the correlated successful creation in the receive
            // handler, before a following frame from the same socket batch
            // can carry its first prompt. The helper also validates the ID.
            const threadId = message.result?.thread?.id;
            if (waiter.verificationCreation && typeof threadId === "string" && threadId && threadId.length <= 256 && !threadId.includes("\0")) {
              ownership(this).threads.add(threadId);
            }
            waiter.resolve(message.result);
          }
        }
      } else if (message.kind === "notification") {
        if (this.notes.length === 0) this.notesBytes = 0;
        this.notes.push(message);
        this.noteSizes.set(message, rawBytes);
        this.notesBytes += rawBytes;
        while (this.notes.length > MAX_RETAINED_NOTIFICATIONS || this.notesBytes > MAX_RETAINED_NOTIFICATION_BYTES) {
          const removed = this.notes.shift();
          this.notesBytes -= removed ? this.noteSizes.get(removed) ?? 0 : 0;
        }
      } else if (message.kind === "serverRequest") {
        // Use the pinned protocol's negative response, not an RPC transport
        // error, so an ordinary refusal does not turn into a protocol failure.
        if (!((typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 256)
            || Number.isSafeInteger(message.requestId))) {
          this.rejectPending(new Error("Invalid gateway server request ID"));
          this.ws.terminate();
          return;
        }
        const threadId = message.params?.threadId ?? message.params?.conversationId;
        const owned = verificationOwnership.get(this);
        // Missing/foreign ownership is not authorization even to decline:
        // silently leave unrelated approvals for their actual browser owner.
        if (typeof threadId !== "string" || !owned?.threads.has(threadId)) return;
        if (message.method === "mcpServer/elicitation/request") owned.mcpApprovalRequired.add(threadId);
        try {
          this.ws.send(JSON.stringify(declineRequest(message)), error => {
            if (error) { this.rejectPending(new Error("Interactive refusal send failed")); this.ws.terminate(); }
          });
        } catch { this.rejectPending(new Error("Interactive refusal send failed")); this.ws.terminate(); }
      } else {
        this.rejectPending(new Error("Invalid gateway message kind"));
        this.ws.terminate();
      }
    });
  }

  rejectPending(error) {
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }

  async rpc(method, params = {}, timeoutMs = 15000) {
    validTimeout(timeoutMs);
    await this.opened;
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error("Verification connection is closed");
    if (typeof method !== "string" || !/^[A-Za-z][A-Za-z0-9/._-]{0,127}$/.test(method)) {
      throw new Error("Invalid verification RPC method");
    }
    if (this.pending.size >= MAX_PENDING_RPCS) throw new Error("Too many pending verification RPCs");
    if (!Number.isSafeInteger(this.nextId) || this.nextId > Number.MAX_SAFE_INTEGER) throw new Error("Verification RPC ID space exhausted");
    const id = this.nextId++;
    let wire;
    try { wire = JSON.stringify({ kind: "rpc", id, method, params }); }
    catch { throw new Error(`RPC ${method} parameters are not serializable`); }
    if (Buffer.byteLength(wire) > MAX_OUTGOING_RPC_BYTES) throw new Error(`RPC ${method} exceeds verification request limit`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${method} timed out`)); }, timeoutMs);
      const verificationCreation = method === "thread/start" && pendingThreadCreations.get(this)?.has(params?.clientOperationId) === true;
      this.pending.set(id, { method, resolve, reject, timer, verificationCreation });
      const sendFailed = () => { clearTimeout(timer); this.pending.delete(id); reject(new Error(`RPC ${method} send failed`)); };
      try { this.ws.send(wire, error => { if (error) sendFailed(); }); }
      catch { sendFailed(); }
    });
  }

  async waitFor(predicate, timeoutMs = 120000) {
    const deadline = Date.now() + validTimeout(timeoutMs);
    while (Date.now() < deadline) {
      const match = this.notes.find(predicate);
      if (match) return match;
      if (this.closed) throw new Error("Connection closed while waiting for a notification");
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    throw new Error("Expected verification notification timed out");
  }

  close() { this.rejectPending(new Error("Verification finished")); this.ws.terminate(); }
}

const pendingThreadCreations = new WeakMap();

export function hasPendingVerificationThread(client) {
  return (pendingThreadCreations.get(client)?.size ?? 0) > 0;
}

/** One operation ID and one submission per logical creation. Keep uncertain
 * IDs for finally/cleanup even when no thread ID was returned to the caller. */
export async function startVerificationThread(client, params = {}) {
  if (ownership(client).threads.size >= MAX_OWNED_THREADS) throw new Error("Too many owned verification threads");
  const clientOperationId = randomUUID();
  let pending = pendingThreadCreations.get(client);
  if (!pending) { pending = new Set(); pendingThreadCreations.set(client, pending); }
  if (pending.size >= 64) throw new Error("Too many unresolved verification thread creations");
  pending.add(clientOperationId);
  try {
    const response = await client.rpc("thread/start", { ...params, clientOperationId });
    const id = response?.thread?.id;
    if (typeof id !== "string" || !id || id.length > 256 || id.includes("\0")) {
      throw new Error("thread/start returned no valid thread ID");
    }
    ownership(client).threads.add(id);
    pending.delete(clientOperationId);
    return response;
  } catch (error) {
    if (error instanceof VerificationRpcError && ["rejected", "not_sent"].includes(error.delivery)) pending.delete(clientOperationId);
    throw error;
  }
}

export async function completedTurn(client, threadId, overrides = {}) {
  requirePaidVerification();
  // One ID for this logical verification turn, one submission only. A lost
  // acknowledgement remains uncertain; do not generate/retry another turn.
  const clientOperationId = randomUUID();
  const response = await client.rpc("turn/start", { text: "Reply with exactly OK. Do not use any tools.", approvalPolicy: "on-request", ...overrides, threadId, clientOperationId });
  const turnId = response?.turn?.id;
  if (!turnId) throw new Error("turn/start returned no turn ID");
  const end = await client.waitFor(note => note.method === "turn/completed" && note.params?.threadId === threadId && note.params?.turn?.id === turnId);
  if (end.params.turn.status !== "completed") throw new Error("Model turn failed; provider errors are not successful verification");
  return turnId;
}

// A commentary message is not a final answer. Older protocol versions omit
// phase; retain that compatibility without accepting unknown explicit phases.
export function finalAnswer(notes, threadId, turnId) {
  return notes.filter(note => note.method === "item/completed" &&
    note.params?.threadId === threadId && note.params?.turnId === turnId &&
    note.params?.item?.type === "agentMessage" &&
    (note.params.item.phase == null || note.params.item.phase === "final_answer") &&
    typeof note.params.item.text === "string")
    .map(note => note.params.item.text).join("\n").trim();
}

export async function exactReplyTurn(client, threadId) {
  const expected = "VERIFY_" + randomUUID().replaceAll("-", "");
  const turnId = await completedTurn(client, threadId, {
    text: "Reply with exactly " + expected + ". Do not use any tools or add other text.",
  });
  if (finalAnswer(client.notes, threadId, turnId) !== expected) {
    throw new Error("Model final reply did not match the verification challenge");
  }
  return turnId;
}

// Check a completed output line, not a substring of the shell's input echo.
// Maintain partial lines across frames and ignore frames already examined by
// waitFor, which revisits its bounded notification buffer.
export function terminalMarkerPredicate(processId, marker) {
  const seen = new WeakSet();
  let tail = "";
  return note => {
    if (note.method !== "command/exec/outputDelta" || note.params?.processId !== processId || seen.has(note)) return false;
    seen.add(note);
    const lines = (tail + Buffer.from(note.params.deltaBase64 ?? "", "base64").toString()).split("\n");
    tail = lines.pop().slice(-65536);
    return lines.some(line => line.replace(/\r$/, "") === marker);
  };
}

export async function completedCompaction(client, threadId) {
  requirePaidVerification();
  // Only use on this verifier's private, idle thread. Drop earlier turn events
  // before the RPC, since current progress can arrive before its acknowledgement.
  client.notes.length = 0;
  await client.rpc("thread/compact/start", { threadId });
  const started = await client.waitFor(note => note.method === "turn/started" && note.params?.threadId === threadId && typeof note.params?.turn?.id === "string");
  const turnId = started.params.turn.id;
  const end = await client.waitFor(note => note.method === "turn/completed" && note.params?.threadId === threadId && note.params?.turn?.id === turnId);
  if (end.params.turn.status !== "completed" || !client.notes.some(note => note.method === "item/completed" &&
      note.params?.threadId === threadId && note.params?.turnId === turnId && note.params?.item?.type === "contextCompaction")) {
    throw new Error("Compaction lacked a successful turn and matching completed item");
  }
}

export async function cleanupThread(client, threadId) {
  const uncertain = pendingThreadCreations.get(client);
  if (!threadId && !uncertain?.size) return;
  let cleanupClient = client;
  const temporaryClients = [];
  const reconnect = () => {
    const next = new VerificationClient(client.url, client.options, { openTimeoutMs: client.openTimeoutMs });
    inheritVerificationThreads(next, client);
    temporaryClients.push(next);
    return next;
  };
  try {
    if (client.closed || client.ws.readyState !== WebSocket.OPEN) cleanupClient = reconnect();
    if (!threadId) {
      for (const operationId of [...uncertain]) {
        const receipt = await cleanupClient.rpc("thread/start/operation", { clientOperationId: operationId });
        if (receipt?.state === "rejected") { uncertain.delete(operationId); continue; }
        const acceptedId = receipt?.threadId;
        if (receipt?.state !== "accepted" || typeof acceptedId !== "string" || !acceptedId
            || acceptedId.length > 256 || acceptedId.includes("\0")) {
          // Neither unknown nor not_received permits another creation or a
          // claim of successful cleanup. Retain the ID for manual reconciliation.
          throw new Error(`Verification creation ${operationId} remains unresolved; no creation was retried`);
        }
        ownership(cleanupClient).threads.add(acceptedId);
        await cleanupThread(cleanupClient, acceptedId);
        uncertain.delete(operationId);
      }
      return;
    }
    try { await cleanupClient.rpc("turn/interrupt", { threadId }, 3000); } catch { /* may already be idle */ }
    // A disconnect during interruption must not silently abandon the thread.
    // Whether this was the original socket or an initial cleanup reconnect,
    // use one fresh connection for the authoritative deletion attempt.
    if (cleanupClient.closed || cleanupClient.ws.readyState !== WebSocket.OPEN) cleanupClient = reconnect();
    await cleanupClient.rpc("thread/delete", { threadId });
    const owned = verificationOwnership.get(client);
    owned?.threads.delete(threadId);
    owned?.mcpApprovalRequired.delete(threadId);
  } finally {
    for (const temporary of temporaryClients) temporary.close();
  }
}

export async function cleanupTerminal(client, processId, timeoutMs = verificationTimeout()) {
  if (!processId) return;
  const cleanupClient = client.closed || client.ws.readyState !== WebSocket.OPEN
    ? new VerificationClient(client.url, client.options, { openTimeoutMs: client.openTimeoutMs })
    : client;
  try {
    await cleanupClient.rpc("terminal/terminate", { processId });
    // The terminate RPC only acknowledges the signal request. Keep the
    // verifier alive until the command promise settles and the gateway emits
    // the matching lifecycle event; otherwise a failed cleanup could be
    // reported as successful while its shell is still running.
    await cleanupClient.waitFor(note => note.method === "terminal/exited" && note.params?.processId === processId, timeoutMs);
  }
  finally { if (cleanupClient !== client) cleanupClient.close(); }
}
