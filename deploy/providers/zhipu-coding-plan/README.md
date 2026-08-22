# 智谱个人版 Coding Plan 供应商预设

用智谱 [Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/tool/codex) 的 GLM 系列（glm-5.3 / glm-5-turbo）驱动 Codex，Responses API 直连，不需要 ChatGPT 账号，也不需要代理。

## 一、模型源

```bash
# 先把 Key 放进服务环境文件（install.sh 已创建该文件）
sudo tee /etc/codex-harness.env >/dev/null <<'EOF'
Z_AI_API_KEY=你的CodingPlanKey
EOF
sudo chmod 600 /etc/codex-harness.env

# 一键完成：config.toml + models.json + feature 开关 + 四个 MCP 服务器
bash deploy/providers/zhipu-coding-plan/setup.sh
# 交互引导：自动拉取 Coding Plan 在线模型目录并选择模型 → 探测该模型思考档位
sudo systemctl restart codex-harness
```

已有配置集时 `setup.sh` 会强制重写模型源键（支持切换模型/供应商），其余用户自定义键保留。手动配置参见 `config.toml.example`；装有 coding-helper（chelper）的机器也可以用 `chelper auth reload codex` 写入模型源，再单独跑 `setup.sh`（它会跳过已存在的部分）。

## 二、内置的兼容性修复（为什么需要这些脚本）

这一节记录本项目在真实环境中踩过并修复的坑，供升级 codex / 智谱端点变化时排查：

| 问题 | 修复 |
|---|---|
| codex 0.149 新 MCP 栈默认未启用，MCP 工具不注入 | `[features] mcp_2026_07_28 = true` |
| 会话审批策略为 `never` 时，codex 客户端直接拒绝 MCP 调用（"MCP tool call requires approval"） | 每个 MCP 服务器块加 `default_tools_approval_mode = "approve"` |
| codex 以最小环境变量 spawn stdio MCP 子进程，`Z_AI_API_KEY` 传不进桥 | token 明文写进 `args`（配置文件本身 600 权限） |
| 官方 `mcp-remote` 桥在 tools/call 上挂死（openai/codex#14793 的一环） | 自研 `mcp-http-bridge.mjs`（stdio ↔ streamable-http） |
| 智谱端点在 initialize 应答里下发 `Mcp-Session-Id`，tools/call 必须回放该头，否则 401 | 桥内维护会话头状态 |
| 智谱 HTTP MCP 启动慢 | `startup_timeout_sec = 120` |
| 网关侧：新栈对每次 MCP 调用发 elicitation 批准门，无人应答则挂起 | 网关自动 accept（`apps/gateway/src/index.ts`） |

已知第三方限制：`upload.wikimedia.org` 的图片 URL 会被智谱视觉 API 以 400/1210 拒绝——Wikimedia 对无/通用 User-Agent 的服务端拉图回 403，属智谱后端与 Wikimedia 之间的问题；换任何智谱可拉取的图片 URL 即正常。

## 三、验证

```bash
# 四个服务器的真实任务验收（搜索/读网页/读仓库/图像理解），默认在
# approvalPolicy=never 下跑（覆盖审批白名单路径）
node deploy/verify-mcp-tools.mjs

# 只看服务器与工具清单
node deploy/list-mcp-tools.mjs

# 复现/验证 never 策略下 MCP 审批行为
node deploy/verify-mcp-approval.mjs never
```

文件清单：

- `config.toml.example` — 模型源 + feature 开关模板
- `models.json` — GLM 模型目录（context window 等元数据）
- `setup.sh` — 一键装配（幂等，可重复运行）
- `setup-http-mcp.sh` / `setup-zai-mcp.sh` / `fix-mcp-approval.sh` — 分步装配（setup.sh 内部调用）
- `mcp-http-bridge.mjs` — stdio ↔ 智谱 streamable-http 桥
