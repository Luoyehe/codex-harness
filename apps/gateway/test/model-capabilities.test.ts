import { expect, it, vi } from "vitest";
import { validateModelEffort } from "../src/model-capabilities.js";

it("validates the selected model, not the configured provider default", async () => {
  const request = vi.fn(async (method: string, params: any) => method === "thread/resume" ? { model: "chosen" } : ({
    data: [{ model: "default", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }, { model: "chosen", supportedReasoningEfforts: [{ reasoningEffort: "vendor-deep" }] }], nextCursor: null,
  }));
  await expect(validateModelEffort({ request } as any, "thread", undefined, "high")).rejects.toThrow("未声明支持");
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "vendor-deep")).resolves.toBeUndefined();
  await expect(validateModelEffort({ request } as any, "thread", "missing", "high")).rejects.toThrow("能力未知");
});

it("follows bounded pagination and rejects cursor loops or unknown effort capabilities", async () => {
  const request = vi.fn(async (_: string, params: any) => params.cursor ? { data: [{ model: "chosen", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] }], nextCursor: null } : { data: [], nextCursor: "next" });
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "ultra")).rejects.toThrow("未声明支持");
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "medium")).rejects.toThrow("未声明支持");
  request.mockImplementation(async () => ({ data: [], nextCursor: "loop" }));
  await expect(validateModelEffort({ request } as any, "thread", "chosen", "ultra")).rejects.toThrow("游标循环");
});
