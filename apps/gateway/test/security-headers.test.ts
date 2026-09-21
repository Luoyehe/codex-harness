import { expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, contentSecurityPolicy, isTrustedBrowserOrigin } from "../src/security-headers.js";

function connectSources(policy: string): string[] {
  return policy.split(";").map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === "connect-src")?.slice(1) ?? [];
}

it("permits validated embedded media without automatic remote media requests", () => {
  expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: blob:");
  expect(CONTENT_SECURITY_POLICY).toContain("media-src 'self' data: blob:");
  expect(CONTENT_SECURITY_POLICY).not.toMatch(/(?:img|media)-src[^;]*https?:/);
  expect(connectSources(CONTENT_SECURITY_POLICY)).toEqual(["'self'"]);
});

it("emits only the exact trusted websocket authority", () => {
  expect(connectSources(contentSecurityPolicy("Example.TEST:8443", false)))
    .toEqual(["'self'", "ws://example.test:8443"]);
  expect(connectSources(contentSecurityPolicy("example.test", true)))
    .toEqual(["'self'", "wss://example.test"]);
  for (const malformed of ["example.test/path", "user@example.com", "example.test; wss:", "example.test\nInjected: yes"]) {
    expect(connectSources(contentSecurityPolicy(malformed, true))).toEqual(["'self'"]);
  }
  for (const policy of [CONTENT_SECURITY_POLICY, contentSecurityPolicy("example.test", true)]) {
    expect(connectSources(policy)).not.toContain("ws:");
    expect(connectSources(policy)).not.toContain("wss:");
  }
});

it("requires browser origins to match both authority and configured scheme", () => {
  expect(isTrustedBrowserOrigin("https://example.test", "example.test", true)).toBe(true);
  expect(isTrustedBrowserOrigin("http://example.test", "example.test", true)).toBe(false);
  expect(isTrustedBrowserOrigin("https://example.test", "example.test", false)).toBe(false);
  expect(isTrustedBrowserOrigin("http://example.test", "example.test", false)).toBe(true);
  expect(isTrustedBrowserOrigin("http://evil.test", "example.test", false)).toBe(false);
  expect(isTrustedBrowserOrigin("not a URL", "example.test", false)).toBe(false);
});
