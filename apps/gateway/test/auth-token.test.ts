import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthToken } from "../src/auth-token.js";

// TRUSTED_HOSTS is read in the constructor — drive it via process.env.
const PORT = 8410;
const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "auth-token-test-"));
  dirs.push(dir);
  return dir;
}

function makeToken(trustedHosts?: string): AuthToken {
  if (trustedHosts === undefined) delete process.env.TRUSTED_HOSTS;
  else process.env.TRUSTED_HOSTS = trustedHosts;
  return new AuthToken(tempHome(), PORT);
}

afterAll(() => {
  delete process.env.TRUSTED_HOSTS;
  delete process.env.GATEWAY_TOKEN;
  delete process.env.ALLOW_QUERY_TOKEN;
  delete process.env.GATEWAY_BOOTSTRAP_AUTH;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("AuthToken trusted hosts", () => {
  it("trusts loopback variants with the gateway port", () => {
    const a = makeToken();
    expect(a.isTrustedHost(`127.0.0.1:${PORT}`)).toBe(true);
    expect(a.isTrustedHost(`localhost:${PORT}`)).toBe(true);
    expect(a.isTrustedHost(`[::1]:${PORT}`)).toBe(true);
  });

  it("rejects foreign hosts (DNS-rebinding defense)", () => {
    const a = makeToken();
    expect(a.isTrustedHost("evil.example")).toBe(false);
    expect(a.isTrustedHost("evil.example:443")).toBe(false);
    expect(a.isTrustedHost("127.0.0.1:9999")).toBe(false); // wrong port
    expect(a.isTrustedHost(undefined)).toBe(false);
    expect(a.isTrustedHost("")).toBe(false);
  });

  it("portful entry is trusted exactly as written", () => {
    const a = makeToken("proxy.example.com:3000");
    expect(a.isTrustedHost("proxy.example.com:3000")).toBe(true);
    expect(a.isTrustedHost("proxy.example.com")).toBe(false); // bare not listed
  });

  it("portless entry trusts bare hostname AND gateway-port variant", () => {
    // Browsers omit the port for 443 — the bare hostname must match.
    const a = makeToken("codex.example.com");
    expect(a.isTrustedHost("codex.example.com")).toBe(true);
    expect(a.isTrustedHost(`codex.example.com:${PORT}`)).toBe(true);
    expect(a.isTrustedHost("codex.example.com:3000")).toBe(false); // other ports stay out
  });

  it("comma-separated entries all apply", () => {
    const a = makeToken("a.example, b.example:8443");
    expect(a.isTrustedHost("a.example")).toBe(true);
    expect(a.isTrustedHost("b.example:8443")).toBe(true);
  });

  it("host comparison is case-insensitive (DNS semantics)", () => {
    const a = makeToken("codex.example.com");
    expect(a.isTrustedHost("Codex.Example.COM")).toBe(true);
    expect(a.isTrustedHost("CODEX.EXAMPLE.COM:8410")).toBe(true);
    const b = makeToken("Proxy.Example.Com:3000");
    expect(b.isTrustedHost("proxy.example.com:3000")).toBe(true);
    expect(b.isTrustedHost("PROXY.EXAMPLE.COM:3000")).toBe(true);
  });

  it("default ports are stripped before comparison", () => {
    const a = makeToken("codex.example.com");
    expect(a.isTrustedHost("codex.example.com:443")).toBe(true);
    expect(a.isTrustedHost("codex.example.com:80")).toBe(true);
    expect(a.isTrustedHost("codex.example.com:3000")).toBe(false); // non-default stays explicit
  });

  it("an explicit :443 entry also trusts the bare hostname browsers send", () => {
    const a = makeToken("edge.example.com:443");
    expect(a.isTrustedHost("edge.example.com")).toBe(true);
    expect(a.isTrustedHost("edge.example.com:443")).toBe(true);
    expect(a.isTrustedHost("edge.example.com:8443")).toBe(false);
    const b = makeToken("Edge.Example.COM:443"); // mixed-case config
    expect(b.isTrustedHost("EDGE.example.com")).toBe(true);
  });

  it("keeps exact loopback hosts trusted when the gateway itself uses port 443", () => {
    delete process.env.TRUSTED_HOSTS;
    const a = new AuthToken(tempHome(), 443);
    expect(a.isTrustedHost("127.0.0.1:443")).toBe(true);
    expect(a.isTrustedHost("localhost:443")).toBe(true);
  });
});

describe("AuthToken verify", () => {
  it("accepts the exact token and rejects everything else", () => {
    const a = makeToken();
    expect(a.verify(a.token)).toBe(true);
    expect(a.verify("nope")).toBe(false);
    expect(a.verify(undefined)).toBe(false);
    expect(a.verify(null)).toBe(false);
    expect(a.verify(`${a.token}x`)).toBe(false);
  });
});

describe("AuthToken extraction", () => {
  it("rejects URL query credentials by default and supports explicit legacy opt-in", () => {
    const a = makeToken();
    expect(a.extract({ query: { token: a.token }, headers: {} })).toBeUndefined();
    process.env.ALLOW_QUERY_TOKEN = "1";
    expect(a.extract({ query: { token: a.token }, headers: {} })).toBe(a.token);
    delete process.env.ALLOW_QUERY_TOKEN;
  });
});

describe("AuthToken token format", () => {
  it("rejects malformed GATEWAY_TOKEN instead of running with a weak one", () => {
    process.env.GATEWAY_TOKEN = "short";
    expect(() => new AuthToken(tempHome(), PORT)).toThrow(/GATEWAY_TOKEN/);
    delete process.env.GATEWAY_TOKEN;
  });

  it("accepts a well-formed GATEWAY_TOKEN override", () => {
    process.env.GATEWAY_TOKEN = "A".repeat(40);
    const a = new AuthToken(tempHome(), PORT);
    expect(a.token).toBe("A".repeat(40));
    delete process.env.GATEWAY_TOKEN;
  });
});

describe("HTML bootstrap trust modes", () => {
  it("preserves explicit local trust by default", () => {
    expect(makeToken().canBootstrap({ headers: {} })).toBe(true);
  });

  it("requires a secret in strict mode and supports browser-native Basic auth", () => {
    process.env.GATEWAY_BOOTSTRAP_AUTH = "required";
    try {
      const token = makeToken();
      expect(token.canBootstrap({ headers: { host: "localhost:8410" } })).toBe(false);
      expect(token.canBootstrap({ headers: {}, query: { token: token.token } })).toBe(false);
      expect(token.canBootstrap({ headers: { authorization: `Basic ${Buffer.from(`codex:${token.token}`).toString("base64")}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { authorization: `Bearer ${token.token}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { cookie: `gw_token=${token.token}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { cookie: `not_gw_token=${token.token}` } })).toBe(false);
      expect(token.canBootstrap({ headers: { authorization: "Basic !!!" } })).toBe(false);
    } finally { delete process.env.GATEWAY_BOOTSTRAP_AUTH; }
  });

  it("rejects a misspelled trust mode instead of silently enabling local trust", () => {
    process.env.GATEWAY_BOOTSTRAP_AUTH = "require";
    try { expect(() => makeToken()).toThrow(/GATEWAY_BOOTSTRAP_AUTH/); }
    finally { delete process.env.GATEWAY_BOOTSTRAP_AUTH; }
  });
});
