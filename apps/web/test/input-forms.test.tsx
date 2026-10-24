import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { inputForm, validateInput, type InputRequest } from "../src/utils/input-forms";
import { InputRequestCard } from "../src/components/InputRequests";
import { budgetTimeline } from "../src/utils/timeline-budget";
import { agent } from "./fixtures";

const ui = vi.hoisted(() => ({ connection: "open", respondInputRequest: vi.fn(() => true), inputRequestErrors: {} as Record<string, string> }));
vi.mock("../src/store", () => ({ useStore: (select: (state: typeof ui) => unknown) => select(ui) }));
const formRequest = (schema: unknown): InputRequest => ({ method: "mcpServer/elicitation/request", requestId: "r", params: {
  threadId: "T", turnId: "t", serverName: "test-mcp", mode: "openai/form", _meta: null, message: "Please confirm",
  requestedSchema: schema as any,
} });

function chooseOption(renderer: ReactTestRenderer, label: string) {
  const picker = renderer.root.findByType("select");
  const option = picker.findAllByType("option").find((entry) => entry.props.children === label)!;
  act(() => picker.props.onChange({ target: { value: option.props.value } }));
}

function clickButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType("button").find((entry) => entry.props.children === label)!;
  expect(button.props.disabled).toBeFalsy();
  act(() => button.props.onClick());
}

function submit(renderer: ReactTestRenderer) {
  act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

describe("interactive input form contracts", () => {
  it("renders secret tool input as password and never renders the value in the timeline", () => {
    const request: InputRequest = { method: "item/tool/requestUserInput", requestId: "r", params: { threadId: "T", turnId: "t", itemId: "i", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "secret", header: "Credential", question: "Enter the test secret", isSecret: true, isOther: false, options: null }] } };
    const html = renderToStaticMarkup(<InputRequestCard request={request} />);
    expect(html).toContain('type="password"'); expect(html).toContain('autoComplete="off"'); expect(html).toContain("取消请求");
    expect(validateInput(inputForm(request), {}).error).toContain("请填写");
    expect(validateInput(inputForm(request), { secret: "example" }).content).toEqual({ secret: "example" });
  });

  it("lets a secret single-choice question use its advertised options", () => {
    const request: InputRequest = { method: "item/tool/requestUserInput", requestId: "secret-choice", params: {
      threadId: "T", turnId: "t", itemId: "i", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "secret", header: "Credential", question: "Choose one", isSecret: true, isOther: false,
        options: [{ label: "test-token-a", description: "Test credential A" }, { label: "test-token-b", description: "Test credential B" }] }],
    } };
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    const picker = renderer.root.findByProps({ className: "secret-value-picker" });
    expect(picker.findAllByType("option").map((option) => option.props.children)).toContain("test-token-a — Test credential A");
    chooseOption(renderer, "test-token-a — Test credential A");
    expect(renderer.root.findByProps({ className: "secret-value-status" }).findByType("span").props.children).toContain("已选择");
    act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("secret-choice", {
      answers: { secret: { answers: ["test-token-a"] } },
    });
    renderer.unmount();
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

  it("supports a write-only enum array without exposing a default or coercing it to a password string", () => {
    const request = formRequest({ type: "object", properties: {
      secrets: { type: "array", writeOnly: true, default: ["alpha"], items: { type: "string", enum: ["alpha", "beta"] }, minItems: 1, maxItems: 2 },
    }, required: ["secrets"] });
    const form = inputForm(request);
    expect(form.fields[0]).toMatchObject({ type: "array", secret: true, defaultValue: undefined });
    expect(validateInput(form, { secrets: ["alpha", "beta"] }).content).toEqual({ secrets: ["alpha", "beta"] });

    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    expect(renderer.root.findByProps({ className: "secret-array-status" }).findByType("span").props.children.join(""))
      .toContain("已选择 0 项");
    chooseOption(renderer, "alpha");
    chooseOption(renderer, "beta");
    expect(renderer.root.findByProps({ className: "secret-array-status" }).findByType("span").props.children.join(""))
      .toContain("已选择 2 项");
    act(() => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", {
      action: "accept", content: { secrets: ["alpha", "beta"] }, _meta: null,
    });
    renderer.unmount();
  });

  it.each(["请选择", "不提交此字段"])("omits a defaulted optional enum using %s", (action) => {
    const request = formRequest({ type: "object", properties: { color: { type: "string", enum: ["red", "blue"], default: "red" } } });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    if (action === "请选择") chooseOption(renderer, action);
    else clickButton(renderer, action);
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: {}, _meta: null });
    renderer.unmount();
  });

  it.each([[false, "Empty value", ""], [true, "Empty value", ""], [false, "Zero", "0"], [true, "Zero", "0"]] as const)("decodes enum choices independently of DOM ids (secret=%s, label=%s)", (secret, label, answer) => {
    const request = formRequest({ type: "object", properties: {
      choice: { type: "string", oneOf: [{ const: "", title: "Empty value" }, { const: "0", title: "Zero" }], writeOnly: secret },
    }, required: ["choice"] });
    expect(validateInput(inputForm(request), { choice: "" }).error).toBeUndefined();
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    const picker = renderer.root.findByType("select");
    const ids = picker.findAllByType("option").map((option) => option.props.value);
    expect(new Set(ids).size).toBe(ids.length);
    chooseOption(renderer, label);
    if (secret) {
      expect(picker.props.value).toBe("");
      expect(renderer.root.findByProps({ className: "secret-value-status" }).findByType("span").props.children).toContain("已选择 1 项");
    }
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: { choice: answer }, _meta: null });
    expect(renderer.root.findAllByType("select")).toHaveLength(0);
    renderer.unmount();
  });

  it("accepts a legitimate empty-string item in a secret array without displaying the selection", () => {
    const request = formRequest({ type: "object", properties: {
      choices: { type: "array", items: { anyOf: [{ const: "", title: "Empty value" }] }, writeOnly: true, minItems: 1 },
    }, required: ["choices"] });
    expect(validateInput(inputForm(request), { choices: [""] }).error).toBeUndefined();
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    chooseOption(renderer, "Empty value");
    expect(renderer.root.findByType("select").props.value).toBe("");
    expect(renderer.root.findByProps({ className: "secret-array-status" }).findByType("span").props.children.join("")).toContain("已选择 1 项");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: { choices: [""] }, _meta: null });
    renderer.unmount();
  });

  it("allows an optional constrained array to be omitted without treating an empty selection as omission", () => {
    const request = formRequest({ type: "object", properties: {
      choices: { type: "array", items: { type: "string", enum: ["red", "blue"] }, minItems: 1, default: ["red"] },
    } });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    act(() => renderer.root.findByType("select").props.onChange({ target: { selectedOptions: [] } }));
    submit(renderer);
    expect(ui.respondInputRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("不符合允许的范围");
    clickButton(renderer, "不提交此字段");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: {}, _meta: null });
    renderer.unmount();
  });

  it.each([false, true])("submits an explicit empty array after clearing the final choice (secret=%s)", (secret) => {
    const request = formRequest({ type: "object", properties: {
      choices: { type: "array", items: { type: "string", enum: ["red"] }, writeOnly: secret, minItems: 0 },
    }, required: ["choices"] });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    if (secret) chooseOption(renderer, "red");
    else {
      const picker = renderer.root.findByType("select");
      act(() => picker.props.onChange({ target: { selectedOptions: [{ value: picker.findByType("option").props.value }] } }));
    }
    clickButton(renderer, secret ? "清空" : "清空选择");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: { choices: [] }, _meta: null });
    renderer.unmount();
  });

  it.each([false, true])("allows an optional array to explicitly submit no items (secret=%s)", (secret) => {
    const request = formRequest({ type: "object", properties: {
      choices: { type: "array", items: { type: "string", enum: ["red"] }, writeOnly: secret },
    } });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    clickButton(renderer, secret ? "清空" : "清空选择");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: { choices: [] }, _meta: null });
    renderer.unmount();
  });

  it("validates required array minimums before accepting an empty selection", () => {
    const request = formRequest({ type: "object", properties: {
      choices: { type: "array", items: { type: "string", enum: ["red"] }, writeOnly: true, minItems: 1 },
    }, required: ["choices"] });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    submit(renderer);
    expect(ui.respondInputRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("不符合允许的范围");
    chooseOption(renderer, "red");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledWith("r", { action: "accept", content: { choices: ["red"] }, _meta: null });
    renderer.unmount();
  });

  it.each([false, true])("accepts required empty text when the schema permits it (secret=%s)", (secret) => {
    const request = formRequest({ type: "object", properties: { answer: { type: "string", writeOnly: secret } }, required: ["answer"] });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    expect(renderer.root.findByType("input").props.type).toBe(secret ? "password" : "text");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: { answer: "" }, _meta: null });
    renderer.unmount();
  });

  it.each([false, true])("distinguishes explicit empty optional text from omission (omit=%s)", (omit) => {
    const request = formRequest({ type: "object", properties: { answer: { type: "string", writeOnly: true } } });
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    act(() => renderer.root.findByType("input").props.onChange({ target: { value: "secret" } }));
    act(() => renderer.root.findByType("input").props.onChange({ target: { value: "" } }));
    if (omit) clickButton(renderer, "不提交此字段");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("r", { action: "accept", content: omit ? {} : { answer: "" }, _meta: null });
    renderer.unmount();
  });

  it.each([[false, false], [false, true], [true, true]])("sends tool option labels rather than their DOM ids (secret=%s, other=%s)", (secret, other) => {
    const request: InputRequest = { method: "item/tool/requestUserInput", requestId: "tool-choice", params: {
      threadId: "T", turnId: "t", itemId: "i", isBlocking: true, autoResolutionMs: null,
      questions: [{ id: "choice", header: "Choice", question: "Choose", isSecret: secret, isOther: other,
        options: [{ label: "Alpha", description: "First option" }, { label: "Beta", description: "Second option" }] }],
    } };
    ui.respondInputRequest.mockClear();
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={request} />); });
    chooseOption(renderer, "Beta — Second option");
    submit(renderer);
    expect(ui.respondInputRequest).toHaveBeenCalledExactlyOnceWith("tool-choice", { answers: { choice: { answers: ["Beta"] } } });
    renderer.unmount();
  });

  it("clears an in-progress answer when the server replaces the same request id with a different form", () => {
    const first = formRequest({ type: "object", properties: { answer: { type: "string", title: "First question" } }, required: ["answer"] });
    const replacement = formRequest({ type: "object", properties: { answer: { type: "string", title: "Replacement question" } }, required: ["answer"] });
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(<InputRequestCard request={first} />); });
    act(() => renderer.root.findByType("input").props.onChange({ target: { value: "answer for the first form" } }));
    expect(renderer.root.findByType("input").props.value).toBe("answer for the first form");
    act(() => renderer.update(<InputRequestCard request={replacement} />));
    expect(renderer.root.findByType("input").props.value).toBe("");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("answer for the first form");
    renderer.unmount();
  });

  it("rejects an oversized interactive request before constructing thousands of controls", () => {
    const request = formRequest({ type: "object", properties: { answer: { type: "string", description: "x".repeat(300_000) } } });
    expect(inputForm(request).error).toContain("大小限制");
    expect(renderToStaticMarkup(<InputRequestCard request={request} />)).toContain("无法安全呈现");
  });

  it("keeps a malformed runtime request cancellable instead of crashing the input dock", () => {
    const malformed = { method: "mcpServer/elicitation/request", requestId: "malformed", params: null } as unknown as InputRequest;
    const html = renderToStaticMarkup(<InputRequestCard request={malformed} />);
    expect(html).toContain("无法安全呈现");
    expect(html).toContain("取消请求");
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
