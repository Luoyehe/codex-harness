// Authenticated, read-only transport verification; never starts model turns.
import assert from "node:assert/strict";
import { VerificationClient, VerificationRpcError, verificationTimeout } from "./verification-client.mjs";
const timeout = verificationTimeout();
const client = new VerificationClient(undefined, undefined, { openTimeoutMs: timeout });
const rpc = (method, params = {}) => client.rpc(method, params, timeout);
try {
  const status = await rpc("app/status");
  assert.equal(status.codexState, "ready");
  const account = await rpc("account/read");
  assert.equal(typeof account.requiresOpenaiAuth, "boolean");
  assert.ok(Array.isArray((await rpc("model/list")).data));
  assert.ok(Array.isArray((await rpc("thread/list", { limit: 5 })).data));
  await assert.rejects(rpc("process/spawn", { command: ["id"] }), VerificationRpcError);
  console.log("WS-READONLY-PASS (no turn, no created thread)");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
