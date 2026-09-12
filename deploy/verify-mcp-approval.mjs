// Compatibility entry for the MCP approval regression. Uses the same paid
// gate, bounded transport, completed-turn evidence and cleanup as the full
// MCP suite; a provider/tool error is a failing verification.
// HARNESS_ALLOW_PAID_TESTS=1 node verify-mcp-approval.mjs [never|on-request|untrusted]
import { runMcpVerification } from "./verify-mcp-tools.mjs";

try {
  if (process.argv.length > 3) throw new Error("Usage: verify-mcp-approval.mjs [never|on-request|untrusted]");
  const policy = process.argv[2] ?? "never";
  if (!["never", "on-request", "untrusted"].includes(policy)) throw new Error("Unsupported approval policy: " + policy);
  const passed = await runMcpVerification([policy, "web-search-prime"]);
  if (!passed) process.exitCode = 1;
} catch (failure) { console.error(failure.message); process.exitCode = 1; }
