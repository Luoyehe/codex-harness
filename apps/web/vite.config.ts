import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareDevGatewayProxy, trustedDevGatewayRequest } from "./dev-gateway-proxy";

/**
 * Dev proxy for the gateway WebSocket. The gateway authenticates every WS
 * (token cookie + trusted-host allowlist). Only verified same-origin traffic
 * from this loopback dev server may receive the local credential:
 *   - changeOrigin rewrites the Host header to the gateway's own host
 *     (127.0.0.1:8410 is on the allowlist; 127.0.0.1:5173 is not);
 *   - the original Host and Origin are validated before Origin is stripped;
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
  plugins: [react(), {
    name: "loopback-gateway-origin-guard",
    configureServer(server) {
      // Vite's ordinary HTTP host/CORS checks do not protect WS upgrades.
      server.httpServer?.prependListener("upgrade", (request, socket) => {
        if (request.url?.startsWith("/ws") && !trustedDevGatewayRequest(request.headers)) socket.destroy();
      });
    },
  }],
  test: { css: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: ["localhost"],
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:8410",
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (proxyReq, request, socket) => {
            prepareDevGatewayProxy(request.headers, proxyReq, socket, devGatewayToken);
          });
        },
      },
    },
  },
});
