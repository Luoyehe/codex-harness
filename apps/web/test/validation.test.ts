import { describe, expect, it } from "vitest";
import { clampedInteger, validatedApiBaseUrl, validatedHostname, validatedHttpUrl } from "../src/utils/validation";

describe("untrusted URL validation", () => {
  it("accepts HTTP(S) links and rejects executable or credentialed URLs", () => {
    expect(validatedHttpUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
    expect(validatedHttpUrl("javascript:alert(1)")).toBeNull();
    expect(validatedHttpUrl(undefined)).toBeNull();
    expect(validatedHttpUrl("https://user:pass@example.com/")).toBeNull();
    expect(validatedHttpUrl("https://example.com/#secret")).toBeNull();
  });

  it("accepts a host only for edge configuration", () => {
    expect(validatedHostname("codex.example.com")).toBe("codex.example.com");
    expect(validatedHostname("https://codex.example.com")).toBeNull();
    expect(validatedHostname("codex.example.com:8443")).toBeNull();
  });

  it("allows queries on links but not provider base URLs", () => {
    expect(validatedHttpUrl("https://example.com/v1?view=full")).toBe("https://example.com/v1?view=full");
    expect(validatedApiBaseUrl("http://127.0.0.1:8000/v1")).toBe("http://127.0.0.1:8000/v1");
    expect(validatedApiBaseUrl("https://example.com/v1?token=secret")).toBeNull();
  });

  it("clamps non-finite and out-of-range integers", () => {
    expect(clampedInteger(Number.NaN, 1, 10, 5)).toBe(5);
    expect(clampedInteger(99, 1, 10, 5)).toBe(10);
    expect(clampedInteger(3.9, 1, 10, 5)).toBe(3);
  });
});
