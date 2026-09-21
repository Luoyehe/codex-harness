// Explicitly paid, three-turn business verification. This limits turn starts,
// not provider HTTP requests or monetary spend: one turn can make many requests.
// The caller creates/registers an isolated cwd and supplies one synthetic file.
import { randomBytes, randomInt } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

class VerificationFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new VerificationFailure(code); };
const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value) ? value : null;
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const isWithin = (cwd, file) => file.startsWith(cwd + "/");

export function providerVerificationConfig(env) {
  const mode = env.HARNESS_VERIFY_MODE;
  const provider = identifier(env.HARNESS_VERIFY_PROVIDER);
  const model = identifier(env.HARNESS_VERIFY_MODEL);
  const authMode = env.HARNESS_VERIFY_AUTH_MODE || null;
  if (!["openai", "zhipu", "custom"].includes(mode) || !provider || !model ||
      (authMode !== null && !["chatgpt", "apiKey"].includes(authMode))) fail("invalid_provider_expectation");
  const absolute = name => {
    const value = env[name];
    // Keep the fixture's shell command unambiguous and reject broad/root paths.
    if (typeof value !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(value)) fail("invalid_fixture_path");
    const normalized = path.posix.normalize(value);
    if (normalized === "/" || normalized !== value || value.endsWith("/")) fail("invalid_fixture_path");
    return value;
  };
  const cwd = absolute("HARNESS_VERIFY_CWD");
  const fixture = absolute("HARNESS_VERIFY_FIXTURE");
  const expectedFile = absolute("HARNESS_VERIFY_EXPECTED_FILE");
  if (!isWithin(cwd, fixture) || isWithin(cwd, expectedFile) || cwd === expectedFile) fail("fixture_isolation_required");
  return { mode, provider, model, authMode, cwd, fixture, expectedFile };
}

const sameFile = (one, two) => one.dev === two.dev && one.ino === two.ino && one.mode === two.mode &&
  one.uid === two.uid && one.gid === two.gid && one.nlink === two.nlink && one.size === two.size &&
  one.mtimeMs === two.mtimeMs && one.ctimeMs === two.ctimeMs;

export function syntheticExpected(file) {
  // This is the only local content read. Never read the fixture, account,
  // config or arbitrary logs. Require a tiny, regular, non-symlink expectation.
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 128) fail("invalid_synthetic_expectation");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) fail("invalid_synthetic_expectation");
    const buffer = Buffer.allocUnsafe(129);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    const after = fstatSync(fd);
    if (total !== before.size || total > 128 || !sameFile(opened, after) || !sameFile(after, lstatSync(file))) {
      fail("invalid_synthetic_expectation");
    }
    return buffer.subarray(0, total).toString("utf8").trim();
  } finally { closeSync(fd); }
}

function completedItems(notes, threadId, turnId) {
  const items = new Map();
  for (const note of notes) {
    if (note.method === "item/completed" && note.params?.threadId === threadId && note.params?.turnId === turnId && note.params?.item) {
      const item = note.params.item;
      items.set(item.id ?? `missing-${items.size}`, item);
    }
  }
  return [...items.values()];
}

const toolTypes = new Set(["commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch", "imageView", "imageGeneration",
  "collabAgentToolCall", "collabToolCall", "subAgentActivity", "sleep", "fileChange"]);
function toolCounts(notes, threadId, turnId) {
  const started = new Set();
  for (const note of notes) {
    if (["item/started", "item/completed"].includes(note.method) && note.params?.threadId === threadId &&
        note.params?.turnId === turnId && toolTypes.has(note.params?.item?.type)) {
      started.add(note.params.item.id ?? `missing-${started.size}`);
    }
  }
  const items = completedItems(notes, threadId, turnId);
  return { started: started.size, completed: items.filter(item => toolTypes.has(item.type)).length,
    commandExecutions: items.filter(item => item.type === "commandExecution").length };
}

function fixtureReadDetails(notes, threadId, turnId, config, expected, reply) {
  const items = completedItems(notes, threadId, turnId).filter(item => toolTypes.has(item.type));
  const item = items.length === 1 && items[0].type === "commandExecution" ? items[0] : null;
  const commands = new Set([`cat -- '${config.fixture}'`, `cat -- ${config.fixture}`, `cat '${config.fixture}'`, `cat ${config.fixture}`]);
  const command = typeof item?.command === "string" ? item.command.trim() : "";
  const action = Array.isArray(item?.commandActions) && item.commandActions.length === 1 ? item.commandActions[0] : null;
  // The pinned protocol's parsed action can expose the inner read command
  // when commandExecution.command is wrapped by a shell. Never use contains,
  // accept arbitrary action types, or treat an output-producing echo as read.
  const readActionMatched = action?.type === "read" && typeof action.command === "string" &&
    commands.has(action.command.trim()) && typeof action.path === "string" && typeof item.cwd === "string" &&
    path.posix.resolve(item.cwd, action.path) === config.fixture;
  const shellWrapper = /^(?:(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh))\s+-(?:lc|cl|c)\s/.test(command);
  return {
    commandRecognized: commands.has(command) || (shellWrapper && readActionMatched),
    readActionMatched: !!readActionMatched,
    exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null,
    outputMatched: typeof item?.aggregatedOutput === "string" && item.aggregatedOutput.trim() === expected,
    finalReplyMatched: reply === expected,
  };
}

export function successfulFixtureRead(notes, threadId, turnId, config, expected, reply) {
  const items = completedItems(notes, threadId, turnId).filter(item => toolTypes.has(item.type));
  const evidence = fixtureReadDetails(notes, threadId, turnId, config, expected, reply);
  return items.length === 1 && items[0].type === "commandExecution" &&
    items[0].status === "completed" && items[0].exitCode === 0 && items[0].cwd === config.cwd &&
    evidence.commandRecognized && evidence.outputMatched && evidence.finalReplyMatched;
}

const count = value => Number.isFinite(value) && value >= 0 ? value : null;
function usageFor(notes, threadId, turnId) {
  const usage = notes.filter(note => note.method === "thread/tokenUsage/updated" &&
    note.params?.threadId === threadId && note.params?.turnId === turnId).at(-1)?.params?.tokenUsage;
  if (!usage || typeof usage !== "object") return null;
  const breakdown = value => value && typeof value === "object" ? Object.fromEntries(
    ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"].map(key => [key, count(value[key])]),
  ) : null;
  return { last: breakdown(usage.last), total: breakdown(usage.total), modelContextWindow: count(usage.modelContextWindow) };
}

function reroutesFor(notes, threadId, turnId) {
  return notes.filter(note => note.method === "model/rerouted" && note.params?.threadId === threadId && note.params?.turnId === turnId)
    .map(note => ({ fromModel: identifier(note.params.fromModel), toModel: identifier(note.params.toModel),
      reason: note.params.reason === "highRiskCyberActivity" ? note.params.reason : "unknown" }));
}

function assertThread(response, config, expectedId) {
  if (!safeId(response?.thread?.id) || (expectedId && response.thread.id !== expectedId)) fail("thread_identity_mismatch");
  if (response.model !== config.model || response.modelProvider !== config.provider || response.thread.modelProvider !== config.provider) fail("provider_model_mismatch");
  if (response.cwd !== config.cwd || response.thread.cwd !== config.cwd) fail("thread_cwd_mismatch");
  if (response.sandbox?.type !== "readOnly" || response.approvalPolicy !== "never") fail("thread_safety_policy_mismatch");
}

export async function runProviderVerification({
  env = process.env, createClient, readExpected = syntheticExpected, now = Date.now, log = console.log,
} = {}) {
  const startedAt = now();
  const summary = { kind: "provider-verification", ok: false, expected: null, authVerified: null, threadId: null,
    budget: { maxTurnStarts: 3, attemptedTurnStarts: 0, providerRequests: "not-bounded-by-turn-count", automaticRetries: 0, compactions: 0 },
    turns: [], cleanup: { attempted: false, ok: null }, failure: null, durationMs: null };
  let client, helpers, threadId, phase = "preflight";
  try {
    // Lazy import keeps module inspection and pure evidence tests from loading
    // authentication configuration. Check the process opt-in before even
    // importing ws-token, then retain the shared helper's gate as well.
    if (process.env.HARNESS_ALLOW_PAID_TESTS !== "1") fail("paid_opt_in_required");
    helpers = await import("./verification-client.mjs");
    try { helpers.requirePaidVerification(); } catch { fail("paid_opt_in_required"); }
    const config = providerVerificationConfig(env);
    summary.expected = { mode: config.mode, provider: config.provider, model: config.model, authMode: config.authMode };
    const expected = readExpected(config.expectedFile);
    if (typeof expected !== "string" || !/^HARNESS_SYNTHETIC_[a-f0-9]{32}$/.test(expected)) fail("invalid_synthetic_expectation");
    const makeClient = createClient ?? (previous => previous
      ? new helpers.VerificationClient(previous.url, previous.options, { openTimeoutMs: previous.openTimeoutMs })
      : new helpers.VerificationClient());
    client = makeClient();
    const status = await client.rpc("app/status");
    if (status?.codexState !== "ready" || status?.providerMode !== config.mode) fail("gateway_mode_not_ready");
    if (config.authMode) {
      const account = await client.rpc("account/read");
      if (account?.account?.type !== config.authMode) fail("authentication_mode_mismatch");
      summary.authVerified = true;
    }
    phase = "thread-start";
    // Do not override model: this checks the installed provider/model defaults.
    const initial = await helpers.startVerificationThread(client, { cwd: config.cwd, approvalPolicy: "never", sandbox: "read-only" });
    threadId = initial?.thread?.id;
    summary.threadId = safeId(threadId);
    assertThread(initial, config);
    const nonce = "NONCE_" + randomBytes(16).toString("hex");
    const left = randomInt(11, 80), right = randomInt(11, 80);
    const runTurn = async (name, text, check) => {
      phase = name;
      const start = now(), offset = client.notes.length;
      const record = { name, turnId: null, ok: false, turnStatus: null, receivedTerminal: false,
        durationMs: null, tokenUsage: null, reroutes: [], tools: null, fixtureRead: null };
      summary.turns.push(record);
      summary.budget.attemptedTurnStarts += 1;
      let id;
      try {
        // Gateway turn/start has no read-only preset: inherit thread sandbox.
        id = await helpers.completedTurn(client, threadId, { text, approvalPolicy: "never" });
        record.turnId = safeId(id);
        if (!record.turnId) fail("invalid_turn_identity");
        if (reroutesFor(client.notes.slice(offset), threadId, id).length) fail("model_rerouted");
        const reply = helpers.finalAnswer(client.notes, threadId, id);
        if (!check(reply, id, client.notes.slice(offset))) fail("business_evidence_mismatch");
        record.ok = true;
      } finally {
        const notes = client.notes.slice(offset);
        id ??= notes.findLast(note => ["turn/started", "turn/completed"].includes(note.method) && note.params?.threadId === threadId)?.params?.turn?.id;
        record.turnId = safeId(id);
        record.durationMs = Math.max(0, now() - start);
        if (record.turnId) {
          const terminal = notes.findLast(note => note.method === "turn/completed" &&
            note.params?.threadId === threadId && note.params?.turn?.id === id);
          record.receivedTerminal = !!terminal;
          const status = terminal?.params?.turn?.status;
          record.turnStatus = ["completed", "failed", "interrupted"].includes(status) ? status : null;
          record.tokenUsage = usageFor(notes, threadId, id);
          record.reroutes = reroutesFor(notes, threadId, id);
          record.tools = toolCounts(notes, threadId, id);
          if (name === "fixture-read") record.fixtureRead = fixtureReadDetails(notes, threadId, id, config, expected, helpers.finalAnswer(notes, threadId, id));
        }
      }
    };
    await runTurn("exact-json", `Remember this nonce for the next turn: ${nonce}. Compute ${left} + ${right}. Reply with only compact JSON in this key order: {"nonce":"${nonce}","sum":INTEGER}. Replace INTEGER with the computed integer. Do not use tools, markdown, or extra text.`,
      (reply, id, notes) => reply === JSON.stringify({ nonce, sum: left + right }) && toolCounts(notes, threadId, id).started === 0);
    phase = "reconnect-resume";
    client.close();
    const previousClient = client;
    client = makeClient(previousClient);
    helpers.inheritVerificationThreads(client, previousClient);
    const resumed = await client.rpc("thread/resume", { threadId });
    assertThread(resumed, config, threadId);
    await runTurn("resumed-memory", 'Without using tools, recall the nonce supplied in my previous user message. Reply only with compact JSON {"nonce":"REMEMBERED_NONCE"}, replacing REMEMBERED_NONCE with that earlier value. No extra keys, markdown, or other text.',
      (reply, id, notes) => reply === JSON.stringify({ nonce }) && toolCounts(notes, threadId, id).started === 0);
    await runTurn("fixture-read", `Run exactly one read-only shell command: cat -- '${config.fixture}'. This is an isolated synthetic verification fixture. Do not read any other files, use network, write files, or delegate. After the command completes successfully, reply with exactly the file's single line, without quotes, markdown, or extra text.`,
      (reply, id, notes) => successfulFixtureRead(notes, threadId, id, config, expected, reply) && toolCounts(notes, threadId, id).started === 1);
    summary.ok = true;
  } catch (error) {
    summary.failure = { phase, code: error instanceof VerificationFailure ? error.code : "operation_failed" };
  } finally {
    if (client && (typeof threadId === "string" && threadId || helpers.hasPendingVerificationThread(client))) {
      summary.cleanup.attempted = true;
      try { await helpers.cleanupThread(client, threadId); summary.cleanup.ok = true; }
      catch { summary.cleanup.ok = false; summary.ok = false; summary.failure ??= { phase: "cleanup", code: "thread_cleanup_failed" }; }
    }
    try { client?.close(); } catch { summary.ok = false; summary.failure ??= { phase: "cleanup", code: "connection_cleanup_failed" }; }
    summary.durationMs = Math.max(0, now() - startedAt);
  }
  // Only allowlisted identifiers, counts and booleans leave this process. No
  // prompts, expected content, account fields, paths, raw errors or logs.
  log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!(await runProviderVerification()).ok) process.exitCode = 1;
}
