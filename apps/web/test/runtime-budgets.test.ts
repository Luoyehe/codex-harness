import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedRedact, boundedRuntimeJson } from "../src/utils/bounded-runtime";
import { HistoricalImageUrlPool } from "../src/utils/historical-image-urls";

describe("untrusted runtime materialization budgets", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not execute accessors while projecting tool output", () => {
    const value: Record<string, unknown> = { safe: "visible" };
    Object.defineProperty(value, "secret", { enumerable: true, get: () => { throw new Error("getter executed"); } });
    expect(boundedRuntimeJson(value)).toBe("（内容超过浏览器安全检查预算，未展开）");
  });

  it("fails closed before serializing an oversized runtime graph", () => {
    const values = Array.from({ length: 20 }, (_, index) => ({ index }));
    expect(boundedRuntimeJson(values, 1_000, 8, 4)).toContain("超过浏览器安全检查预算");
  });

  it("bounds management output before replacing secrets", () => {
    const output = `${"x".repeat(32)}SECRET`;
    const redacted = boundedRedact(output, ["SECRET"], 16);
    expect(redacted).not.toContain("SECRET");
    expect(redacted.length).toBeLessThan(100);
    expect(redacted).toContain("仅检查并显示前 16");
  });
});

describe("historical image URL pool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("bounds aggregate decoded bytes and releases each object URL exactly once", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const pool = new HistoricalImageUrlPool(6, 6);
    const first = pool.acquire("AQIDBA==", "image/png"); // four decoded bytes
    expect(pool.retainedBytes).toBe(4);
    expect(() => pool.acquire("AQIDBA==", "image/png")).toThrow("内存预算已满");
    expect(create).toHaveBeenCalledTimes(1);

    first.release();
    first.release();
    expect(pool.retainedBytes).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(1);
    const second = pool.acquire("AQIDBA==", "image/png");
    second.release();
    expect(revoke).toHaveBeenLastCalledWith("blob:second");
  });

  it("rejects malformed or non-image payloads before allocating a Blob URL", () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const pool = new HistoricalImageUrlPool(64, 64);
    expect(() => pool.acquire("not base64", "image/png")).toThrow();
    expect(() => pool.acquire("AQIDBA==", "text/html")).toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(pool.retainedBytes).toBe(0);
  });

  it("returns its reservation when URL creation fails", () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => { throw new Error("URL allocation failed"); });
    const pool = new HistoricalImageUrlPool(64, 64);
    expect(() => pool.acquire("AQIDBA==", "image/png")).toThrow("URL allocation failed");
    expect(pool.retainedBytes).toBe(0);
  });
});
