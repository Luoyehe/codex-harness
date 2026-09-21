// Explicitly paid usage verification. No unauthenticated legacy WS path.
import assert from "node:assert/strict";
import { VerificationClient, startVerificationThread, completedTurn, cleanupThread, requirePaidVerification } from "../../../deploy/verification-client.mjs";
requirePaidVerification();
const client = new VerificationClient();
let threadId;
try {
  threadId = (await startVerificationThread(client)).thread.id;
  await completedTurn(client, threadId);
  const usage = (await client.waitFor(note => note.method === "thread/tokenUsage/updated" && note.params?.threadId === threadId, 10000)).params.tokenUsage;
  assert.ok(Number.isFinite(usage?.total?.totalTokens) && usage.total.totalTokens >= 0);
  console.log("TOKEN-USAGE-PASS");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  try { await cleanupThread(client, threadId); }
  catch { console.error("FAIL verification thread cleanup"); process.exitCode = 1; }
  client.close();
}
