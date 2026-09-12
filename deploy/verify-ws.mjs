// Authenticated, read-only transport verification; never starts model turns.
import assert from "node:assert/strict";
import { VerificationClient } from "./verification-client.mjs";
const client = new VerificationClient();
try {
  const status = await client.rpc("app/status");
  assert.equal(status.codexState, "ready");
  const account = await client.rpc("account/read");
  assert.equal(typeof account.requiresOpenaiAuth, "boolean");
  assert.ok(Array.isArray((await client.rpc("model/list")).data));
  assert.ok(Array.isArray((await client.rpc("thread/list", { limit: 5 })).data));
  await assert.rejects(client.rpc("process/spawn", { command: ["id"] }));
  console.log("WS-READONLY-PASS (no turn, no created thread)");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
