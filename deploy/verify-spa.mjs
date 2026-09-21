// Bounded, read-only HTML/asset checks. The administrator credential is sent
// only to the selected loopback gateway, never to the optional public edge.
import http from "node:http";
import https from "node:https";
import { token } from "./ws-token.mjs";
import { verificationTimeout } from "./verification-client.mjs";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_HEALTH_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 128;

function get(url, { timeout, authorization, insecure = false, maxBytes }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const request = (url.protocol === "https:" ? https : http).get(url, {
      headers: authorization ? { Authorization: `Bearer ${authorization}` } : {}, rejectUnauthorized: !insecure,
    }, response => {
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        request.destroy(new Error("Response too large"));
        return;
      }
      response.on("data", data => {
        bytes += data.length;
        if (bytes > maxBytes) { request.destroy(new Error("Response too large")); return; }
        chunks.push(data);
      });
      response.on("end", () => { clearTimeout(timer); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks, bytes).toString("utf8"), bytes }); });
      response.on("error", error => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => request.destroy(new Error("HTTP verification timed out")), timeout);
    request.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

try {
  const port = Number(process.env.PORT ?? 8080), timeout = verificationTimeout();
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !token) throw new Error("Gateway configuration unavailable");
  const base = new URL(`http://127.0.0.1:${port}/`);
  const options = { timeout, authorization: token };
  const html = await get(base, { ...options, maxBytes: MAX_HTML_BYTES });
  let totalBytes = html.bytes;
  if (html.status !== 200 || !String(html.headers["content-type"]).includes("text/html") || !/<div\s+[^>]*id=["']root["']/.test(html.body)) throw new Error("Not the SPA");
  const assets = [], seenAssets = new Set();
  for (const match of html.body.matchAll(/(?:src|href)=["'](\/?assets\/[A-Za-z0-9_./-]+)["']/g)) {
    if (seenAssets.has(match[1])) continue;
    seenAssets.add(match[1]);
    assets.push(match[1]);
    if (assets.length > MAX_ASSETS) throw new Error("Too many SPA assets");
  }
  if (!assets.some(asset => asset.endsWith(".js"))) throw new Error("No app script");
  for (const asset of assets) {
    if (asset.split("/").includes("..")) throw new Error("Invalid asset path");
    const response = await get(new URL(asset, base), { ...options, maxBytes: MAX_ASSET_BYTES });
    totalBytes += response.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("SPA verification response budget exceeded");
    const type = String(response.headers["content-type"] ?? "").toLowerCase();
    if (response.status !== 200 || !response.body || (asset.endsWith(".js") ? !/(?:java|ecma)script/.test(type) : asset.endsWith(".css") ? !type.includes("text/css") : type.includes("text/html"))) throw new Error("Asset unavailable");
  }
  const health = await get(new URL("healthz", base), { ...options, maxBytes: MAX_HEALTH_BYTES });
  totalBytes += health.bytes;
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("SPA verification response budget exceeded");
  const state = JSON.parse(health.body);
  if (health.status !== 200 || state?.ok !== true || state.codexState !== "ready") throw new Error("Gateway not ready");
  if (process.env.EDGE_URL) {
    const edge = new URL(process.env.EDGE_URL);
    if (edge.protocol !== "https:" || edge.username || edge.password || edge.search || edge.hash || !["", "/"].includes(edge.pathname)) throw new Error("Invalid HTTPS edge URL");
    const response = await get(edge, { timeout, insecure: process.env.EDGE_INSECURE === "1", maxBytes: MAX_HTML_BYTES });
    const location = response.headers.location;
    if (![401, 403].includes(response.status) && !([302, 303, 307, 308].includes(response.status) && typeof location === "string" && /^(?:https:\/\/|\/)/.test(location))) throw new Error("Public edge did not require authentication");
    console.log("PUBLIC-EDGE-PROBE-PASS (unauthenticated request only; administrator browser login still required)");
  }
  console.log(`SPA-VERIFICATION-PASS (${assets.length} assets, authenticated loopback and ready health; no server mutations)`);
} catch {
  console.error("SPA-VERIFICATION-FAIL: check control-home authentication, HTML/assets, readiness and optional HTTPS edge; credentials and response bodies are not logged.");
  process.exitCode = 1;
}
