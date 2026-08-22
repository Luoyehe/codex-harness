import { useState } from "react";
import { useStore } from "../store";

export function LoginModal() {
  const [open, setOpen] = useState(false);
  const account = useStore((s) => s.account);
  const deviceLogin = useStore((s) => s.deviceLogin);
  const startDeviceLogin = useStore((s) => s.startDeviceLogin);
  const providerMode = useStore((s) => s.providerMode);

  const signedIn = !!account?.account;
  const email = account?.account?.email;
  const apiKeyMode = !!account && !account.account && !account.requiresOpenaiAuth;

  const modeLabel =
    providerMode === "zhipu"
      ? "智谱 Coding Plan"
      : providerMode === "custom"
        ? "自定义 API"
        : signedIn
          ? "ChatGPT 已登录"
          : "ChatGPT 未登录";

  return (
    <>
      <button
        className={`badge ${signedIn || apiKeyMode ? "badge-ok btn-account" : "badge-warn btn-account"}`}
        onClick={() => setOpen(true)}
        title="当前模型源 · 点击查看说明"
      >
        {modeLabel}
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>模型源</h3>
            {providerMode === "zhipu" ? (
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
                当前使用自定义模型源，通过服务器上的 <code>config.toml</code>
                API Key 鉴权，无需浏览器登录。
              </p>
            ) : signedIn ? (
              <p>
                当前使用<strong>OpenAI / ChatGPT 原生模式</strong>，已登录{email ? `：${email}` : ""}。
                如需更换账号，请在服务器上运行 <code>codex logout</code> 后重新登录。
              </p>
            ) : deviceLogin?.status === "waiting" ? (
              <div className="device-login">
                <p>在浏览器打开下面的链接，输入设备码完成 ChatGPT 登录：</p>
                {deviceLogin.verificationUrl && (
                  <p>
                    <a href={deviceLogin.verificationUrl} target="_blank" rel="noreferrer">
                      {deviceLogin.verificationUrl}
                    </a>
                  </p>
                )}
                {deviceLogin.userCode && <p className="device-code">{deviceLogin.userCode}</p>}
                <p className="dim">等待授权中…（登录完成后自动刷新）</p>
              </div>
            ) : deviceLogin?.status === "error" ? (
              <p className="error-text">登录失败：{deviceLogin.error}</p>
            ) : (
              <p>未检测到登录凭据。推荐在无头服务器上使用 ChatGPT 设备码流程登录。</p>
            )}
            {providerMode === "openai" && !signedIn && !apiKeyMode && deviceLogin?.status !== "waiting" && (
              <button className="btn-primary" onClick={() => void startDeviceLogin()}>
                使用 ChatGPT 设备码登录
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
