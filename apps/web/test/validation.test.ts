import { describe, expect, it } from "vitest";
import { validatedApiBaseUrl, validatedHttpUrl } from "../src/utils/validation";

describe("untrusted URL validation", () => {
  it("accepts HTTP(S) links and rejects executable or credentialed URLs", () => {
    expect(validatedHttpUrl("https://example.com/a?q=1")).toBe("https://example.com/a?q=1");
    expect(validatedHttpUrl("javascript:alert(1)")).toBeNull();
    expect(validatedHttpUrl(undefined)).toBeNull();
    expect(validatedHttpUrl("https://user:pass@example.com/")).toBeNull();
    expect(validatedHttpUrl("https://example.com/#secret")).toBeNull();
  });

  it("allows queries on links but not provider base URLs", () => {
    expect(validatedHttpUrl("https://example.com/v1?view=full")).toBe("https://example.com/v1?view=full");
    expect(validatedApiBaseUrl("http://127.0.0.1:8000/v1")).toBe("http://127.0.0.1:8000/v1");
    expect(validatedApiBaseUrl("https://example.com/v1?token=secret")).toBeNull();
  });

});
