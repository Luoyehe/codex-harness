/**
 * Smoke test against a real `codex app-server`: handshake + basic reads.
 * Run: pnpm --filter @codex-harness/gateway exec tsx scripts/smoke.ts
 */
import { AppServerConnection, initialize } from "../src/codex/rpc.js";

const conn = new AppServerConnection("codex", ["app-server"], {}, {
  onNotification: (method) => process.stdout.write(`  notif: ${method}\n`),
  onServerRequest: async () => {
    throw new Error("no approvals expected during smoke test");
  },
  onExit: (code) => process.stdout.write(`  app-server exited: ${code}\n`),
  onStderr: (chunk) => process.stderr.write(`  stderr: ${chunk}`),
});

const timeout = setTimeout(() => {
  console.error("SMOKE TIMEOUT");
  process.exit(1);
}, 30_000);

conn.spawn();
console.log("initialize...");
await initialize(conn, { name: "codex-harness-smoke", title: "Smoke", version: "1.0.0" });
console.log("handshake ok");

const models = await conn.request("model/list", {});
console.log(`model/list ok: ${JSON.stringify(models).slice(0, 120)}...`);

const account = await conn.request("account/read", {});
console.log(`account/read ok: ${JSON.stringify(account).slice(0, 200)}`);

const threads = await conn.request("thread/list", { limit: 5 });
console.log(`thread/list ok: ${(threads as any)?.data?.length ?? 0} threads`);

console.log("SMOKE PASS");
clearTimeout(timeout);
conn.kill();
process.exit(0);
