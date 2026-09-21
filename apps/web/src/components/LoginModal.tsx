import { useState } from "react";
import { useStore } from "../store";
import { validatedHttpUrl } from "../utils/validation";

export function LoginModal() {
  const [open, setOpen] = useState(false);
  const account = useStore((s) => s.account);
  const accountLoad = useStore((s) => s.accountLoad);
  const appStatusLoad = useStore((s) => s.appStatusLoad);
  const deviceLogin = useStore((s) => s.deviceLogin);
  const startDeviceLogin = useStore((s) => s.startDeviceLogin);
  const cancelDeviceLogin = useStore((s) => s.cancelDeviceLogin);
  const refreshAccount = useStore((s) => s.refreshAccount);
  const refresh = useStore((s) => s.refresh);
  const providerMode = useStore((s) => s.providerMode);
  const connected = useStore((s) => s.connection === "open");

  const accountType = account?.account?.type;
  const chatgptSignedIn = accountType === "chatgpt";
  const email = account?.account?.type === "chatgpt" ? account.account.email : undefined;
  const apiKeyMode = accountType === "apiKey" || !!account && account.account === null && !account.requiresOpenaiAuth;
  const bedrockMode = accountType === "amazonBedrock";
  const accountReady = chatgptSignedIn || apiKeyMode || bedrockMode;
  const verificationUrl = deviceLogin?.verificationUrl
    ? validatedHttpUrl(deviceLogin.verificationUrl)
    : null;

  const modeLabel = appStatusLoad.state === "loading"
    ? "模型源读取中"
    : appStatusLoad.state === "error"
      ? "模型源状态未知"
      : providerMode === "zhipu"
      ? "智谱 Coding Plan"
      : providerMode === "custom"
        ? "自定义 API"
        : accountLoad.state === "loading"
          ? "账号状态读取中"
          : accountLoad.state === "error"
            ? "账号状态未知"
        : chatgptSignedIn
          ? "ChatGPT 已登录"
          : bedrockMode
            ? "Amazon Bedrock"
            : apiKeyMode
              ? "OpenAI API Key"
          : "ChatGPT 未登录";

  return (
    <>
      <button
        className={`badge ${appStatusLoad.state === "loaded" &&
          (providerMode !== "openai" || accountLoad.state === "loaded" && accountReady)
          ? "badge-ok btn-account" : "badge-warn btn-account"}`}
        onClick={() => setOpen(true)}
        title="当前模型源 · 点击查看说明"
      >
        {modeLabel}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>模型源</h3>
            {appStatusLoad.state === "loading" ? (
              <p className="dim">正在读取当前模型源状态…</p>
            ) : appStatusLoad.state === "error" ? (
              <div className="error-text" role="alert">
                {appStatusLoad.error ?? "模型源状态读取失败。"}{" "}
                <button className="btn" disabled={!connected} onClick={() => void refresh()}>重试</button>
              </div>
            ) : providerMode === "zhipu" ? (
              <p>
                当前使用<strong>智谱个人版 Coding Plan</strong>（GLM 系列 + 官方四个 MCP 服务器）。
                服务器上的配置集使用你的 API Key 鉴权，无需浏览器登录。
                切换模型或密钥请到「设置 → 服务器管理」。
              </p>
            ) : providerMode === "custom" ? (
              <p>
                当前使用<strong>自定义 OpenAI 兼容 API</strong>（本地 vLLM / 中转站等）。
                端点地址与密钥配置在服务器上的配置集中，无需浏览器登录。
                修改端点请到「设置 → 服务器管理」。
              </p>
            ) : apiKeyMode ? (
              <p>
                当前使用<strong>OpenAI API Key 模式</strong>，通过服务器上的 <code>config.toml</code>
                API Key 鉴权，无需浏览器登录。
              </p>
            ) : bedrockMode ? (
              <p>
                当前使用<strong>Amazon Bedrock</strong> 凭据，无需 ChatGPT 设备码登录。
              </p>
            ) : chatgptSignedIn ? (
              <p>
                当前使用<strong>OpenAI / ChatGPT 原生模式</strong>，已登录{email ? `：${email}` : ""}。
                如需更换账号，请在服务器上运行 <code>codex logout</code> 后重新登录。
              </p>
            ) : deviceLogin?.status === "waiting" ? (
              <div className="device-login">
                <p>
                  {deviceLogin.loginId
                    ? "在浏览器打开下面的链接，输入设备码完成 ChatGPT 登录："
                    : "正在请求 ChatGPT 设备码…"}
                </p>
                {verificationUrl && (
                  <p>
                    <a href={verificationUrl} target="_blank" rel="noopener noreferrer">
                      {verificationUrl}
                    </a>
                  </p>
                )}
                {deviceLogin.verificationUrl && !verificationUrl && (
                  <p className="error-text">服务器返回了不安全或无效的登录地址，已阻止打开。</p>
                )}
                {deviceLogin.userCode && <p className="device-code">{deviceLogin.userCode}</p>}
                {deviceLogin.error && <p className="error-text" role="alert">{deviceLogin.error}</p>}
                <p className="dim">等待授权中…（登录完成后自动刷新）</p>
                {deviceLogin.loginId && (
                  <button className="btn" disabled={!connected || deviceLogin.canceling} onClick={() => void cancelDeviceLogin()}>
                    {deviceLogin.canceling ? "取消中…" : "取消设备码登录"}
                  </button>
                )}
              </div>
            ) : deviceLogin?.status === "error" ? (
              <p className="error-text">登录失败：{deviceLogin.error}</p>
            ) : accountLoad.state === "loading" && !account ? (
              <p className="dim">正在读取 ChatGPT 登录状态…</p>
            ) : accountLoad.state === "error" && !account ? (
              <div className="error-text" role="alert">
                {accountLoad.error ?? "账号状态读取失败，不能判断是否已登录。"}{" "}
                <button className="btn" disabled={!connected} onClick={() => void refreshAccount()}>重试</button>
              </div>
            ) : (
              <p>未检测到登录凭据。推荐在无头服务器上使用 ChatGPT 设备码流程登录。</p>
            )}
            {appStatusLoad.state === "loaded" && providerMode === "openai" && account && accountLoad.state === "loading" && (
              <p className="dim" role="status">正在刷新账号状态；上方显示的是上次成功读取的结果。</p>
            )}
            {appStatusLoad.state === "loaded" && providerMode === "openai" && account && accountLoad.state === "error" && (
              <div className="error-text" role="alert">
                {accountLoad.error ?? "账号状态刷新失败；上方显示的是上次成功读取的结果。"}{" "}
                <button className="btn" disabled={!connected} onClick={() => void refreshAccount()}>重试</button>
              </div>
            )}
            {appStatusLoad.state === "loaded" && providerMode === "openai" && accountLoad.state === "loaded" && !accountReady && deviceLogin?.status !== "waiting" && (
              <button className="btn-primary" disabled={!connected} onClick={() => void startDeviceLogin()}>
                使用 ChatGPT 设备码登录
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
