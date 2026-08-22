import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Dev proxy for the gateway WebSocket. The gateway authenticates every WS
 * (token cookie + trusted-host allowlist), so the proxy must make the
 * proxied request look like a first-party local client:
 *   - changeOrigin rewrites the Host header to the gateway's own host
 *     (127.0.0.1:8410 is on the allowlist; 127.0.0.1:5173 is not);
 *   - the browser's Origin (http://127.0.0.1:5173) is stripped — same-host
 *     Vite dev traffic, not a cross-origin page;
 *   - the gateway token (read lazily from ~/.codex/gateway-token so a
 *     first-run token generated after Vite starts is still picked up) is
 *     injected as the gw_token cookie.
 */
function devGatewayToken(): string {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  try {
    return readFileSync(join(codexHome, "gateway-token"), "utf8").trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8410",
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.removeHeader("origin");
            const token = devGatewayToken();
            if (token) proxyReq.setHeader("cookie", `gw_token=${token}`);
          });
        },
      },
    },
  },
});
