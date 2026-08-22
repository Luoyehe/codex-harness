# 部署指南

**裸跑（systemd）是唯一支持的部署方式**——无容器路径映射问题、codex 原生沙箱（Landlock/bwrap）全功能、升级即 `git pull`。

## 〇、统一管理入口（推荐）

安装后的一切部署与维护都走一个脚本：

```bash
bash deploy/manage.sh            # 交互式菜单
bash deploy/manage.sh status     # 子命令直达：provider|edge|restart|logs|
                                 #   verify|reinstall|update
```

菜单覆盖：安装向导、切换模型源（排他激活）、远程访问、服务管理、验证、重装（修复/完全重置）、检查更新（即将上线）。

## 一、安装（一条命令）

仓库公开后：

```bash
curl -fsSL https://raw.githubusercontent.com/Luoyehe/codex-harness/main/deploy/install.sh | bash
```

或传统方式：

```bash
git clone <本仓库> codex-harness
cd codex-harness
./deploy/install.sh
```

安装器自动完成：Node22 → pnpm → codex CLI → 构建 → systemd 服务，然后**交互式引导选择模型源**（也可无人值守：`PROVIDER=zhipu ZHIPU_KEY=xxx ./deploy/install.sh`，可选 `openai` / `skip`）。装完自动跑健康检查与全链路验证，并打印访问方式。

常用覆盖变量（均可省略）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 网关端口（始终只监听 127.0.0.1） |
| `CODEX_HOME` | `~/.codex` | codex 配置/凭据目录 |
| `CODEX_WORKSPACE` | `~/codex-workspace` | 新会话默认工作目录 |
| `SERVICE_NAME` | `codex-harness` | systemd 服务名（多实例部署用） |
| `PROVIDER` | 交互选择 | `openai` / `zhipu` / `custom` / `skip` |
| `ZHIPU_KEY` | — | 配合 `PROVIDER=zhipu` 无人值守 |
| `CUSTOM_BASE_URL` `CUSTOM_MODEL` `CUSTOM_API_KEY` `CUSTOM_CTX` `CUSTOM_VISION` `CUSTOM_EFFORT` | — | 配合 `PROVIDER=custom`；`CUSTOM_CTX` 窗口、`CUSTOM_VISION=1` 图片输入、`CUSTOM_EFFORT` 思考档（默认 medium，按端点文档选） |
| `EDGE` | 交互选择 | `none`（仅本机/SSH 隧道）/ `caddy-authelia`（HTTPS+登录） |
| `EDGE_DOMAIN` `EDGE_TLS` `EDGE_CERT_DIR` `EDGE_USER` `EDGE_PASS` | — | 配合 `EDGE=caddy-authelia`；`EDGE_TLS=selfsigned\|own`，own 时给证书目录 |
| `ENV_FILE` | `/etc/codex-harness.env` | 服务附加环境文件 |

> 国内网络默认走 npmmirror；海外服务器加 `NPM_REGISTRY=https://registry.npmjs.org`。

## 二、模型源（普适安装，激活时三选一，随时可切换）

安装器**同时部署各套方案的全部依赖**，交互式让你选择激活哪一套。**配置集架构**：每个模式在 ~/.codex/providers/<mode>/ 拥有独立完整的配置集（config.toml + models.json），~/.codex/config.toml 只是指向当前激活集的软链——切换即改链指向，各集互不触碰，新增供应商只需新增一个目录（O(N) 而非 O(N²)）。智谱与自定义 API 模式均为引导式：自动拉取模型列表供选择并探测思考档位（WebUI 输入框「发送」左侧有按档生效的思考选择器，三种模式都可用）。日后切换：

```bash
# 切到 OpenAI 原生（移除激活软链，回到零配置文件；其它模式的配置集原样保留）
bash deploy/providers/openai/setup.sh

# 切到智谱 Coding Plan（激活 zhipu 配置集：ZAI 模型源 + 四个 MCP）
bash deploy/providers/zhipu-coding-plan/setup.sh

# 切到自定义 OpenAI 兼容 API（本地 vLLM/Ollama/中转站；激活 custom 配置集）
CUSTOM_BASE_URL=http://127.0.0.1:8000/v1 CUSTOM_MODEL=my-model \
bash deploy/providers/custom-openai/setup.sh

sudo systemctl restart codex-harness
```

> **注意**：切换模式只改变**激活的配置集**（软链指向），不会删除其它模式的配置文件或 API 密钥。如需彻底清除某模式的密钥，手动删除对应的 ~/.codex/providers/&lt;mode&gt;/ 目录和 /etc/codex-harness.env 中的相关行。

### A. 原生 OpenAI（ChatGPT 账号）

不需要写配置，设备码登录即可：见 [`providers/openai/`](providers/openai/README.md)。

### B. 智谱个人版 Coding Plan（推荐国内用户）

GLM 系列模型 + 四个官方 MCP 服务器（联网搜索/网页阅读/仓库阅读/视觉），一键装配（含全部兼容性修复）：

```bash
sudo tee /etc/codex-harness.env >/dev/null <<'EOF'
Z_AI_API_KEY=你的CodingPlanKey
EOF
sudo chmod 600 /etc/codex-harness.env

bash deploy/providers/zhipu-coding-plan/setup.sh
sudo systemctl restart codex-harness
```

背景、分步说明与已知坑见 [`providers/zhipu-coding-plan/README.md`](providers/zhipu-coding-plan/README.md)。

### C. 自定义 OpenAI 兼容 API（本地 vLLM / 中转站）

交互引导 base_url、模型 id、接口风格与可选 Key；生成单模型目录使 WebUI 显示真实模型。详见 [`providers/custom-openai/README.md`](providers/custom-openai/README.md)。

## 三、远程访问

安装向导最后一步二选一（随时可重跑 `bash deploy/setup-edge.sh` 变更）：

1. **仅本机 / SSH 隧道**——不开对外端口、不需要身份认证：`ssh -L 8080:127.0.0.1:8080 服务器` 后浏览器访问本地端口。
2. **Caddy (TLS) + Authelia (登录鉴权)**——脚本自动安装/复用 Caddy 与 Authelia、追加站点配置并 reload。所有参数交互引导：**访问域名、对外 HTTPS 端口、Authelia 用户名与密码**，以及证书二选一：
   - **自签**：Caddy 内置 CA 签发，浏览器首次访问需手动信任
   - **自有证书**：提供证书目录（自动识别 `cert.pem+key.pem`、`fullchain.pem+privkey.pem`、`tls.crt+tls.key`、`<域名>.crt+<域名>.key` 等常见命名）

   应用前展示配置摘要供确认。无人值守等价变量：

   ```bash
   EDGE=caddy-authelia EDGE_DOMAIN=codex.example.com EDGE_TLS=own \
   EDGE_CERT_DIR=/etc/ssl/codex EDGE_USER=admin EDGE_PASS=... \
   EDGE_LISTEN_PORT=443 bash deploy/setup-edge.sh
   ```

   已有 Caddy/Authelia 的服务器会被自动探测并复用（只追加本站点配置；若现有 Authelia 使用白名单访问策略，需自行把新域名加入其 `access_control` 规则）。手工 Caddyfile 参考（同域 `/authelia` 门户模式）：

   ```caddy
   https://codex.example.com {
       tls /path/cert.pem /path/key.pem

       encode zstd gzip

       route /authelia* {
           reverse_proxy 127.0.0.1:9091
       }

       route {
           forward_auth 127.0.0.1:9091 {
               uri /authelia/api/authz/forward-auth
               copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
           }
           reverse_proxy 127.0.0.1:8080 {
               flush_interval -1   # WebSocket 流式
           }
       }
   }
   ```

## 四、验证与运维

```bash
bash deploy/verify-server.sh        # 本机全链路（healthz/WS/终端/turn/MCP 状态）
GATEWAY_WS=ws://127.0.0.1:8080/ws node deploy/verify-full.mjs   # 全部 RPC 面
node deploy/verify-mcp-tools.mjs    # 四组 MCP 工具真实任务（智谱预设）
systemctl status codex-harness
journalctl -u codex-harness -f      # 日志（app-server/MCP 桥 stderr 也在这里）

# 升级
git pull && pnpm install && pnpm build && sudo systemctl restart codex-harness
```

## 裸跑注意事项

- **服务用户**：默认 root（codex 的 bwrap/Landlock 沙箱完整可用）。非 root 用户需先放开 userns：`sysctl kernel.apparmor_restrict_unprivileged_userns=0`
- **项目路径**：任意宿主机目录都可直接建项目，建在哪就在哪
- **MCP 密钥**：`/etc/codex-harness.env` 的 `Z_AI_API_KEY` 供装配脚本读取；写入 config.toml args 的明文 token 受文件权限保护（600）
- **mcpServerStatus 显示的工具数是懒握手/缓存**：真实健康以 verify-mcp-tools 的实际调用为准
- **会话持久化范围**：codex 的 rollout 只保留消息、MCP 调用、文件修改与最终回复；思考过程与命令执行条目刷新后不回放（codex 核心行为）
