// Read-only list/search/pagination checks. Mutating and paid lifecycle tests
// live in verify-full.mjs with explicit HARNESS_ALLOW_PAID_TESTS=1.
import assert from "node:assert/strict";
import { VerificationClient } from "./verification-client.mjs";
const client = new VerificationClient();
try {
  for (const archived of [false, true]) {
    const first = await client.rpc("thread/list", { limit: 1, archived });
    assert.ok(Array.isArray(first.data));
    assert.ok(first.data.length <= 1);
    if (first.nextCursor) {
      const next = await client.rpc("thread/list", { limit: 1, archived, cursor: first.nextCursor });
      assert.ok(Array.isArray(next.data));
      assert.ok(!next.data.some(item => first.data.some(old => old.id === item.id)));
    }
  }
  const search = await client.rpc("thread/list", { limit: 5, searchTerm: "verification-nonexistent-title" });
  assert.ok(Array.isArray(search.data));
  console.log("THREAD-LIST-READONLY-PASS (no inference or mutations)");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { client.close(); }
