import { describe, expect, it, vi } from "vitest";
import { prepareDevGatewayProxy, trustedDevGatewayRequest } from "../dev-gateway-proxy";

describe("credential-bearing development proxy", () => {
  it.each(["127.0.0.1:5173", "localhost:5173"])("accepts the configured same-origin loopback host %s", (host) => {
    const request = { removeHeader: vi.fn(), setHeader: vi.fn(), destroy: vi.fn() };
    const socket = { destroy: vi.fn() };
    const readToken = vi.fn(() => "synthetic-token");
    expect(prepareDevGatewayProxy({ host, origin: `http://${host}` }, request, socket, readToken)).toBe(true);
    expect(request.removeHeader).toHaveBeenCalledWith("origin");
    expect(request.setHeader).toHaveBeenCalledWith("cookie", "gw_token=synthetic-token");
    expect(socket.destroy).not.toHaveBeenCalled();
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
