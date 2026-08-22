// thread/list pagination + search + archive round-trip verification.
// Exercises the R3 fixes: cursor passthrough, searchTerm (title-only),
// archived flag, limit clamp, thread/unarchive, thread/delete cleanup.
//
//   node verify-threads.mjs
import { wsUrl } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
  if (!ok) failures++;
}

const ws = new WebSocket(WS);
let nextId = 1;
const pending = new Map();
const rpc = (m, p) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ kind: "rpc", id, method: m, params: p ?? {} }));
  });
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.kind === "rpcResult") {
    const e = pending.get(msg.id);
    if (e) {
      pending.delete(msg.id);
      msg.error ? e.rej(new Error(msg.error)) : e.res(msg.result);
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r, rej) => { ws.onopen = r; ws.onerror = () => rej(new Error("ws connect failed")); });

  // --- page 1 + cursor passthrough ------------------------------------------
  const p1 = await rpc("thread/list", { limit: 2 });
  const items1 = p1?.data ?? [];
  check("thread/list limit=2 shape", Array.isArray(items1) && items1.length <= 2, `got=${items1.length}`);
  const sorted = items1.every((x, i) => i === 0 || String(items1[i - 1].updatedAt ?? "") >= String(x.updatedAt ?? ""));
  check("sorted by updatedAt desc", sorted, items1.map((x) => x.updatedAt).join(","));

  if (typeof p1?.nextCursor === "string" && p1.nextCursor) {
    const p2 = await rpc("thread/list", { limit: 2, cursor: p1.nextCursor });
    const items2 = p2?.data ?? [];
    const ids1 = new Set(items1.map((x) => x.id));
    const overlap = items2.filter((x) => ids1.has(x.id));
    check("cursor page has no overlap", overlap.length === 0, `page2=${items2.length} overlap=${overlap.length}`);
  } else {
    console.log("PASS cursor passthrough (skipped: single page, no nextCursor)");
  }

  // --- limit clamp (must not error) ------------------------------------------
  const big = await rpc("thread/list", { limit: 500 }).then(() => "OK").catch((e) => e.message);
  check("limit clamp (500 accepted)", big === "OK", typeof big === "string" && big !== "OK" ? big : "");

  // --- search -----------------------------------------------------------------
  const noHit = await rpc("thread/list", { searchTerm: "zzz-no-such-thread-qwerty" });
  check("searchTerm no-hit returns empty", (noHit?.data ?? []).length === 0, `got=${noHit?.data?.length}`);

  // --- archive round-trip -------------------------------------------------------
  // NOTE: codex only lists threads that have at least one turn (native
  // app-server behavior, verified with a direct probe) — so give this thread
  // a turn before asserting on search/list visibility.
  const st = await rpc("thread/start", {});
  const tid = st.thread.id;
  const marker = `pagi-${Date.now().toString(36)}`;
  await rpc("thread/name/set", { threadId: tid, name: marker });
  await rpc("turn/start", { threadId: tid, text: "只回复：OK" });
  let listed = false;
  for (let i = 0; i < 40 && !listed; i++) {
    await sleep(2000);
    const poll = await rpc("thread/list", { searchTerm: marker });
    listed = (poll?.data ?? []).some((x) => x.id === tid);
  }
  check("turn-bearing thread listed + searchable", listed);

  await rpc("thread/archive", { threadId: tid });
  await sleep(500);
  const unarch = await rpc("thread/list", { searchTerm: marker });
  check("archived thread hidden from default list", !(unarch?.data ?? []).some((x) => x.id === tid));

  const arch = await rpc("thread/list", { archived: true, searchTerm: marker });
  check("archived:true returns it", (arch?.data ?? []).some((x) => x.id === tid), `hits=${arch?.data?.length}`);

  await rpc("thread/unarchive", { threadId: tid });
  await sleep(500);
  const unarch2 = await rpc("thread/list", { searchTerm: marker });
  const arch2 = await rpc("thread/list", { archived: true, searchTerm: marker });
  check("unarchive restores to default list", (unarch2?.data ?? []).some((x) => x.id === tid));
  check("unarchive removes from archived list", !(arch2?.data ?? []).some((x) => x.id === tid));

  await rpc("thread/delete", { threadId: tid });
  await sleep(500);
  const after = await rpc("thread/list", { searchTerm: marker });
  check("thread/delete removes from list", !(after?.data ?? []).some((x) => x.id === tid));

  console.log(failures === 0 ? "THREADS-PASS" : `THREADS-FAIL(${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FAIL rpc:", e.message);
  process.exit(1);
});
