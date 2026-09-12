# Codex Harness

把 OpenAI 开源的 Codex 编程助手装进浏览器。在自己的 Linux 服务器上运行，用电脑或手机管理项目、继续会话、审批命令、查看文件 diff，并使用网页终端。

这是一个**面向单管理员的自托管 WebUI**，不是多人协作平台。模型由你选择的供应商提供，配置、项目和会话保存在服务器上。

当前版本 **v1.0.1**，变更见 [CHANGELOG](CHANGELOG.md)。

## 先选模型源

三选一，安装时选择，之后可在网页中切换：

| 模型源 | 你需要准备 | 自动配置的内容 |
|---|---|---|
| **ChatGPT 账号** | 可使用 Codex 的账号，首次完成设备码登录 | Codex 原生模式与内置模型目录 |
| **国内智谱个人版 Coding Plan** | 对应套餐的 API Key | GLM 模型目录，以及联网搜索、网页阅读、仓库阅读、视觉四类官方 MCP |
| **自定义 OpenAI 兼容 API** | Base URL、模型 ID；端点要求鉴权时还需 API Key | 供应商配置与模型目录；无鉴权的本地服务可留空 Key |

自定义端点**必须支持 Responses API**（`POST <base_url>/responses`）；只有 Chat Completions 的服务不能使用。能否执行工具、识别图片，以及可用的上下文长度与思考档位，取决于端点和模型本身，不是填入地址就会自动具备。

供应商细节：[ChatGPT](deploy/providers/openai/README.md) · [智谱 Coding Plan](deploy/providers/zhipu-coding-plan/README.md) · [自定义 API](deploy/providers/custom-openai/README.md)

---

## 快速部署

### 1. 准备服务器

安装脚本面向 **Ubuntu 24.04+ / Debian 12+**，使用 systemd 裸机部署。需要 root 或 sudo 权限，以及可访问 GitHub、软件包源和所选模型服务的网络。Windows / macOS 可以作为浏览器客户端和开发机，不支持这套服务器安装流程。

一行安装入口需要 `curl` 和 `git`。若尚未安装，在服务器执行：

```bash
sudo apt-get update
sudo apt-get install -y curl git
```

### 2. 运行安装向导

在服务器的 **root shell** 中执行（普通管理员可先运行 `sudo -i`）。此入口从仓库 `main` 分支安装：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Luoyehe/codex-harness/main/deploy/install.sh)
```

按提示确认工作区与端口、选择模型源，再选择访问方式。模型账号或 Key 可稍后在网页补齐；未完成模型配置时，页面能打开不代表可以对话。

**脚本替你完成，不需要手动配置：**

- 检查运行依赖；缺少时安装 Node 22、Python 3.11+，固定使用 pnpm 11.22.0、Codex 0.149.0 和智谱 MCP 组件 0.1.4。
- 默认创建非 root 服务账号，构建前后端、注册 systemd 服务与开机自启，并生成网关认证 token。
- 配置并验证 Linux 命令沙箱，运行隔离的 gateway + app-server 初始化检查；这些检查不启动模型回合。
- 注册 `codex-harness` 管理命令；若选择 HTTPS，继续引导配置 Caddy 与 Authelia。

默认程序目录为 `/opt/codex-harness`，数据目录为 `/var/lib/codex-harness/.codex`，工作区为 `/var/lib/codex-harness/codex-workspace`。程序与数据分开保存；不要把安装目录放在服务账号无法访问的 `/root` 下。

已有 root 账号运行的旧实例请先看下方[升级与迁移](#升级与迁移)，不要直接覆盖重装。自定义路径、多实例、无人值守安装见[部署指南](deploy/README.md)。

### 3. 从自己的设备访问

网关只监听服务器本机，**不能直接打开 `http://服务器IP:8080`**。按安装时选定的方式访问：

| 方式 | 你需要做什么 | 浏览器打开哪里 |
|---|---|---|
| **SSH 隧道（默认）** | 在自己的电脑运行下面的 SSH 命令，并保持连接 | `http://127.0.0.1:8080` |
| **HTTPS 域名 + 登录** | 准备域名解析，放行所选 HTTPS 端口；在向导中配置登录账号和证书方式 | 向导输出的 HTTPS 地址 |

SSH 隧道命令在**你的电脑上**执行，将 `用户名@服务器地址` 换成实际 SSH 账号与地址：

```bash
ssh -N -L 127.0.0.1:8080:127.0.0.1:8080 用户名@服务器地址
```

示例两端都使用网关端口 `8080`。若安装时选择了其它端口，请同步替换命令中的两个端口和浏览器地址；不要只改本地端口，否则网关的 Host 校验会拒绝连接。若浏览器就在服务器上，则无需隧道。

HTTPS 默认由 Caddy 申请和续签公开证书；**DNS、云安全组、主机防火墙与路由转发需要你处理**，自动签发还需满足 ACME 验证的网络要求。内网可选自签证书（需在设备上信任 CA），也可提供自有证书。脚本不会替你开放防火墙或修复公网连通性。

### 4. 开始第一条对话

ChatGPT 模式点击页面右上角完成设备码登录；智谱和自定义 API 配好凭证后无需再登录模型账号。HTTPS 入口的 Authelia 登录与模型账号登录是两件事。

若设备码授权被禁用，先在 ChatGPT 安全设置中开启；工作区账号可能需要管理员允许。见[官方设备码登录说明](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta)。

在左侧选择或添加**服务器上的项目目录**，新建对话即可使用。已有项目需提前授予服务账号必要的目录访问权限；添加项目不会自动改权限，也不会上传你电脑上的整个项目。

安装检查通过只说明基础服务可运行。首次仍应发送一条简单消息，确认你选定的模型服务可用；真实对话、上下文压缩和 MCP 调用会使用相应服务的额度。

---

## 日常使用与管理

- **项目与会话**：按项目组织会话，支持标题搜索与归档；移除项目注册不会删除项目文件。
- **对话控制**：输入框下方选择模型、审批策略、沙箱与思考档位；“默认”会恢复当前项目 / 模型源的有效默认值，而不是沿用上次的覆盖值。
- **附件与执行过程**：发送文件或图片附件，查看回复、命令、文件修改和工具调用；需要人工批准时，在审批区处理。底部抽屉提供 diff 汇总与网页终端。
- **上下文与显示**：「设置 → 对话」调整内容显示和自动压缩阈值，也可手动压缩；「设置 → 通用」调整当前浏览器的主题与输入习惯。

关闭页面不会主动取消正在运行的模型任务，但需要审批时仍要回来处理。**网页终端不同**：关闭终端或断开连接会请求终止它，重连不会恢复旧终端；不要用它托管需要长期存活的服务。

| 想做的事 | 使用入口 |
|---|---|
| 切换模型源、更新 Key、同步模型目录 | 网页「设置 → 服务器管理」 |
| 查看 MCP 状态、服务日志，重启服务 | 网页「设置 → 服务器管理」 |
| 配置或关闭 HTTPS 入口 | 服务器上运行 `sudo codex-harness edge` |
| 查看状态、验证、升级、修复重装、卸载 | 服务器上运行 `sudo codex-harness`，按菜单操作 |

模型源配置和目录同步会自动重启服务，页面会重连；**请先结束正在运行的任务**。网页同步不会发起付费思考档位探测，OpenAI 原生模式使用内置目录、无需同步。MCP 列出了工具也不等于真实调用一定成功。

常用命令也可直接执行：

```bash
sudo codex-harness status   # 当前实例状态
sudo codex-harness verify   # 默认只检查服务与连接，不调用模型
sudo codex-harness logs     # 服务日志
```

日常操作不需要手写 `config.toml`、`secrets.env`、systemd unit 或 Caddyfile。高级配置与排障例外请按[部署指南](deploy/README.md)操作，不要直接替换受管理的配置软链。页面能打开但提示网关未连接时，先查看日志；若刚变更了反代域名，用 `sudo codex-harness edge` 重新应用信任配置。

### 升级与迁移

正常 Git 安装使用：

```bash
sudo codex-harness update
```

更新会先在隔离目录测试、审计和构建，再切换应用及配套 CLI；发布或健康检查失败时自动回滚。它要求干净的 Git 检出与可快进的更新，**不要用运行中直接 `git pull` 或单独升级 Codex CLI 代替**。文件拷贝部署没有 Git 元数据，需取得新版本后执行修复重装。

旧实例若以 root 运行，或环境文件仍归 root 所有，必须先明确迁移到专用非 root 账号：备份并迁移 `CODEX_HOME`、`ENV_FILE` 和工作区，再指定 `RUN_USER` 及实际路径重装。安装器不会递归改属主，也不再接受 `ALLOW_ROOT_SERVICE=1` 绕过。[迁移与路径说明](deploy/README.md#一安装一条命令)

修复重装保留数据；完全重置是另一项需确认的操作。卸载默认保留会话、密钥、项目和独立 Codex CLI，执行前会列出移除与保留清单。请自行备份重要数据，卸载不等于清除凭证。

---

## 安全边界：部署前请读

- **仅供单管理员使用。** 所有登录者共享模型账号、项目、会话与终端权限，没有用户隔离。
- **不要直接暴露网关端口。** 远程访问使用 SSH 隧道，或带登录鉴权的 HTTPS 入口；token 不是公开裸露 HTTP 的理由。
- **网页终端拥有服务账号的完整 shell 权限，不受 Codex 回合沙箱约束。** 项目列表只是工作目录选择，不是权限边界；应通过 Unix 权限和非 root 服务账号限制访问范围。
- **默认本机免登录不能隔离同机其他用户。** 多人共用一台服务器时，按[部署指南的同机访问认证说明](deploy/README.md#裸跑注意事项)启用严格认证；它不能替代远程 HTTPS 与登录反代。
- **配置与备份都可能包含凭证。** 不要提交 `CODEX_HOME`、环境文件、会话或配置恢复快照；切换模型源不会删除其它模式的密钥。
- **自托管不代表完全离线。** 模型与 MCP 调用会将所需内容发送到对应服务，请按项目的数据保密要求选择供应商。

---

## 从源码开发

支持 Linux / Windows / macOS 开发。先准备 Node 22+，并将 `CODEX_HOME` 设置为**源码目录外的独立开发目录**，避免改动已有 Codex 账号和会话；然后在仓库目录执行：

```bash
npm install -g pnpm@11.22.0 @openai/codex@0.149.0
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`（或 `http://localhost:5173`）。开发模式为 gateway `8410` + web `5173`，仅监听回环地址，不要将 Vite 开发服务器暴露到远程网络。开发模式不替代 Linux systemd 部署，网页的系统管理功能也依赖已安装的服务。

```bash
pnpm test        # 单元与回归测试
pnpm typecheck  # 类型检查
pnpm build      # 构建前后端
pnpm test:smoke # 构建后：隔离启动真实 app-server，不启动模型回合
```

Linux 构建后可用 `CODEX_BIN=/固定版本/codex pnpm test:defaults` 验证覆盖值恢复：真实 Codex 0.149.0 配合本机模拟 Responses，运行两个无工具的离线回合，不读取现有凭证、不调用商业模型。真实供应商验收需要显式开启 `HARNESS_ALLOW_PAID_TESTS=1`，见[验证与运维](deploy/README.md#四验证与运维)。

`protocol/` 是固定 Codex 版本生成并提交的协议类型。CI 检查类型、测试、构建、ShellCheck、依赖与敏感文件，另有 CodeQL 与上游兼容性检查；不会自动升级 Codex。历史 `dev-codex-home/` 可能仍含会话或数据库，发布时排除不代表可直接删除，请先备份或迁移。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
