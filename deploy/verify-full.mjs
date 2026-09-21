// Explicitly paid end-to-end verification. A provider error is a failure,
// never evidence of success. No fixed project directory or account log output.
// Starts one model turn AND one potentially billable compaction. The terminal
// check is a direct gateway RPC, not evidence of a model-driven tool call.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { VerificationClient, VerificationRpcError, startVerificationThread, exactReplyTurn, completedCompaction, terminalMarkerPredicate, cleanupThread, cleanupTerminal, requirePaidVerification } from "./verification-client.mjs";
requirePaidVerification();
const client = new VerificationClient();
let threadId;
let processId;
let passed = false;
try {
  const status = await client.rpc("app/status");
  assert.equal(status.codexState, "ready");
  assert.ok(Array.isArray((await client.rpc("projects/list")).projects));
  assert.ok(Array.isArray((await client.rpc("fs/readDirectory", { path: status.workspaceRoot })).entries));
  threadId = (await startVerificationThread(client, { cwd: status.workspaceRoot })).thread.id;
  await client.rpc("thread/name/set", { threadId, name: "temporary-verification-" + randomUUID() });
  await exactReplyTurn(client, threadId);
  assert.equal((await client.rpc("thread/read", { threadId })).thread.id, threadId);
  assert.equal((await client.rpc("thread/resume", { threadId })).thread.id, threadId);
  processId = (await client.rpc("terminal/exec", { rows: 20, cols: 90 })).processId;
  assert.equal(typeof processId, "string");
  const marker = "VERIFY_" + randomUUID().replaceAll("-", "");
  await client.rpc("terminal/write", { processId, base64: Buffer.from("echo " + marker + "\r").toString("base64") });
  await client.rpc("terminal/resize", { processId, rows: 24, cols: 100 });
  await client.waitFor(terminalMarkerPredicate(processId, marker), 15000);
  await client.rpc("terminal/terminate", { processId });
  // Terminate acknowledgement is not process exit. The control gate retains
  // this terminal until its lifecycle notification; do not race compaction
  // against it or claim successful terminal cleanup on a mere acknowledgement.
  await client.waitFor(note => note.method === "terminal/exited" && note.params?.processId === processId, 15000);
  processId = undefined;
  await completedCompaction(client, threadId);
  await client.rpc("thread/archive", { threadId });
  await client.rpc("thread/unarchive", { threadId });
  await assert.rejects(client.rpc("process/spawn", { command: ["id"] }), VerificationRpcError);
  passed = true;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (processId) {
    try { await cleanupTerminal(client, processId); }
    catch { passed = false; console.error("FAIL verification terminal cleanup"); process.exitCode = 1; }
  }
  try { await cleanupThread(client, threadId); }
  catch { passed = false; console.error("FAIL verification thread cleanup"); process.exitCode = 1; }
  client.close();
}
if (passed) console.log("FULL-E2E-PASS (exact model reply, direct terminal, completed compaction, cleanup)");
