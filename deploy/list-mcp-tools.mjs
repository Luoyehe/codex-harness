// List MCP servers and their registered tool names via the gateway WS API.
import WebSocket from "ws";
import { wsUrl, wsOptions } from "./ws-token.mjs";
const WS = wsUrl(process.env.GATEWAY_WS ?? "ws://127.0.0.1:8080/ws");
const ws = new WebSocket(WS, wsOptions());
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
ws.onopen = async () => {
  const s = await rpc("mcpServerStatus/list");
  const servers = Array.isArray(s) ? s : (s.servers ?? s.statuses ?? s.data ?? []);
  for (const sv of servers) {
    const t = sv.tools ?? [];
    const names = Array.isArray(t) ? t.map((x) => x.name) : typeof t === "object" ? Object.keys(t) : [String(t)];
    console.log(sv.name, "::", names.join(", "));
  }
  process.exit(0);
};
