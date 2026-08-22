// Bare-metal check: any host path is a valid project location.
import { wsUrl } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
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

(async () => {
  await new Promise((r) => (ws.onopen = r));

  // A path OUTSIDE the old container mounts — must be allowed on bare metal.
  const created = await rpc("projects/add", { path: "/root/bare-selftest-project", create: true })
    .then(() => "CREATED")
    .catch((e) => `REJECTED: ${e.message.slice(0, 80)}`);
  console.log("bare-metal arbitrary path ->", created);

  const dirs = await rpc("fs/readDirectory", { path: "/root" });
  const sees = (dirs.entries ?? []).some((x) => x.isDirectory && x.fileName === "bare-selftest-project");
  console.log("visible in directory browser ->", sees);

  await rpc("projects/remove", { path: "/root/bare-selftest-project" });
  console.log("cleanup OK");
  process.exit(created === "CREATED" && sees ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
