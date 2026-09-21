import fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthToken, setBootstrapCookie } from "../src/auth-token.js";

afterEach(() => vi.unstubAllEnvs());

it("requires credentials before issuing a cookie in strict HTTP bootstrap", async () => {
  vi.stubEnv("GATEWAY_TOKEN", "test-only-bootstrap-secret-12345678");
  vi.stubEnv("GATEWAY_BOOTSTRAP_AUTH", "required");
  const controlHome = mkdtempSync(path.join(tmpdir(), "http-auth-control-"));
  const token = new AuthToken(controlHome, 8410);
  const app = fastify();
  app.addHook("onRequest", async (req, reply) => setBootstrapCookie(token, req, reply, false));
  app.get("/", async () => "test page");
  try {
    const unauthorized = await app.inject({ url: "/", headers: { host: "localhost:8410" } });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["set-cookie"]).toBeUndefined();
    expect(unauthorized.headers["www-authenticate"]).toContain("Basic");
    const authorized = await app.inject({ url: "/", headers: {
      host: "localhost:8410", authorization: `Basic ${Buffer.from(`codex:${token.token}`).toString("base64")}`,
    } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["set-cookie"]).toContain(`${token.cookieName}=${token.token}; Path=/; HttpOnly; SameSite=Strict`);
    const untrusted = await app.inject({ url: "/", headers: { host: "attacker.example", authorization: `Bearer ${token.token}` } });
    expect(untrusted.headers["set-cookie"]).toBeUndefined();
  } finally {
    await app.close();
    rmSync(controlHome, { recursive: true, force: true });
  }
});
