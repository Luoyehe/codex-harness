#!/usr/bin/env node
/**
 * Minimal stdio <-> streamable-HTTP MCP bridge for bearer-authenticated
 * endpoints. Payloads can contain prompts, local paths, search terms, and page
 * contents, so stderr is metadata-only and errors returned to Codex are
 * deliberately sanitized.
 *
 *   mcp-http-bridge.mjs <https-url> [--key-file <owner-only-path>]
 *
 * The token may alternatively come from Z_AI_API_KEY. Positional tokens are
 * intentionally unsupported because process arguments are visible in /proc.
 */
import { lstatSync, readFileSync } from "node:fs";
import { postMcp, isResponseFor, isSupportedProtocolVersion, RemoteHttpError, ResponseTooLargeError } from "./mcp-http-transport.mjs";

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 110_000;

function fail(message) {
  console.error(`[mcp-http-bridge] ${message}`);
  process.exit(1);
}

function byteLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > ABSOLUTE_MAX_BYTES) {
    fail(`${name} must be an integer between 1 and ${ABSOLUTE_MAX_BYTES}`);
  }
  return value;
}

const maxRequestBytes = byteLimit("MCP_BRIDGE_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES);
const maxResponseBytes = byteLimit("MCP_BRIDGE_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES);
const argv = process.argv.slice(2);
if (argv.length !== 1 && (argv.length !== 3 || argv[1] !== "--key-file")) {
  fail("usage: mcp-http-bridge.mjs <https-url> [--key-file <path>]");
}

let endpoint;
try {
  endpoint = new URL(argv[0]);
} catch {
  fail("endpoint is not a valid URL");
}
const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback.has(endpoint.hostname))) {
  fail("endpoint must use HTTPS (HTTP is allowed only for loopback testing)");
}
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  fail("endpoint must not contain credentials, a query string, or a fragment");
}

let token = (process.env.Z_AI_API_KEY ?? "").trim();
if (argv.length === 3) {
  const keyFile = argv[2];
  try {
    const stat = lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("key file must be a regular file, not a symlink");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("key file must not be accessible by group or others");
    if (stat.size > 16 * 1024) fail("key file is unexpectedly large");
    token = readFileSync(keyFile, "utf8").trim();
  } catch (error) {
    if (error?.code) fail("cannot read key file");
    throw error;
  }
}
if (!token || token.length > 16 * 1024 || /[\u0000-\u001f\u007f]/.test(token)) {
  fail("missing or invalid bearer token");
}

const verboseMetadata = process.env.MCP_BRIDGE_DEBUG === "1";
let session = { id: "", version: "2025-03-26" };
let initializeRequest = null;
let recovering = null;
const MAX_ACTIVE = 8;
const MAX_PENDING = 32;
const MAX_PENDING_BYTES = 4 * maxRequestBytes;

function safeMethod(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.\/-]{1,100}$/.test(value) ? value : "unknown";
}

function logMessage(direction, message, detail = "") {
  const kind = message?.method
    ? (message.id === undefined || message.id === null ? "notification" : "request")
    : message?.error
      ? "error"
      : "response";
  const method = message?.method ? ` method=${safeMethod(message.method)}` : "";
  const suffix = verboseMetadata && detail ? ` ${detail}` : "";
  process.stderr.write(`[mcp-http-bridge] ${direction} kind=${kind}${method}${suffix}\n`);
}

async function send(message) {
  logMessage("send", message);
  // Await writes so a slow stdio reader also backpressures the HTTP streams.
  await new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
}
process.stdout.on("error", () => fail("stdout transport closed"));

async function postOnce(body, currentSession, onMessage, signal) {
  const started = Date.now();
  const sessionId = await postMcp(endpoint, body, {
    token, session: currentSession, onMessage, signal, maxResponseBytes, timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (verboseMetadata) {
    process.stderr.write(`[mcp-http-bridge] remote elapsed_ms=${Date.now() - started}\n`);
  }
  return sessionId;
}

async function initializeRemote(message, forward) {
  let result;
  const id = await postOnce(message, { id: "", version: session.version }, async (response) => {
    if (isResponseFor(response, message.id)) { result = response; return true; }
    if (forward && response?.method && response.id == null) await send(response);
    return false;
  });
  if (!result || Object.hasOwn(result, "error") || !result.result || typeof result.result !== "object" || Array.isArray(result.result)) throw new Error("initialize failed");
  const version = result.result.protocolVersion;
  if (!isSupportedProtocolVersion(version) || id.length > 4096) throw new Error("invalid initialize metadata");
  session = { id, version };
  if (forward) await send(result);
}

async function recoverSession(expiredSession) {
  if (recovering) return recovering;
  if (session !== expiredSession) return;
  recovering = (async () => {
    try {
      await initializeRemote(initializeRequest, false);
      await postOnce({ jsonrpc: "2.0", method: "notifications/initialized" }, session, async () => false);
    } catch (error) {
      session = expiredSession;
      throw error;
    }
  })();
  try { await recovering; } finally { recovering = null; }
}

async function post(body, job, onMessage) {
  if (recovering) await recovering;
  if (job.cancelled) return;
  const usedSession = session;
  job.session = usedSession;
  try {
    await postOnce(body, usedSession, onMessage, job.controller.signal);
  } catch (error) {
    const expired = error instanceof RemoteHttpError && [401, 404, 410].includes(error.status);
    if (job.cancelled || !expired || !usedSession.id || !initializeRequest) throw error;
    // All requests from one expired generation share the same handshake.
    // Retry only once, after notifications/initialized has been accepted.
    await recoverSession(usedSession);
    if (job.cancelled) return;
    if (body.method === "notifications/initialized") return; // recovery already delivered it
    job.session = session;
    await postOnce(body, session, onMessage, job.controller.signal);
  }
}

function publicError(error) {
  if (error instanceof ResponseTooLargeError) return `remote MCP response exceeded ${maxResponseBytes} bytes`;
  if (error instanceof RemoteHttpError) return `remote MCP endpoint returned HTTP ${error.status}`;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "remote MCP request timed out";
  return "remote MCP request failed";
}

async function handle(message, job) {
  const isNotification = message.id === undefined || message.id === null;
  try {
    let matched = isNotification;
    if (job.cancelled) return;
    if (message.method === "initialize") {
      await initializeRemote(message, true);
      return;
    }
    await post(message, job, async (response) => {
      if (job.cancelled || !response || typeof response !== "object" || Array.isArray(response)) return false;
      // Forward responses and server notifications. Server-initiated requests
      // require a bidirectional HTTP channel this deliberately small bridge
      // does not implement, so they are dropped instead of confusing Codex.
      if (response.method && response.id != null) return false;
      if (response.method && response.id == null) await send(response);
      else if (!isNotification && isResponseFor(response, message.id)) {
        if (matched) return true;
        matched = true;
        await send(response);
        return true;
      }
      return false;
    });
    if (!matched && !job.cancelled) throw new Error("missing JSON-RPC response");
  } catch (error) {
    if (!isNotification && !job.cancelled) {
      await send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: publicError(error) } });
    } else if (verboseMetadata) {
      process.stderr.write(`[mcp-http-bridge] notification delivery failed type=${error?.constructor?.name ?? "Error"}\n`);
    }
    if (message.method === "initialize" || message.method === "notifications/initialized") throw error;
  }
}

let buffer = "";
let lifecycle = Promise.resolve();
let lifecycleError = false;
let active = 0;
let controls = 0;
let pendingBytes = 0;
let initializeSeen = false;
const pending = [];
const requests = new Map();

function pump() {
  while (active < MAX_ACTIVE && pending.length) {
    const job = pending.shift();
    pendingBytes -= job.bytes;
    active++;
    void job.barrier.then(async () => {
      if (lifecycleError) throw new Error("handshake failed");
      await handle(job.message, job);
    }).catch(async () => {
      if (job.message.id != null && !job.cancelled) await send({ jsonrpc: "2.0", id: job.message.id, error: { code: -32000, message: "remote MCP initialization failed" } });
    }).finally(() => {
      if (job.message.id != null) requests.delete(job.message.id);
      active--;
      pump();
    });
  }
}

function enqueue(message, bytes) {
  logMessage("recv", message);
  if (message.method === "notifications/cancelled" && message.id == null) {
    const target = requests.get(message.params?.requestId);
    if (!target || target.cancelled || target.message.method === "initialize") return;
    target.cancelled = true;
    if (controls >= MAX_ACTIVE) fail("too many concurrent control notifications");
    controls++;
    // The control lane never waits for tools/call. Bind it to the target's
    // session generation and do not recover/replay a cancellation elsewhere.
    void target.barrier.then(async () => {
      if (target.session) await postOnce(message, target.session, async () => false, AbortSignal.timeout(1000));
    }).catch(() => {}).finally(() => { target.controller.abort(); controls--; });
    return;
  }
  if (pending.length >= MAX_PENDING || pendingBytes + bytes > MAX_PENDING_BYTES) fail("stdin pending queue limit exceeded");
  if (message.id != null && requests.has(message.id)) fail("duplicate in-flight request id");
  const job = { message, bytes, barrier: lifecycle, controller: new AbortController(), cancelled: false, session: null };
  if (message.id != null) requests.set(message.id, job);
  if (message.method === "initialize" || message.method === "notifications/initialized") {
    if (message.method === "initialize") {
      if (initializeSeen || message.id == null) fail("invalid initialize sequence");
      initializeSeen = true;
      initializeRequest = structuredClone(message);
    } else if (controls >= MAX_ACTIVE) fail("too many lifecycle notifications");
    controls++;
    lifecycle = lifecycle.then(() => {
      if (lifecycleError) return;
      return handle(message, job);
    }).catch(() => { lifecycleError = true; }).finally(() => {
      if (message.id != null) requests.delete(message.id);
      controls--;
    });
    return;
  }
  pending.push(job);
  pendingBytes += bytes;
  pump();
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > maxRequestBytes && !buffer.includes("\n")) {
    fail(`stdin message exceeded ${maxRequestBytes} bytes`);
  }
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    if (Buffer.byteLength(line) > maxRequestBytes) fail(`stdin message exceeded ${maxRequestBytes} bytes`);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("[mcp-http-bridge] ignored malformed JSON input");
      continue;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
      console.error("[mcp-http-bridge] ignored invalid JSON-RPC request");
      continue;
    }
    if (message.id != null && !(typeof message.id === "string" && message.id.length <= 256 || typeof message.id === "number" && Number.isSafeInteger(message.id))) {
      console.error("[mcp-http-bridge] ignored invalid JSON-RPC id");
      continue;
    }
    enqueue(message, Buffer.byteLength(line));
  }
  if (Buffer.byteLength(buffer) > maxRequestBytes) fail(`stdin message exceeded ${maxRequestBytes} bytes`);
});
process.stdin.on("end", () => {
  if (buffer.trim()) console.error("[mcp-http-bridge] ignored unterminated JSON input");
  process.exitCode = 0;
});
