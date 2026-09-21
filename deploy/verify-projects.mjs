// Read-only project inventory/directory check. Never register, create or
// remove a project: an existing user's registration is not a test fixture.
import { VerificationClient, verificationTimeout } from "./verification-client.mjs";

let client;
try {
  const timeout = verificationTimeout();
  client = new VerificationClient(undefined, undefined, { openTimeoutMs: timeout });
  const status = await client.rpc("app/status", {}, timeout);
  if (status?.codexState !== "ready" || typeof status.workspaceRoot !== "string" || !status.workspaceRoot) throw new Error("Workspace unavailable");
  const result = await client.rpc("projects/list", {}, timeout);
  if (!Array.isArray(result?.projects) || result.projects.some(project => typeof project?.path !== "string" || !project.path)) throw new Error("Invalid project inventory");
  const listing = await client.rpc("fs/readDirectory", { path: status.workspaceRoot }, timeout);
  if (!Array.isArray(listing?.entries)) throw new Error("Invalid directory inventory");
  console.log(`PROJECTS-READONLY-PASS (${result.projects.length} registrations; no project creation/removal)`);
} catch {
  console.error("PROJECTS-READONLY-FAIL: authentication, connection, timeout or unavailable workspace; no project changes.");
  process.exitCode = 1;
} finally { client?.close(); }
