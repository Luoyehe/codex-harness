// Explicitly paid model verification with bounded RPC and reliable cleanup.
import { VerificationClient, startVerificationThread, exactReplyTurn, cleanupThread, requirePaidVerification } from "./verification-client.mjs";
requirePaidVerification();
const client = new VerificationClient();
let threadId;
let passed = false;
try {
  threadId = (await startVerificationThread(client)).thread.id;
  await exactReplyTurn(client, threadId);
  passed = true;
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  try { await cleanupThread(client, threadId); }
  catch { passed = false; console.error("FAIL verification thread cleanup"); process.exitCode = 1; }
  client.close();
}
if (passed) console.log("MODEL-VERIFICATION-PASS (completed turn, exact final reply, thread removed)");
