import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import type { GetAccountResponse } from "../../../protocol/v2/GetAccountResponse";

const model = vi.hoisted(() => ({
  account: null as GetAccountResponse | null,
  accountLoad: { state: "loaded" as "loading" | "loaded" | "error", error: null as string | null },
  appStatusLoad: { state: "loaded" as "loading" | "loaded" | "error", error: null as string | null },
  deviceLogin: {
    status: "waiting" as const,
    loginId: "login-current",
    verificationUrl: "https://auth.example.test/device",
    userCode: "ABCD-EFGH",
    canceling: false,
    error: "取消结果待确认",
  } as { status: "waiting"; loginId: string; verificationUrl: string; userCode: string; canceling: boolean; error: string } | null,
  providerMode: "openai" as const,
  connection: "open" as const,
  startDeviceLogin: vi.fn(),
  cancelDeviceLogin: vi.fn(),
  refreshAccount: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../src/store", () => ({ useStore: (selector: (state: typeof model) => unknown) => selector(model) }));

import { LoginModal } from "../src/components/LoginModal";

afterEach(() => {
  model.cancelDeviceLogin.mockReset(); model.startDeviceLogin.mockReset(); model.refreshAccount.mockReset(); model.refresh.mockReset();
  model.accountLoad = { state: "loaded", error: null };
  model.appStatusLoad = { state: "loaded", error: null };
  model.account = null;
});

it("shows the matching device login cancellation and its last error", () => {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LoginModal />); });
  act(() => renderer.root.findByProps({ title: "当前模型源 · 点击查看说明" }).props.onClick());
  expect(renderer.root.findAllByType("a")[0].props.href).toBe("https://auth.example.test/device");
  expect(renderer.root.findAll((node) => node.props.role === "alert")[0].props.children).toContain("取消结果待确认");
  const cancel = renderer.root.findAllByType("button").find((node) => node.props.children === "取消设备码登录")!;
  act(() => cancel.props.onClick());
  expect(model.cancelDeviceLogin).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
});

it("does not call an account-read failure logged-out and offers a bounded explicit retry", () => {
  const login = model.deviceLogin;
  model.deviceLogin = null;
  model.accountLoad = { state: "error", error: "账号读取暂时失败" };
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LoginModal />); });
  act(() => renderer.root.findByProps({ title: "当前模型源 · 点击查看说明" }).props.onClick());
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain("账号读取暂时失败");
  expect(rendered).not.toContain("未检测到登录凭据");
  expect(renderer.root.findAllByType("button").some((button) => button.props.children === "使用 ChatGPT 设备码登录")).toBe(false);
  const retry = renderer.root.findAllByType("button").find((button) => button.props.children === "重试")!;
  act(() => retry.props.onClick());
  expect(model.refreshAccount).toHaveBeenCalledOnce();
  act(() => renderer.unmount());
  model.deviceLogin = login;
});

it.each([
  [{ account: { type: "apiKey" as const }, requiresOpenaiAuth: true }, "OpenAI API Key", "API Key 模式"],
  [{ account: { type: "amazonBedrock" as const, usesCodexManagedCredentials: false }, requiresOpenaiAuth: false }, "Amazon Bedrock", "Amazon Bedrock"],
] as const)("classifies non-ChatGPT account union branches without claiming a ChatGPT login", (account, badge, detail) => {
  model.account = account;
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<LoginModal />); });
  const trigger = renderer.root.findByProps({ title: "当前模型源 · 点击查看说明" });
  expect(trigger.props.children).toBe(badge);
  act(() => trigger.props.onClick());
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain(detail);
  expect(rendered).not.toContain("OpenAI / ChatGPT 原生模式");
  expect(renderer.root.findAllByType("button").some((button) => button.props.children === "使用 ChatGPT 设备码登录")).toBe(false);
  act(() => renderer.unmount());
});
