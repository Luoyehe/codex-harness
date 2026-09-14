import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { inputForm, validateInput, type InputRequest } from "../src/utils/input-forms";
import { InputRequestCard } from "../src/components/InputRequests";
import { budgetTimeline } from "../src/utils/timeline-budget";
import { agent } from "./fixtures";

vi.mock("../src/store", () => ({ useStore: (select: (state: unknown) => unknown) => select({ connection: "open", respondInputRequest: () => true }) }));
const formRequest = (schema: unknown): InputRequest => ({ method: "mcpServer/elicitation/request", requestId: "r", params: {
  threadId: "T", turnId: "t", serverName: "test-mcp", mode: "openai/form", _meta: null, message: "Please confirm",
  requestedSchema: schema as any,
} });

describe("interactive input form contracts", () => {
  it("renders secret tool input as password and never renders the value in the timeline", () => {
    const request: InputRequest = { method: "item/tool/requestUserInput", requestId: "r", params: { threadId: "T", turnId: "t", itemId: "i", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "secret", header: "Credential", question: "Enter the test secret", isSecret: true, isOther: false, options: null }] } };
    const html = renderToStaticMarkup(<InputRequestCard request={request} />);
    expect(html).toContain('type="password"'); expect(html).toContain('autoComplete="off"'); expect(html).toContain("取消请求");
    expect(validateInput(inputForm(request), {}).error).toContain("请填写");
    expect(validateInput(inputForm(request), { secret: "example" }).content).toEqual({ secret: "example" });
  });

  it("supports typed numeric, boolean, Unicode length, and multi-select fields", () => {
    const form = inputForm(formRequest({ type: "object", properties: {
      amount: { type: "integer", minimum: 1, maximum: 9 }, enabled: { type: "boolean" },
      name: { type: "string", minLength: 2, maxLength: 3 },
      choices: { type: "array", items: { type: "string", enum: ["A", "B"] }, minItems: 1, maxItems: 2 },
    }, required: ["amount", "enabled", "name", "choices"] }));
    expect(form.error).toBeUndefined();
    expect(validateInput(form, { amount: "2", enabled: false, name: "中🙂", choices: ["A", "B"] }).content).toEqual({ amount: 2, enabled: false, name: "中🙂", choices: ["A", "B"] });
    expect(validateInput(form, { amount: "2.5" }).error).toContain("数字");
    expect(validateInput(form, { amount: "10" }).error).toContain("范围");
    expect(validateInput(form, { amount: "2", enabled: false, name: "中🙂", choices: ["A", "A"] }).error).toContain("选择无效");
  });

  it("uses titled options and rejects unsupported nested or constrained schemas visibly", () => {
    const form = inputForm(formRequest({ type: "object", properties: { select: { type: "string", oneOf: [{ const: "a", title: "Choice A" }] } }, required: ["select"] }));
    expect(form.fields[0].options).toEqual([{ value: "a", label: "Choice A" }]);
    expect(validateInput(form, { select: "wrong" }).error).toContain("提供的选项");
    for (const property of [{ type: "object", properties: {} }, { type: "string", pattern: "^(a+)+$" }]) {
      const request = formRequest({ type: "object", properties: { unsupported: property } });
      expect(inputForm(request).error).toBeTruthy();
      const html = renderToStaticMarkup(<InputRequestCard request={request} />);
      expect(html).toContain("未自动批准或取消"); expect(html).toContain("取消请求");
    }
  });

  it("opens URL elicitation only through a user-selected safe external link", () => {
    const request: InputRequest = { method: "mcpServer/elicitation/request", requestId: "url", params: { threadId: "T", turnId: null, serverName: "test", mode: "url", _meta: null, message: "Sign in", url: "https://example.com/login", elicitationId: "login" } };
    const html = renderToStaticMarkup(<InputRequestCard request={request} />);
    expect(html).toContain("noopener"); expect(html).toContain("确认完成");
    const invalid = { ...request, params: { ...request.params, url: "javascript:alert(1)" } } as InputRequest;
    expect(inputForm(invalid).error).toBeTruthy();
  });
});

describe("browser history memory budget", () => {
  it("evicts inactive caches rather than growing unbounded as projects accumulate", () => {
    const source = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`T${index}`, [agent(`item${index}`, "x")]]));
    const result = budgetTimeline(source, "T0");
    expect(Object.keys(result.items)).toHaveLength(8); expect(result.items.T0).toBe(source.T0); expect(result.evicted).toHaveLength(92);
  });
  it("reports an explicit display limit instead of silently keeping an oversized history", () => {
    const result = budgetTimeline({ T: Array.from({ length: 10_001 }, (_, index) => agent(`${index}`, "x")) }, "T");
    expect(result.overflow).toEqual(["T"]); expect(result.items.T).toHaveLength(1);
    expect(result.items.T[0]).toMatchObject({ type: "errorItem", historyLoadError: true });
    expect((result.items.T[0] as { message: string }).message).toContain("服务器历史没有删除");
  });
});
