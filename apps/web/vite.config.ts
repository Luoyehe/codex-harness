import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareDevGatewayProxy, readDevGatewayToken, trustedDevGatewayRequest } from "./dev-gateway-proxy";

/**
 * Dev proxy for the gateway WebSocket. The gateway authenticates every WS
 * (Bearer credential + trusted-host allowlist). Only verified same-origin traffic
 * from this loopback dev server may receive the local credential:
 *   - changeOrigin rewrites the Host header to the gateway's own host
 *     (127.0.0.1:8410 is on the allowlist; 127.0.0.1:5173 is not);
 *   - the original Host and Origin are validated before Origin is stripped;
 *   - GATEWAY_TOKEN or the token in GATEWAY_CONTROL_HOME (default
 *     ~/.codex-harness-control) is read lazily and injected as Bearer auth;
 *   - browser cookies/authorization are not forwarded, and the proxy need not
 *     know the production instance-scoped cookie name.
 * The local gateway requires GATEWAY_UNSAFE_SINGLE_USER=1 for this same-user
 * workflow. This trusted-machine dev shortcut does not provide production's
 * separate-UID Agent/control-plane isolation and must not be exposed remotely.
 */
function devGatewayToken(): string {
  return readDevGatewayToken(process.env, homedir(), (directory) => readFileSync(join(directory, "gateway-token"), "utf8"));
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
