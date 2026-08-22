# Codex Harness WebUI

自托管的 [OpenAI Codex](https://github.com/openai/codex) Web 界面：用官方开源的 `codex app-server` 协议（JSON-RPC 2.0 over stdio）驱动完整的 Agent 能力——多项目、多会话、审批、diff、网页终端。浏览器远程访问由 Caddy (TLS) + Authelia (登录鉴权) 负责。

模型源开箱支持三种：**原生 OpenAI**（ChatGPT 账号，设备码登录）、**智谱个人版 Coding Plan**（GLM 系列 + 官方四个 MCP 服务器，含全套兼容性修复）与**自定义 OpenAI 兼容 API**（本地 vLLM/中转站等），见 [`deploy/providers/`](deploy/README.md)。

```
浏览器 ──HTTPS/WSS──> Caddy ──forward_auth──> Authelia
                        │ 鉴权通过后反代
                        ▼
          Gateway（本仓库，systemd 服务，仅监听 127.0.0.1，token 认证 + Host 白名单）
                        │ stdio JSONL
                        ▼
                codex app-server 子进程
                        └─ ~/.codex 持久化，agent 在浏览器断开后继续运行
```

## 功能

- **多项目管理**：项目注册表（服务器侧持久化），手输绝对路径或**可视化目录浏览**添加项目；按最近使用排序、一键切换工作目录；新会话自动以当前项目为 cwd，会话列表按项目过滤
- **多会话管理**：新建 / 恢复 / 重命名 / 归档 / 删除；**服务端搜索（标题）**、**分页加载**（"加载更早"）与**当前/归档双标签**，归档会话可一键恢复；**进入页面自动恢复最近一次活跃对话**；URL `?threadId=` 同步，断线重连后状态自动恢复
- **完整时间线（全流式）**：回复流式 + **思考摘要**（原始思考内容折叠可查）；命令执行实时输出（运行中徽标 → exit 码）；MCP 工具调用（参数/结果）、文件修改（diff）、执行计划（**常驻顶部卡片**，不随输出滚走）、web 搜索
- **长对话性能**：流式增量批量渲染 + 条目记忆化 + 窗口化显示（默认渲染最近 150 条，可向上加载），万条消息不卡顿
- **滚动自由**：粘底跟随输出，向上滚动即停跟随（不会被拉回底部）
- **显示开关（服务器端持久化）**：设置里按类别开关 思考/命令/文件修改/MCP 调用/搜索 的显示，所有浏览器同步生效，仅影响显示不影响执行
- **即时覆盖选择器**：输入框下方 模型 / 审批策略 / **沙箱模式**（默认 · 允许网络 · 完全访问）/ 思考档位，对下一条消息即时生效
- **审批交互**：命令执行、文件修改与**权限提升**三类审批的 批准 / 本次会话一律批准 / 拒绝；多标签页下首个响应生效；无浏览器在线时自动拒绝（安全默认）
- **上下文管理**：实时 token 用量 / 模型窗口占比，一键「压缩」总结历史释放空间，可配置自动压缩阈值（仅在任务间隙触发）
- **Diff 查看**：turn 级聚合 diff + fileChange 条目按文件分组
- **网页终端**：xterm.js + PTY，多终端标签（各自独立容器，切换不丢内容）；关闭底部面板即结束所有终端；app-server 重启时统一标记退出
- **服务器管理（WebUI 设置内一步完成）**：切换模型源（OpenAI / 智谱 / 自定义 API，自动重启生效）、**一键从上游同步模型目录与思考档位**、远程访问（Caddy+Authelia）配置、服务重启与日志查看
- **设置**：主题（浅色/深色/跟随系统）、Enter 键行为；移动端响应式（选择器左对齐、操作组右对齐的双行底栏）
- **账号自适应**：智谱/自定义 API 模式徽标按实际模型源显示；ChatGPT 模式提供设备码登录（无头服务器友好）

## 快速开始（部署）

一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/Luoyehe/codex-harness/main/deploy/install.sh | bash
```

脚本会自动克隆仓库、装 Node22、构建并以 systemd 服务启动，然后交互式引导你完成两项选择：模型源（智谱 Coding Plan 粘贴 Key 即完成 / OpenAI 设备码登录）与远程访问方式（仅本机/SSH 隧道，或 Caddy+Authelia HTTPS+登录鉴权——证书可选自签或自有证书目录）。装完浏览器打开 `http://127.0.0.1:8080` 就能用。

传统方式（git clone 后运行，效果相同）：

```bash
git clone https://github.com/Luoyehe/codex-harness && cd codex-harness
./deploy/install.sh
# 无人值守：PROVIDER=zhipu ZHIPU_KEY=xxx ./deploy/install.sh
```

安装后的**一切维护统一走 `bash deploy/manage.sh`**：交互式菜单覆盖切换模型源（两套方案普适部署、排他激活、随时切换）、远程访问、服务管理、验证、重装（修复/完全重置）、检查更新（即将上线），也支持子命令直达（`manage.sh provider zhipu` 等）。

远程访问（TLS + 登录鉴权）、运维与验证详见 [`deploy/README.md`](deploy/README.md)。

## 开发

```bash
npm install -g pnpm @openai/codex   # codex CLI 0.149.x
pnpm install
pnpm dev        # 同时起 gateway(8410) 与 web(5173)
```

打开 http://127.0.0.1:5173 （Vite dev server 代理 /ws 到网关）。代理层会自动完成认证对接：Host 改写为网关自己的受信地址、剥掉浏览器 Origin，并从 `~/.codex/gateway-token`（或 `CODEX_HOME` 下）读取 token 注入为 cookie——网关侧无需任何放宽。若网关刚首次启动生成了新 token，刷新一次页面即可。

### 开发期使用智谱模型源（推荐）

为避免污染你本机 `~/.codex` 里已有的 ChatGPT 配置，用项目内沙箱目录：

```bash
# 首次：复制模板并填入你的智谱 Coding Plan API Key（dev-codex-home/ 已 gitignore）
copy deploy\providers\zhipu-coding-plan\models.json dev-codex-home\     # macOS/Linux 用 cp
copy deploy\providers\zhipu-coding-plan\config.toml.example dev-codex-home\config.toml
# dev-codex-home/config.toml 里把 <你的智谱 Coding Plan API Key> 换成真实 Key

# 带 CODEX_HOME 启动开发环境（Windows cmd；PowerShell 用 $env:CODEX_HOME=...）
set CODEX_HOME=%cd%\dev-codex-home&& pnpm dev
```

```bash
pnpm test            # 网关单测（RPC 编解码 / hub 路由）
pnpm typecheck
pnpm --filter @codex-harness/gateway exec tsx scripts/smoke.ts  # 直连 app-server 冒烟
pnpm --filter @codex-harness/gateway exec tsx scripts/e2e.ts    # 起网关+WS 全链路
pnpm build           # 生产构建（web 产物由网关托管）
```

### 环境变量（网关）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址（保持回环，由反向代理对外） |
| `PORT` | `8410` | 监听端口 |
| `CODEX_BIN` | `codex` | codex 可执行文件路径 |
| `CODEX_HOME` | 继承 | codex 配置/凭据目录 |
| `CODEX_WORKSPACE` | 进程 cwd | 新会话的默认工作目录 |

## 协议类型

`protocol/` 由 `codex app-server generate-ts --out protocol` 生成（当前对应 codex **0.149.0**），随仓库提交。升级 codex 版本后重新生成并跑冒烟：

```bash
codex app-server generate-ts --out protocol
pnpm --filter @codex-harness/gateway exec tsx scripts/smoke.ts
```

## 浏览器 ↔ 网关 协议

WebSocket `/ws`，三种消息：

- `{kind:"rpc", id, method, params}` → `{kind:"rpcResult", id, result|error}` —— 白名单方法（`thread/*`、`turn/*`、`terminal/*`、`projects/*`、`displayPrefs/*`、`attachment/*`、`account/read`、`account/login/start`、`fs/readDirectory`、`model/list`、`admin/*`…）
- `{kind:"notification", method, params}` —— app-server 通知原样扇出 + 网关合成事件（`appServer/stateChanged`、`terminal/exited`）
- `{kind:"serverRequest", requestId, method, params}` ← `{kind:"serverRequestResponse", requestId, payload}` —— 审批等服务端反向请求，首个浏览器响应生效

## 安全边界

> **单管理员设计**：Gateway 不区分浏览器用户身份——所有经 Authelia 登录的会话共享同一 Codex 账号、项目与终端。这适合个人/单管理员自托管；**不要当多用户团队产品使用**（一个登录者可以看到其它人的会话输出、回答其审批请求）。

- 网关使用 token 认证（`~/.codex/gateway-token`，600 权限）+ Host 白名单（防 DNS rebinding）；仅监听 loopback；远程访问必须经 TLS 反代 + forward-auth
- **页面能打开但提示「gateway 未连接」**：说明反代域名不在网关信任列表——`deploy/setup-edge.sh` 会自动把对外地址写入 `/etc/codex-harness.env` 的 `TRUSTED_HOSTS`（443 端口写裸域名，其余写 `域名:端口`）并设 `GATEWAY_HTTPS=true`；手动修改域名/端口后需同步更新该文件并 `systemctl restart codex-harness`
- 终端/命令以服务用户权限运行（等同 SSH 进服务器），用 systemd 服务用户与工作目录控制可触达范围
- 浏览器侧只暴露白名单 RPC，`process/spawn`、`execServer/*`、`fs/*` 高危写接口不对浏览器开放；沙箱预设由网关白名单映射，浏览器无法注入任意沙箱策略

## License

MIT —— 见 [LICENSE](LICENSE)。
