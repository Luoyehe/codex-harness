# OpenAI（ChatGPT 账号）供应商预设

这是 codex 的原生形态：不需要供应商覆盖配置，登录即可用。Harness 以空的受管理 `config.toml` 表示原生默认值。

## 一键切换到本模式

```bash
sudo codex-harness provider openai
```

管理命令会从 systemd unit 读取服务用户及 `CODEX_HOME`，以该用户执行配置并重启服务，避免 root 误写 `/root/.codex`。切换通过供应商事务发布空配置，保留公共软链。其它模式的配置集与密钥均保留；私有旧代也可能含旧凭据，彻底清理前需同时核实活动代和历史快照，不能仅删除某个模式的公共链接。安装器选择 `PROVIDER=openai` 时会自动执行。

## 登录（无头服务器友好）

**推荐直接在 WebUI 登录，不需要停止服务或手工复制凭据：**

1. 先在 ChatGPT 的「设置 → 安全」中启用 Codex 设备代码授权；受管理工作空间可能需要管理员在工作空间权限中开启。见 [OpenAI 官方设备码登录说明](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta)。
2. 在 Harness 右上角点击「登录」，获取登录链接与一次性代码。
3. 在自己的浏览器中打开链接，登录 ChatGPT 并输入代码，等待 Harness 显示登录成功。

如果先前因未开启授权而失败，开启设置后重新发起登录，使用新生成的代码。不要把一次性代码或 `auth.json` 发给别人。

只有需要命令行排障时才用下面的流程。停止网关会中断正在运行的任务，请先确认可以暂停：

```bash
sudo systemctl stop codex-harness   # 网关持有 codex 子进程时先停
# 使用 unit 中固定的版本化 CLI 路径；以下为当前默认版本：
CODEX_CLI=/usr/local/lib/codex-harness/codex/0.149.0/node_modules/.bin/codex
sudo -u codex-harness env HOME=/var/lib/codex-harness \
  CODEX_HOME=/var/lib/codex-harness/.codex "$CODEX_CLI" login --device-auth
sudo systemctl start codex-harness
```

上面是默认实例的账号与路径；自定义过服务名、`RUN_USER`、`CODEX_HOME` 或运行时路径时须替换为 `systemctl cat <服务名>` 中的实际值，不能直接以 root 运行 `codex login`。登录失败或取消后，也要执行最后的启动命令恢复服务。

## 可选覆盖

日常切换模型用输入框下方的模型菜单即可。只有需要修改原生默认配置时，才由熟悉 Codex 配置的管理员在停服、备份后编辑服务用户的 `<CODEX_HOME>/config.toml`；例如固定为账号实际可用的模型（替换下面的占位 ID）：

```toml
model = "your-model-id"
```

**不要**设置 `model_provider` / `model_providers.*` / `model_catalog_json`——这些键由第三方供应商预设管理；误配置后重新运行 `sudo codex-harness provider openai` 会恢复空的原生配置，也会清除这里的手工覆盖。手工编辑必须保留公共软链，并保持目标文件归服务用户所有；完成后重启服务。通常不需要做这些高级修改。

## 注意

- ChatGPT 账号登录有地区限制，服务器需在可访问 OpenAI 的网络内
- MCP 服务器配置（若需要）与供应商无关，参照主 README；`[features]` 开关只在智谱四件套场景必需
