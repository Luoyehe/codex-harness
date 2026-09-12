# 部署指南

**裸跑（systemd）是唯一支持的部署方式**——没有容器路径映射问题，Codex 任务可使用原生沙箱（Landlock/bwrap）。升级请使用下文的事务式 `sudo codex-harness update`，不要把运行中部署简化为一次 `git pull`；网页终端的权限边界另见“裸跑注意事项”。

## 〇、统一管理入口（推荐）

安装后的一切部署与维护都走一个脚本：

```bash
bash deploy/manage.sh            # 交互式菜单
bash deploy/manage.sh status     # 子命令直达：provider|edge|restart|logs|
                                 #   verify|reinstall|uninstall|update
```

菜单覆盖：安装向导、切换模型源（排他激活）、远程访问、服务管理、验证、重装（修复/完全重置）、卸载和事务式更新。默认实例注册 `codex-harness`；自定义 `SERVICE_NAME=my-app` 注册 `codex-harness-my-app`，入口永久绑定对应服务，不会覆盖默认实例的管理命令。直接调用脚本时需显式传入相同 `SERVICE_NAME`。

## 一、安装（一条命令）

先准备运行 systemd 的 Linux 服务器（推荐 Ubuntu 24.04+ / Debian 12+），以及 Git、curl 和可用的网络。以下安装命令在服务器上以 root 执行；网关随后会以专用非 root 账号运行。缺少基础工具时先安装：

```bash
apt-get update && apt-get install -y git curl ca-certificates
```

然后运行安装入口：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Luoyehe/codex-harness/main/deploy/install.sh)
```

或传统方式：

```bash
git clone https://github.com/Luoyehe/codex-harness /opt/codex-harness
cd /opt/codex-harness
./deploy/install.sh
```

安装器自动完成：Node 22 → pnpm 11.22.0 → codex CLI 0.149.0 → 构建 → systemd 服务，然后**交互式引导选择模型源**（也可无人值守：`PROVIDER=zhipu ZHIPU_KEY=xxx ./deploy/install.sh`，可选 `openai` / `custom` / `skip`）。装完自动跑不启动 turn 的隔离 smoke 验证，并打印访问方式。

常用覆盖变量（均可省略）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `RUN_USER` | root 首装时为 `codex-harness` | systemd 服务用户；默认账号的 home 是 `/var/lib/codex-harness`，不接受 UID 0 的账号 |
| `INSTALL_DIR` | 当前检出目录；root 一行安装为 `/opt/codex-harness` | 源码与构建产物目录，服务用户必须能穿越父目录并读取产物 |
| `PORT` | `8080` | 网关端口（始终只监听 127.0.0.1） |
| `CODEX_HOME` | `<服务用户 home>/.codex` | codex 配置/凭据目录 |
| `CODEX_WORKSPACE` | `<服务用户 home>/codex-workspace` | 新会话默认工作目录 |
| `SERVICE_NAME` | `codex-harness` | systemd 服务名；自定义实例默认状态目录为 `<服务用户 home>/instances/<SERVICE_NAME>/.codex`，工作区也位于该实例目录 |
| `PROVIDER` | 交互选择 | `openai` / `zhipu` / `custom` / `skip` |
| `ZHIPU_KEY` | — | 配合 `PROVIDER=zhipu` 无人值守 |
| `CUSTOM_BASE_URL` `CUSTOM_MODEL` `CUSTOM_API_KEY` `CUSTOM_CTX` `CUSTOM_VISION` `CUSTOM_EFFORT` | — | 配合 `PROVIDER=custom`；`CUSTOM_CTX` 窗口、`CUSTOM_VISION=1` 图片输入、`CUSTOM_EFFORT` 思考档（默认 medium，按端点文档选） |
| `EDGE` | 交互选择 | `none`（仅本机/SSH 隧道）/ `caddy-authelia`（HTTPS+登录） |
| `EDGE_DOMAIN` `EDGE_TLS` `EDGE_CERT_DIR` `EDGE_USER` `EDGE_PASS` | — | 配合 `EDGE=caddy-authelia`；`EDGE_TLS=auto\|selfsigned\|own`（默认 auto），own 时给证书目录 |
| `ENV_FILE` | `<CODEX_HOME>/secrets.env` | 当前代密钥的稳定链接入口，目标文件为 600 且归服务账号所有；旧 `/etc/codex-harness.env` 须由管理员明确迁移，不会自动接管 |
| `NODE_BIN` | 已安装实例记录的路径或当前 `node` | 使用私有 Node 时显式传绝对路径；注册后管理入口会恢复该路径 |
| `TOOLS_BIN_DIR` | `npm prefix -g` 下的 `bin` | MCP 工具目录，写入 unit 与管理入口的固定 PATH；目录、祖先及已安装工具的真实目标须为 root 所有且不可被组/其它用户写入 |

> 默认使用 npm 官方 registry；只有明确需要镜像时才设置 `NPM_REGISTRY=...`，安装器不会修改全局 npm 配置。

root 一行安装的实际状态目录是 `/var/lib/codex-harness/.codex`，默认工作区是 `/var/lib/codex-harness/codex-workspace`。安装器会把自己新建的状态目录设为服务用户所有、模式 `0700`，并把 `secrets.env` 设为服务用户所有、模式 `0600`；对已存在的目录或项目树只做可访问性检查，**不会递归 `chown`**。自定义路径时，请明确授予服务用户对各级父目录的穿越权限和业务所需的读写权限；不要把安装目录放在它无法穿越的 `/root` 下。

网页日志通过 root 所有的实例专属 helper 读取本实例最近最多 300 行并脱敏；服务用户仅获该固定命令的 sudo 授权，不加入 `systemd-journal` 等全局日志权限组。

需要 Python 3.11+；推荐 Ubuntu 24.04+ 或 Debian 12+。安装器使用 `/usr/local/lib/codex-harness/codex/<版本>/` 下的独立 CLI，并将运行路径固定到 unit，不替换其他应用的全局 Codex。多实例共享默认服务用户，不构成操作系统用户隔离；需要隔离时显式指定不同 `RUN_USER`。卸载会先检查源码目录与所有保留路径的包含关系，冲突时在任何删除之前拒绝；应先迁移数据并更新 unit。

Linux 安装在注册服务前还会检查发行版 `bubblewrap`，必要时通过系统包管理器安装；Ubuntu 开启 AppArmor 非特权用户命名空间限制时，使用发行版的专用 `bwrap-userns-restrict` profile。不会全局关闭 AppArmor/user namespace 限制，也不会覆盖管理员定制 profile。随后在工作区内以实际非 root 服务账号运行显式只读的 `codex sandbox -c 'sandbox_mode="read-only"' -- /usr/bin/true`，失败则停止安装。此检查不调用模型。仅网关 ready 或初始化 smoke 成功，不能证明命令沙箱可用。详见 [OpenAI 沙箱前置条件](https://learn.chatgpt.com/docs/sandboxing)。

自定义 npm prefix 时，应为工具目录提供稳定的 root 所有路径（例如 `/usr/local/lib/codex-harness/tools/bin`），不要指向 `/tmp` 或普通用户可写目录。注册器保存明确的 Node/工具路径，不把安装者的整条临时 PATH 写进服务；重新安装和事务式更新会继续使用这些路径。

安装或修复检测到 root 服务账号（包括 UID 0 的别名和旧 systemd unit）时会在包安装、构建和环境文件操作前拒绝继续，`ALLOW_ROOT_SERVICE=1` 不再绕过检查。旧 root 部署须先停止服务并备份数据，由管理员创建专用非特权账号，明确迁移现有 `CODEX_HOME`、`ENV_FILE`、工作区及其权限，再按实际路径显式传入 `RUN_USER`、`CODEX_HOME`、`ENV_FILE`、`CODEX_WORKSPACE` 重跑。仅更换服务用户名不能完成迁移；请保留并核实受管理链接及其目标文件。root 可以执行系统安装，但服务配置维护会先切换到专用账号；不会自动接管 root 所有的旧环境文件。

## 二、模型源（普适安装，激活时三选一，随时可切换）

安装器**同时部署各套方案的全部依赖**，交互式让你选择激活哪一套。配置采用完整代际事务：`<CODEX_HOME>/providers/.versions/generation-*` 内包含各模式配置集及 `secrets.env`；公共 `config.toml`、`providers/custom`、`providers/zhipu` 和规范 `ENV_FILE` 都通过 `providers/.active` 共同指针发布，成功验证后只切换一次指针。旧代以私有权限保留供恢复。TOML 仅记录 `env_key`，语义重写保留配置值，但不保留注释与排版；私有旧代用于恢复先前配置。会产生真实 API 请求的思考档位探测默认关闭，可用 `PROBE_REASONING=1` 显式开启。日后切换：

```bash
# 切到 OpenAI 原生（发布空的受管理配置，使用 Codex 原生默认值）
sudo codex-harness provider openai

# 切到智谱 Coding Plan（激活 zhipu 配置集：ZAI 模型源 + 四个 MCP）
sudo codex-harness provider zhipu

# 切到自定义 OpenAI 兼容 API（交互填写地址、模型与可选 Key）
sudo codex-harness provider custom
```

管理命令会从已安装的 systemd unit 读取 `User`、`HOME` 和 `CODEX_HOME`，以服务用户执行配置脚本并自动重启服务。日常使用绑定实例的管理命令，不要直接以 root 运行 `sudo bash deploy/providers/*/setup.sh`；辅助脚本会拒绝缺少明确非 root `RUN_USER` 的 root 调用。确需直接调用脚本时，先切换到服务用户，并显式传入该用户的 `HOME`、`CODEX_HOME` 和该实例的 `ENV_FILE`。

> **注意**：切换模式不会删除其它模式的配置或密钥。规范 `ENV_FILE` 是访问当前密钥的稳定入口，不应替换其软链；旧代恢复快照可能仍含旧凭据，应按保留策略私密管理。edge 修改信任字段也使用供应商事务锁，并保持链接与其它密钥不变。

### A. 原生 OpenAI（ChatGPT 账号）

使用空的受管理配置和设备码登录：见 [`providers/openai/`](providers/openai/README.md)。

### B. 智谱个人版 Coding Plan（推荐国内用户）

GLM 系列模型 + 四个官方 MCP 服务器（联网搜索/网页阅读/仓库阅读/视觉），一键装配（含全部兼容性修复）：

```bash
sudo codex-harness provider zhipu   # 交互式隐藏输入 Key，并原子写入密钥库
```

背景、分步说明与已知坑见 [`providers/zhipu-coding-plan/README.md`](providers/zhipu-coding-plan/README.md)。

### C. 自定义 OpenAI 兼容 API（本地 vLLM / 中转站）

交互引导 base_url、模型 id、图片能力与可选 Key；初始生成所选模型目录，后续「同步目录」从 `/models` 发现模型并保留已知能力。仅支持 Responses API。详见 [`providers/custom-openai/README.md`](providers/custom-openai/README.md)。

## 三、远程访问

安装向导最后一步二选一（之后使用 `sudo codex-harness edge` 变更；自定义实例使用其专属管理命令）：

1. **仅本机 / SSH 隧道**——不额外开放网关端口，也不需要部署网页登录服务。在你自己的电脑上执行 `ssh -N -L 8080:127.0.0.1:8080 用户@服务器`，保持 SSH 连接，再用这台电脑的浏览器打开 `http://127.0.0.1:8080`。SSH 本身仍需认证；自定义过网关端口时替换转发目标端口。
2. **Caddy (TLS) + Authelia (登录鉴权)**——脚本自动安装/复用 Caddy 与 Authelia、追加站点配置并 reload。所有参数交互引导：**访问域名、对外 HTTPS 端口、Authelia 用户名与密码**，以及证书三选一：
   - **自动 ACME（默认）**：域名正确解析且公网验证端口可达时，由 Caddy 自动申请与续签
   - **自签**：仅建议内网测试；Caddy 内置 CA 签发，浏览器首次访问需手动信任
   - **自有证书**：提供证书目录（自动识别 `cert.pem+key.pem`、`fullchain.pem+privkey.pem`、`tls.crt+tls.key`、`<域名>.crt+<域名>.key` 等常见命名）

   **你仍需配置 DNS，以及服务器防火墙、云安全组或路由器端口转发。** 默认公网部署通常需要 TCP 80/443；自定义 HTTPS 端口还需放行该端口，且不能代替 ACME 所需的验证端口。脚本不会代替你修改这些外部网络设置。不要开放网关的 8080 端口。

   应用前展示配置摘要供确认。以下直接调用脚本的高级示例须在 root shell 内使用，并与已安装实例的配置一致；日常优先使用上述管理命令：

   ```bash
   EDGE=caddy-authelia EDGE_DOMAIN=codex.example.com EDGE_TLS=own \
   EDGE_CERT_DIR=/etc/ssl/codex EDGE_USER=admin EDGE_PASS=... \
   EDGE_LISTEN_PORT=443 bash deploy/setup-edge.sh
   ```

   已有 Caddy/Authelia 的服务器会被自动探测并复用。站点 marker 包含实例名；参数记录在 `/etc/codex-harness/<SERVICE_NAME>.edge.json`，后续禁用使用同一组路径。项目拥有的 Authelia 会补齐新域名的 `session.cookies` 并恢复自启；外部认证配置必须预先覆盖域名及访问策略，否则配置操作失败并回滚。自定义认证 unit 的状态目录是 `/var/lib/<AUTHELIA_UNIT>`。配置先完整校验，再仅重启一次认证服务并检查本机健康；失败时恢复旧配置及服务状态。

   无人值守且未设置密码时，随机初始密码只保存在认证目录的 `initial-password`（root 600），不会打印。哈希通过受控终端输入，不使用密码命令行参数；自定义密码支持普通 Unicode，但必须是无 C0/DEL 控制字符的单行，UTF-8 不超过 4096 字节。手工 Caddyfile 参考（同域 `/authelia` 门户模式）：

   要撤销当前实例的远程站点：`sudo codex-harness edge disable`（自定义实例使用其专属命令）。只删除该实例拥有的块。共享 Authelia 不会自动停用；专属名称 `codex-harness-auth-<SERVICE_NAME>` 的项目认证 unit 仅在确认无剩余 Caddy 引用时停用。重新启用会恢复开机自启。

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
pnpm test:smoke                     # 默认日常验证：隔离 CODEX_HOME，真实 app-server，但不发 turn
systemctl status codex-harness
journalctl -u codex-harness -f      # 日志（app-server/MCP 桥 stderr 也在这里）

# 默认线上验证只检查健康、SPA、WS 认证和可选 edge，不启动 turn
bash deploy/verify-server.sh
EDGE_URL=https://codex.example.com bash deploy/verify-login.sh  # 只验证未登录时被拦截；实际登录在浏览器完成
# 自签证书测试时显式设置 EDGE_INSECURE=1

# 以下显式启动真实 turn、使用当前模型额度并可能计费
HARNESS_ALLOW_PAID_TESTS=1 bash deploy/verify-server.sh
HARNESS_ALLOW_PAID_TESTS=1 GATEWAY_WS=ws://127.0.0.1:8080/ws node deploy/verify-full.mjs
HARNESS_ALLOW_PAID_TESTS=1 node deploy/verify-mcp-tools.mjs    # 四组 MCP 工具真实任务（智谱预设）

# 事务式升级（隔离工作树先测试/审计/构建，应用失败自动回滚）
sudo codex-harness update
```

事务式更新仅适用于 Git 检出（包括一行安装命令自动克隆的目录）：它拒绝脏工作树和非快进历史；候选应用及其固定 CLI 通过检查和隔离 smoke 后，保存旧产物与系统文件，短暂停止目标服务并发布已验证产物、CLI 路径、unit、helper、sudoers 和实例入口。失败时恢复旧提交、已保存产物与系统文件，不依赖再次联网或成功重建。旧版 CLI 为其它实例及恢复需要保留，不自动清理共享运行时。文件拷贝部署没有 `.git` 元数据，需先取得新版，再运行对应实例的 `reinstall repair`。

## 裸跑注意事项

- **服务用户**：root 安装时默认创建专用 `codex-harness` 非登录用户（home 为 `/var/lib/codex-harness`）；需要复用现有账号时可显式设置 `RUN_USER`。安装/修复及供应商配置维护要求非 root 服务账号，不再支持 root 绕过。若发行版限制非特权 userns，请按系统安全策略为 Codex 沙箱启用所需能力，不要把整个网关改回 root。
- **项目路径与权限**：注册项目只是在应用中记录目录并选择工作目录，不会授予权限，也不是 OS 沙箱。目录各级父路径必须允许服务用户穿越，项目本身还需按任务授予读写权限；安装器不会递归改动现有项目树的属主。
- **网页终端**：终端不受 Codex 任务的 Landlock/bwrap 沙箱约束，而是拥有 systemd 服务用户的完整 shell 权限。选中项目只决定新终端的初始 `cwd`；该用户在宿主机上有权访问的其它路径仍可访问。
- **同机访问认证**：默认 `GATEWAY_BOOTSTRAP_AUTH=local` 保留 loopback 免登录流程，不能隔离同机其它用户。需要严格认证时在服务环境中设置 `GATEWAY_BOOTSTRAP_AUTH=required`：浏览器原生 Basic 对话框用户名任意，密码为该实例的 `gateway-token`；Bearer 与已有 cookie 同样可用。该选项不替代远程 TLS 和登录反代。
- **MCP 密钥**：`<CODEX_HOME>/secrets.env` 是当前代密钥的稳定入口；私有旧代保留恢复副本。`config.toml` 只含环境变量名，密钥不会进入 TOML、命令参数或诊断输出
- **mcpServerStatus 显示的工具数是懒握手/缓存**：真实健康以 verify-mcp-tools 的实际调用为准
- **会话持久化范围**：codex 的 rollout 只保留消息、MCP 调用、文件修改与最终回复；思考过程与命令执行条目刷新后不回放（codex 核心行为）
