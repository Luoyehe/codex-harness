import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareDevGatewayProxy, readDevGatewayToken, readPinnedDevGatewayToken, trustedDevGatewayRequest } from "../dev-gateway-proxy";

describe("credential-bearing development proxy", () => {
  it("reads only a private, bounded, descriptor-pinned control token", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dev-gateway-token-"));
    const token = path.join(directory, "gateway-token");
    try {
      writeFileSync(token, "x".repeat(40) + "\n", { mode: 0o600 });
      chmodSync(token, 0o600);
      expect(readPinnedDevGatewayToken(directory).trim()).toBe("x".repeat(40));

      writeFileSync(token, "x".repeat(4099), { mode: 0o600 });
      expect(() => readPinnedDevGatewayToken(directory)).toThrow();
      if (process.platform !== "win32") {
        rmSync(token);
        const target = path.join(directory, "target");
        writeFileSync(target, "x".repeat(40) + "\n", { mode: 0o600 });
        symlinkSync(target, token);
        expect(() => readPinnedDevGatewayToken(directory)).toThrow();
        rmSync(token);
        linkSync(target, token);
        expect(() => readPinnedDevGatewayToken(directory)).toThrow();
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["127.0.0.1:5173", "localhost:5173"])("accepts the configured same-origin loopback host %s", (host) => {
    const request = { removeHeader: vi.fn(), setHeader: vi.fn(), destroy: vi.fn() };
    const socket = { destroy: vi.fn() };
    const readToken = vi.fn(() => "x".repeat(40));
    expect(prepareDevGatewayProxy({ host, origin: `http://${host}` }, request, socket, readToken)).toBe(true);
    expect(request.removeHeader).toHaveBeenCalledWith("origin");
    expect(request.removeHeader).toHaveBeenCalledWith("cookie");
    expect(request.removeHeader).toHaveBeenCalledWith("authorization");
    expect(request.setHeader).toHaveBeenCalledExactlyOnceWith("authorization", `Bearer ${"x".repeat(40)}`);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it.each(["", "short", "x".repeat(4097), `${"x".repeat(40)}\r\nInjected: yes`])("rejects missing or malformed credentials", (token) => {
    const request = { removeHeader: vi.fn(), setHeader: vi.fn(), destroy: vi.fn() };
    const socket = { destroy: vi.fn() };
    expect(prepareDevGatewayProxy({ host: "localhost:5173", origin: "http://localhost:5173" }, request, socket, () => token)).toBe(false);
    expect(request.setHeader).not.toHaveBeenCalled();
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it("reads the configured control directory lazily and never the Agent home", () => {
    const readFile = vi.fn(() => `  ${"x".repeat(40)}\n`);
    expect(readDevGatewayToken({ GATEWAY_CONTROL_HOME: "control" }, "user-home", readFile)).toBe("x".repeat(40));
    expect(readFile).toHaveBeenCalledExactlyOnceWith("control");
    readFile.mockClear();
    readDevGatewayToken({}, "user-home", readFile);
    expect(readFile).toHaveBeenCalledExactlyOnceWith("user-home/.codex-harness-control");
  });

  it("prioritizes an explicit token without reading a file and tolerates not-yet-created files", () => {
    const readFile = vi.fn(() => { throw new Error("not created"); });
    expect(readDevGatewayToken({ GATEWAY_TOKEN: "x".repeat(40), GATEWAY_CONTROL_HOME: "control" }, "home", readFile)).toBe("x".repeat(40));
    expect(readFile).not.toHaveBeenCalled();
    expect(readDevGatewayToken({}, "home", readFile)).toBe("");
  });

  it.each([
    { host: "127.0.0.1:5173", origin: "https://untrusted.example" },
    { host: "127.0.0.1:5173", origin: "http://localhost:5173" },
    { host: "untrusted.example:5173", origin: "http://untrusted.example:5173" },
    { host: "127.0.0.1:5174", origin: "http://127.0.0.1:5174" },
    { host: "127.0.0.1:5173" },
    { host: "127.0.0.1:5173", origin: "null" },
    { host: ["127.0.0.1:5173"], origin: "http://127.0.0.1:5173" },
    { host: "127.0.0.1:5173", origin: ["http://127.0.0.1:5173"] },
    { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173/" },
  ])("rejects invalid source headers before reading any credential: %j", (headers) => {
    const request = { removeHeader: vi.fn(), setHeader: vi.fn(), destroy: vi.fn() };
    const socket = { destroy: vi.fn() };
    const readToken = vi.fn(() => "synthetic-token");
    expect(trustedDevGatewayRequest(headers)).toBe(false);
    expect(prepareDevGatewayProxy(headers, request, socket, readToken)).toBe(false);
    expect(readToken).not.toHaveBeenCalled();
    expect(request.setHeader).not.toHaveBeenCalled();
    expect(request.removeHeader).not.toHaveBeenCalled();
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
