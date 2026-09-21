# 智谱个人版 Coding Plan 供应商预设

用智谱 [Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/tool/codex) 的 GLM 系列（glm-5.3 / glm-5-turbo）驱动 Codex，Responses API 直连，不需要 ChatGPT 账号，也不需要代理。

## 一、模型源

```bash
sudo codex-harness provider zhipu
```

管理命令会隐藏输入 Key，原子写入服务用户的 `<CODEX_HOME>/secrets.env`，再以 systemd 服务用户及其真实 `HOME` / `CODEX_HOME` 完成配置并重启；Key 不会出现在 shell 历史或命令参数中。已有配置集时 `setup.sh` 会强制重写模型源键（支持切换模型/供应商），其余用户自定义键保留。手动配置参见 `config.toml.example`。

在线模型目录会自动拉取，但默认不发送会产生模型用量的思考档位探测。只有明确接受真实 API 请求及可能费用时，才使用 `sudo PROBE_REASONING=1 codex-harness provider zhipu` 开启探测。

## 二、内置的兼容性修复（为什么需要这些脚本）

这一节记录本项目在真实环境中踩过并修复的坑，供升级 codex / 智谱端点变化时排查：

| 问题 | 修复 |
|---|---|
| codex 0.149 新 MCP 栈默认未启用，MCP 工具不注入 | `[features] mcp_2026_07_28 = true` |
| 会话审批策略为 `never` 时，codex 客户端会拒绝未经预批的 MCP 调用 | 只给本预设的四个固定内置服务器写 `default_tools_approval_mode = "approve"`；上游仍发出的审批表单交由浏览器确认，网关不会仅凭同名标识自动批准 |
| 项目配置或已加载的同名 MCP 可能与全局预设不同 | 动态桥接调用通过原生 `mcpServer/tool/call` 使用该会话已加载的连接，不另取全局 Key 或改投固定 HTTP 端点；失败不自动重试 |
| codex 以最小环境变量 spawn stdio MCP 子进程 | 配置通过 `env_vars = ["Z_AI_API_KEY"]` 从 600 权限的服务 EnvironmentFile 继承；Key 不写入 TOML、桥接器参数或诊断日志 |
| 官方 `mcp-remote` 桥在 tools/call 上挂死（openai/codex#14793 的一环） | 自研 `mcp-http-bridge.mjs`（stdio ↔ streamable-http） |
| 智谱端点在 initialize 应答里下发 `Mcp-Session-Id`，tools/call 必须回放该头，否则 401 | 桥内维护会话头状态 |
| 智谱 HTTP MCP 启动慢 | `startup_timeout_sec = 120` |

已知第三方限制：`upload.wikimedia.org` 的图片 URL 会被智谱视觉 API 以 400/1210 拒绝——Wikimedia 对无/通用 User-Agent 的服务端拉图回 403，属智谱后端与 Wikimedia 之间的问题；换任何智谱可拉取的图片 URL 即正常。

## 三、验证

```bash
# 默认日常验证：隔离启动真实 gateway + app-server，不读取现有 CODEX_HOME，
# 不启动 turn，也不会产生模型 API 费用
pnpm test:smoke

# 只看服务器与工具清单（不发模型 turn）
node deploy/list-mcp-tools.mjs

# 显式线上验收：四个服务器会执行搜索、读网页/仓库、图像理解等真实任务；
# 会启动模型 turn、消耗额度并可能计费
HARNESS_ALLOW_PAID_TESTS=1 node deploy/verify-mcp-tools.mjs
```

文件清单：

- `config.toml.example` — 模型源 + feature 开关模板
- `models.json` — GLM 模型目录（context window 等元数据）
- `setup.sh` — 一键装配（幂等，可重复运行）
- `setup-http-mcp.sh` / `setup-zai-mcp.sh` — 四个固定内置 MCP 的分步装配（`setup.sh` 内部调用）
- `mcp-http-bridge.mjs` — stdio ↔ 智谱 streamable-http 桥
