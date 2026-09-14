// Read-only WebSocket token / Origin / Host verification.
// Run as the administrator/control identity with GATEWAY_CONTROL_HOME set.
import { token } from "./ws-token.mjs";
import { verifyWebSocketAuth } from "./ws-auth-probe.mjs";

try {
  if (!await verifyWebSocketAuth({ port: Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 8080), token })) process.exitCode = 1;
} catch {
  console.error("WS-AUTH-FAIL: check GATEWAY_CONTROL_HOME credentials, authenticated HTML bootstrap, and gateway readiness.");
  process.exitCode = 1;
}
