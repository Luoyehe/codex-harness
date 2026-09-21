import { describe, it, expect, afterAll } from "vitest";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("accepts browser-canonical loopback hosts on HTTP port 80", () => {
    const port = 80;
    delete process.env.TRUSTED_HOSTS;
    const token = new AuthToken(tempHome(), port);
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      const host = new URL(`http://${hostname}:${port}`).host;
      expect(token.isTrustedHost(host)).toBe(true);
      expect(token.isTrustedHost(`${hostname}:12345`)).toBe(false);
      expect(token.isTrustedHost(`${hostname}:443`)).toBe(false);
    }
    expect(token.isTrustedHost("evil.example")).toBe(false);
  });
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

  it("keeps default-port aliases for explicitly configured bare IPv6 hosts", () => {
    const a = makeToken("[::1]");
    expect(a.isTrustedHost("[::1]:80")).toBe(true);
    expect(a.isTrustedHost("[::1]:443")).toBe(true);
    expect(a.isTrustedHost("[::1]:12345")).toBe(false);
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
    expect(a.isTrustedHost("localhost")).toBe(false);
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
  it.skipIf(process.platform === "win32")("rejects a control directory with group or other access, even with an environment token", () => {
    const home = tempHome();
    chmodSync(home, 0o755);
    process.env.GATEWAY_TOKEN = "A".repeat(40);
    try {
      expect(() => new AuthToken(home, PORT)).toThrow(/control directory.*group\/other access/i);
    } finally {
      delete process.env.GATEWAY_TOKEN;
      chmodSync(home, 0o700);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlink in place of the control directory", () => {
    const parent = tempHome();
    const target = tempHome();
    const linkedHome = join(parent, "linked-control-home");
    symlinkSync(target, linkedHome, "dir");
    expect(() => new AuthToken(linkedHome, PORT)).toThrow(/control directory.*real directory/i);
  });

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

  it("rejects an environment token too large for bounded HTTP credentials", () => {
    process.env.GATEWAY_TOKEN = "A".repeat(4097);
    try { expect(() => new AuthToken(tempHome(), PORT)).toThrow(/32-4096/); }
    finally { delete process.env.GATEWAY_TOKEN; }
  });

  it("loads only a bounded regular token file and tightens its permissions", () => {
    const home = tempHome();
    const file = join(home, "gateway-token");
    const persisted = "B".repeat(40);
    writeFileSync(file, persisted + "\n", { mode: 0o666 });
    const token = new AuthToken(home, PORT);
    expect(token.token).toBe(persisted);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("publishes a new token as one singly-linked final file with no creation temporary left behind", () => {
    const home = tempHome();
    const token = new AuthToken(home, PORT);
    const file = join(home, "gateway-token");
    expect(token.token).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(home)).toEqual(["gateway-token"]);
    expect(statSync(file).nlink).toBe(1);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("recovers only the exact complete two-link state left by an interrupted atomic publish", () => {
    const home = tempHome();
    const file = join(home, "gateway-token");
    const temporary = join(home, `.gateway-token.create-${"a".repeat(32)}.tmp`);
    const persisted = "b".repeat(64);
    writeFileSync(temporary, persisted + "\n", { mode: 0o600 });
    linkSync(temporary, file);
    expect(statSync(file).nlink).toBe(2);

    const token = new AuthToken(home, PORT);
    expect(token.token).toBe(persisted);
    expect(existsSync(temporary)).toBe(false);
    expect(statSync(file).nlink).toBe(1);
  });

  it("does not heal a lookalike creation link whose payload could not have been generated", () => {
    const home = tempHome();
    const file = join(home, "gateway-token");
    const temporary = join(home, `.gateway-token.create-${"c".repeat(32)}.tmp`);
    const persisted = "D".repeat(40);
    writeFileSync(temporary, persisted + "\n", { mode: 0o600 });
    linkSync(temporary, file);
    expect(() => new AuthToken(home, PORT)).toThrow(/Cannot safely load/);
    expect(readFileSync(file, "utf8")).toBe(persisted + "\n");
    expect(existsSync(temporary)).toBe(true);
    expect(statSync(file).nlink).toBe(2);
  });

  it("fails closed without replacing a multiply-linked or oversized token authority", () => {
    const home = tempHome();
    const file = join(home, "gateway-token");
    const alias = join(home, "original-token-alias");
    const persisted = "C".repeat(40);
    writeFileSync(file, persisted + "\n", { mode: 0o600 });
    linkSync(file, alias);
    expect(() => new AuthToken(home, PORT)).toThrow(/Cannot safely load/);
    expect(readFileSync(alias, "utf8")).toBe(persisted + "\n");

    writeFileSync(file, "D".repeat(4098), { mode: 0o600 });
    expect(() => new AuthToken(home, PORT)).toThrow(/Cannot safely load/);
    expect(readFileSync(file, "utf8")).toBe("D".repeat(4098));
  });

  it("fails closed on an existing malformed token and reuses the first-start winner", () => {
    const malformedHome = tempHome();
    const malformedFile = join(malformedHome, "gateway-token");
    writeFileSync(malformedFile, "not-a-valid-token\n", { mode: 0o600 });
    expect(() => new AuthToken(malformedHome, PORT)).toThrow(/invalid format/);
    expect(readFileSync(malformedFile, "utf8")).toBe("not-a-valid-token\n");

    const sharedHome = tempHome();
    const first = new AuthToken(sharedHome, PORT);
    const second = new AuthToken(sharedHome, PORT);
    expect(second.token).toBe(first.token);
  });

  it("does not accept a plausible token prefix without the durable newline commit marker", () => {
    const home = tempHome();
    const file = join(home, "gateway-token");
    writeFileSync(file, "E".repeat(40), { mode: 0o600 });
    expect(() => new AuthToken(home, PORT)).toThrow(/invalid format/);
    expect(readFileSync(file, "utf8")).toBe("E".repeat(40));
  });

  it("concurrent first starts all converge on the no-clobber winner", async () => {
    const home = tempHome();
    const source = new URL("../src/auth-token.ts", import.meta.url).href;
    const gatewayRoot = fileURLToPath(new URL("..", import.meta.url));
    const childSource = `import { AuthToken } from ${JSON.stringify(source)}; process.stdout.write(new AuthToken(process.argv[1], ${PORT}).token);`;
    const childEnv = { ...process.env };
    delete childEnv.GATEWAY_TOKEN;
    delete childEnv.TRUSTED_HOSTS;

    const launches = Array.from({ length: 4 }, () => new Promise<string>((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--eval", childSource, home], {
        cwd: gatewayRoot,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code === 0) resolveChild(stdout);
        else rejectChild(new Error(`concurrent AuthToken child exited ${code}: ${stderr}`));
      });
    }));
    const tokens = await Promise.all(launches);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(home)).toEqual(["gateway-token"]);
    expect(statSync(join(home, "gateway-token")).nlink).toBe(1);
  }, 15_000);
});

describe("HTML bootstrap trust modes", () => {
  it("never grants implicit local trust by default", () => {
    expect(makeToken().canBootstrap({ headers: {} })).toBe(false);
  });

  it("requires a secret in strict mode and supports browser-native Basic auth", () => {
    process.env.GATEWAY_BOOTSTRAP_AUTH = "required";
    try {
      const token = makeToken();
      expect(token.canBootstrap({ headers: { host: "localhost:8410" } })).toBe(false);
      expect(token.canBootstrap({ headers: {}, query: { token: token.token } })).toBe(false);
      expect(token.canBootstrap({ headers: { authorization: `Basic ${Buffer.from(`codex:${token.token}`).toString("base64")}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { authorization: `Bearer ${token.token}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { authorization: `basic ${Buffer.from(`codex:${token.token}`).toString("base64")}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { authorization: `bearer ${token.token}` } })).toBe(true);
      expect(token.canBootstrap({ headers: { cookie: `${token.cookieName}=${token.token}` } })).toBe(true);
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

it("uses distinct persistent cookie names for instances on the same hostname", () => {
  const home = tempHome();
  const a = new AuthToken(home, 8410);
  const b = new AuthToken(home, 8411);
  expect(a.cookieName).not.toBe(b.cookieName);
  const combined = `${a.cookieName}=${a.token}; ${b.cookieName}=${b.token}`;
  expect(a.extract({ headers: { cookie: combined } })).toBe(a.token);
  expect(b.extract({ headers: { cookie: combined } })).toBe(b.token);
  expect(new AuthToken(home, 8410).cookieName).toBe(a.cookieName);
});
