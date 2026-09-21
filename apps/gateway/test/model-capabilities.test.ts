import { expect, it, vi } from "vitest";
import { validateModelEffort } from "../src/model-capabilities.js";

it("validates the selected model, not the configured provider default", async () => {
  const request = vi.fn(async (method: string, params: any) => method === "thread/resume" ? { model: "chosen" } : ({
    data: [{ id: "default", model: "default", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }, { id: "chosen", model: "chosen", supportedReasoningEfforts: [{ reasoningEffort: "vendor-deep" }] }], nextCursor: null,
  }));
  await expect(validateModelEffort({ request } as any, "thread", undefined, "high")).rejects.toThrow("未声明支持");
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "vendor-deep")).resolves.toBeUndefined();
  await expect(validateModelEffort({ request } as any, "thread", "missing", "high")).rejects.toThrow("能力未知");
});

it("follows bounded pagination and rejects cursor loops or unknown effort capabilities", async () => {
  const request = vi.fn(async (_: string, params: any) => params.cursor ? { data: [{ id: "chosen", model: "chosen", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] }], nextCursor: null } : { data: [], nextCursor: "next" });
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "ultra")).rejects.toThrow("未声明支持");
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "medium")).rejects.toThrow("未声明支持");
  request.mockImplementation(async () => ({ data: [], nextCursor: "loop" }));
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "ultra")).rejects.toThrow("游标循环");
});

it("rejects oversized or malformed catalog pages and opaque cursors", async () => {
  for (const response of [
    { data: [{}], nextCursor: null },
    { data: Array.from({ length: 201 }, () => ({ id: "m", model: "m", supportedReasoningEfforts: [] })), nextCursor: null },
    { data: [], nextCursor: "x".repeat(4097) },
    { data: [{ id: "m", model: "m", supportedReasoningEfforts: Array.from({ length: 65 }, () => ({ reasoningEffort: "low" })) }], nextCursor: null },
  ]) {
    const request = vi.fn(async () => response);
    await expect(validateModelEffort({ request } as any, "thread", "chosen", "high")).rejects.toThrow(/目录/);
  }
});

it("stops model capability discovery after five distinct pages", async () => {
  let pages = 0;
  const request = vi.fn(async () => ({ data: [], nextCursor: `page-${++pages}` }));
  await expect(validateModelEffort({ request } as any, "thread", "missing", "high")).rejects.toThrow("能力未知");
  expect(pages).toBe(5);
});
