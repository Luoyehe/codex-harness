# 部署指南

**Linux 裸跑（systemd）是唯一支持的服务器部署方式**，Codex 任务可使用原生沙箱（Landlock/bwrap）。v1.1.0 引入独立的网关账号与控制目录，旧版须先按[首次迁移](#首次迁移到-v110)完成修复重装；此后使用事务式 `sudo codex-harness update`。不要在服务运行时直接 `git pull`；网页终端的权限边界另见“裸跑注意事项”。

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
| `RUN_USER` | root 首装时为 `codex-harness` | Agent/终端及数据维护的 worker 账号；home 默认 `/var/lib/codex-harness`，不接受 UID 0 |
| `GATEWAY_USER` | 默认实例为 `codex-harness-gateway`；其它实例自动生成独立名称 | 管理网关账号，必须与 worker、root 不同 |
| `GATEWAY_CONTROL_HOME` | `/var/lib/codex-harness-control/<SERVICE_NAME>` | 网关私有目录（0700），保存管理令牌、发送受理账本、最近管理操作结果及 `gateway.env`；worker 无权读取 |
| `INSTALL_DIR` | 当前检出目录；root 一行安装为 `/opt/codex-harness` | 源码、依赖、构建产物及祖先须为 root 所有，不能被 worker/其它用户修改；两个账号均需能读取运行文件 |
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

管理网关与 Agent 使用不同 Unix 身份。网关只通过私有 stdio 启动固定的 worker 后端；后端没有 HTTP/WS 监听入口，配置、会话与附件仍由原 worker 账号维护，不需要把已有私有数据改成组可读。root 所有的实例 helper 仅向网关账号授权固定的后端启动、本实例重启与最近 300 行日志；worker 没有这些 sudo 权限，也不加入全局日志权限组。网关令牌不会传入 worker 环境。

首次打开页面（包括本机和 SSH 隧道）需要浏览器 Basic 登录：用户名任意，密码由管理员用 `sudo` 读取 `<GATEWAY_CONTROL_HOME>/gateway-token`。不要把令牌粘贴给 Agent 或提交到仓库。旧单账号部署升级时会生成新的管理令牌；仅迁移旧环境中的合法 `TRUSTED_HOSTS` / `GATEWAY_HTTPS`，不复用 worker 曾经能读取的旧令牌。供应商密钥仍位于 `ENV_FILE`；网关/反代设置改放 `GATEWAY_CONTROL_HOME/gateway.env`。

需要 Python 3.11+；推荐 Ubuntu 24.04+ 或 Debian 12+。安装器使用 `/usr/local/lib/codex-harness/codex/<版本>/` 下的独立 CLI，不替换其它应用的全局 Codex。多实例默认共享 worker 账号，因此各实例的 Agent 数据不构成 OS 隔离；需要该隔离时显式使用不同 `RUN_USER`。卸载会检查默认路径、全部 `webui-projects.json` 注册项目及其它已注册实例的程序/数据引用；重叠、失效或无法读取的清单均拒绝自动删除。程序目录祖先不受 root 控制时也拒绝自动删除，须由管理员单独处理。

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

管理命令会从已安装的 systemd unit 读取 worker `RUN_USER` 和 `CODEX_HOME`，以 worker 的真实 `HOME` 执行配置脚本并重启服务。日常使用绑定实例的管理命令，不要直接以 root 运行 `sudo bash deploy/providers/*/setup.sh`；辅助脚本会拒绝缺少明确非 root `RUN_USER` 的 root 调用。确需直接调用脚本时，先切换到 worker 账号，并显式传入该用户的 `HOME`、`CODEX_HOME` 和该实例的 `ENV_FILE`。

> **注意**：切换模式不会删除其它模式的配置或密钥。规范 `ENV_FILE` 是访问当前密钥的稳定入口，不应替换其软链；旧代恢复快照可能仍含旧凭据，应按保留策略私密管理。edge 仅修改网关自己的 `gateway.env`，不读取或重写 worker 的供应商密钥。同步在线目录失败时不提交；目录内容相同则不生成新代，也不重启。智谱内置目录仅用于首次配置的离线后备，不用于刷新回退。

网页管理操作会在控制目录内保留最近一条带操作 ID 的状态记录，不记录密钥或配置内容。配置脚本完成、重启待确认、失败、结果未知和服务已恢复分别显示；页面重连不会抹掉上次结果，也不代表供应商业务验证成功。若请求超时而脚本可能仍在运行，新任务和其它管理操作会保持暂停，直到确认旧后台进程已停止；请核对当前配置，必要时通过服务器管理入口处理。不会自动重试结果未知的操作。

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

1. **仅本机 / SSH 隧道**——不额外开放网关端口，也不需要部署 Authelia。在你自己的电脑上执行 `ssh -N -L 127.0.0.1:8080:127.0.0.1:8080 用户@服务器`，保持 SSH 连接，再用这台电脑的浏览器打开 `http://127.0.0.1:8080`。SSH 与网关管理登录都仍需认证；自定义网关端口时同步替换命令中两个端口和浏览器地址，端口不一致会被 Host 校验拒绝。
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

   已有 Caddy/Authelia 的服务器会被自动探测并复用。站点 marker 包含实例名；参数记录在 `/etc/codex-harness/<SERVICE_NAME>.edge.json`，后续禁用使用同一组路径。项目拥有的 Authelia 会补齐新域名的 `session.cookies` 并恢复自启；自定义认证 unit 的状态目录是 `/var/lib/<AUTHELIA_UNIT>`。受管理配置先校验，再重启认证服务并检查本机健康，失败时尝试恢复旧配置及服务状态。**回滚也可能失败**，必须检查报错与实际服务状态，不能只凭脚本结束认定入口已恢复。

   外部自行维护的 Authelia 必须预先配置 cookie 域、规范登录 URL 和访问策略。脚本只检查部分配置关系，**不能完整验证外部访问策略或认证服务健康**；管理员需在实际入口分别验证未登录被拦截、登录成功及 WebSocket 连接。不要将配置校验通过当成公网或认证验收完成。

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

线上验证应由管理员或有权读取管理目录的账号执行。`verify-server.sh` 会从已安装实例的 unit 识别 `GATEWAY_CONTROL_HOME`；单独运行下面的 Node 验证脚本时，需要显式设置该目录（默认实例通常为 `/var/lib/codex-harness-control/codex-harness`）。脚本不再读取 `CODEX_HOME/gateway-token`，也不复用 worker 曾经能读取的旧令牌。认证检查从已认证页面取得本实例实际下发的 Cookie，不把真实管理令牌放进 URL。

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

# 迁移到 v1.1.0 后的事务式升级（先验证候选版本，失败时尝试回滚）
sudo codex-harness update
```

每个显式验证回合只生成一个发送操作 ID、提交一次；连接中断或结果未知不会自动重发。验证失败不是供应商成功验收，也不应通过反复启动真实回合来掩盖。

事务式更新仅适用于 Git 检出（包括一行安装命令自动克隆的目录）：它拒绝脏工作树和非快进历史；候选应用及其固定 CLI 通过检查和隔离 smoke 后，保存旧产物与系统文件，短暂停止目标服务并发布已验证产物、CLI 路径、unit、helper、sudoers 和实例入口。root 更新时，测试通过 systemd DynamicUser 在独立的可执行临时副本内运行，不以 root 跑业务测试，也不将测试副本写回候选源码。失败时尝试恢复旧提交、已保存产物与系统文件，不依赖再次联网或成功重建；恢复失败会保留恢复材料并报告，需要人工处理。旧版 CLI 为其它实例及恢复需要保留，不自动清理共享运行时。文件拷贝部署没有 `.git` 元数据，需先取得新版，再运行对应实例的 `reinstall repair`。

完全重置只清除明确显示的 worker 配置、会话及附件，并重新安装；管理账号、独立管理令牌与发送受理账本保留，避免把先前结果未知的发送误当作可以安全重试。数据删除始终以 worker 身份进行，确认前记录路径身份，确认后使用不跟随软链的目录描述符清理；目标或祖先被替换时拒绝继续，不会将软链解析成 root 的删除目标。

### 首次迁移到 v1.1.0

这是旧版单账号部署的**停机迁移**，不是普通在线更新。请预留维护时间，不要让旧版更新器执行新版候选测试，也不要只替换前后端构建文件。

1. 结束所有任务和网页终端，确认实例名、原安装目录、worker 账号、Node/工具路径、`CODEX_HOME`、`ENV_FILE`、工作区及现有 edge 配置。自定义实例全程使用相同 `SERVICE_NAME`。
2. 停止该实例，并备份旧源码/构建、systemd unit、管理入口、数据与实际配置链接目标、项目，以及已有的控制目录和 edge 配置。备份含凭证，应保存在私有位置；不要只复制 `secrets.env` 软链。修复重装不删除这些数据，但不能替代备份。
3. 确认原安装目录、Node 与工具路径及其祖先均为 root 所有且不可被普通用户修改。旧 root 服务、普通用户持有的运行时，或 root 所有的旧数据/环境文件，须先按“一、安装”中的账号与路径要求明确迁移；不要批量 `chown` 整棵项目或共享运行时。
4. 在**原实例的安装目录**取得 v1.1.0，然后直接使用新版 `deploy/manage.sh` 修复重装。下面仅适用于默认实例、默认路径、已满足权限要求且无本地修改的 Git 部署，各步失败后应停止检查，不要继续执行下一步：

   ```bash
   sudo -i
   cd /opt/codex-harness
   git status --short                 # 必须无输出；有修改时先保存并处理
   systemctl stop codex-harness       # 应已完成上面的停机备份
   git fetch origin --tags
   git merge --ff-only v1.1.0
   SERVICE_NAME=codex-harness bash deploy/manage.sh reinstall repair
   ```

   自定义实例替换服务名和目录；直接调用脚本不会自动选择另一个实例。文件拷贝部署需自行将发布源码放到原实例的可信安装目录，并保留数据，随后执行相同的 `reinstall repair`；不要把压缩包解压到状态目录。迁移中的修复重装不提供普通事务式更新的整套自动回滚，失败时保留备份、检查服务是否停止并人工恢复。
5. 确认安装输出中的 worker 与 gateway 是不同的非 root 账号，使用新控制目录的 `gateway-token` 重新登录。执行对应实例的 `status`、`verify`；检查已有项目/会话及选定模型源。若使用 HTTPS，还需实际验证登录与 WebSocket；最后用一条简单消息验证模型（会使用额度）。

修复重装使用 `PROVIDER=skip` 并保留现有 edge，不要求重新填写所有模型凭证。迁移不能撤回旧令牌或凭证可能已经发生的泄露；请检查历史日志、备份和暴露范围，必要时主动轮换。

### 验证脚本的边界

默认 `verify` 和 smoke 不做商业模型调用。目录、工具列表或初始化成功，也不等于工具任务成功；`list-mcp-tools.mjs` 当前还缺少完整的超时/错误退出保证，不能仅凭其退出码验收。失败或状态未知时不要自动重跑真实任务。低优先级 UI 与运维限制见 [CHANGELOG](../CHANGELOG.md#已知限制与验证边界)。

## 裸跑注意事项

- **服务用户**：root 安装时默认创建专用 `codex-harness` 非登录用户（home 为 `/var/lib/codex-harness`）；需要复用现有账号时可显式设置 `RUN_USER`。安装/修复及供应商配置维护要求非 root 服务账号，不再支持 root 绕过。若发行版限制非特权 userns，请按系统安全策略为 Codex 沙箱启用所需能力，不要把整个网关改回 root。
- **项目路径与权限**：注册项目只是在应用中记录目录并选择工作目录，不会授予权限，也不是 OS 沙箱。目录各级父路径必须允许服务用户穿越，项目本身还需按任务授予读写权限；安装器不会递归改动现有项目树的属主。
- **网页终端**：终端通过固定版本 app-server 的 `command/exec` 运行，未显式指定的沙箱策略取决于 Codex 配置；它不继承 Composer 当前回合的权限选择。进程始终属于 worker 账号。选中项目只决定初始 `cwd`，注册项目本身不是隔离机制；不要把“已选项目”理解为只能访问该目录。
- **同机访问认证**：默认要求管理令牌，包括 loopback。网关与 worker 的独立身份、私有管理目录及固定 stdio 后端共同构成权限边界；仅设置 `required` 不足以保护同一 Unix 账号运行的手工部署。Bearer 与已有 cookie 同样可用。各实例 cookie 名独立，但不同端口本身不是浏览器 cookie 的安全隔离边界；远程仍需 TLS 和登录反代。
- **MCP 密钥**：`<CODEX_HOME>/secrets.env` 是当前代密钥的稳定入口；私有旧代保留恢复副本。`config.toml` 只含环境变量名，密钥不会进入 TOML、命令参数或诊断输出
- **mcpServerStatus 显示的工具数是懒握手/缓存**：真实健康以 verify-mcp-tools 的实际调用为准
- **会话持久化范围**：codex 的 rollout 只保留消息、MCP 调用、文件修改与最终回复；思考过程与命令执行条目刷新后不回放（codex 核心行为）
