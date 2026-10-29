# Codex Harness

**把 Codex 放在自己的服务器上，在浏览器里完成开发工作。**

用电脑或手机管理项目、继续对话、审批操作、查看代码修改和使用终端。项目、配置和会话保存在服务器上，关闭网页后可以回来继续。

当前版本 **2.1.1**，适配 **Codex CLI 0.164.0**。适合个人自托管：一个管理员账号管理整个工作台，不提供不同用户之间的数据隔离。

## 能做什么

- **从对话到代码**：选择模型和执行权限，发送文件、图片或音频，查看计划、工具执行结果与代码修改。
- **管理多个项目**：浏览和编辑文件，搜索代码，查看 Git 状态、提交修改，以及管理独立工作区。
- **处理长任务**：继续历史会话，安排待执行消息、目标、子 Agent 和定时任务。
- **连接常用工具**：管理技能、插件、MCP 和模型供应商配置，也可以打开服务器终端。
- **内置账号登录**：用户名和密码即可进入；支持两步验证、恢复码和登录设备撤销，无需 Authelia。
- **断线后有据可查**：保留草稿并核对操作结果，避免因网络中断重复提交任务。

## 部署

准备一台 **Ubuntu 24.04 或 Debian 12** 服务器，支持 x64 / arm64，需要 systemd。服务器须能下载运行时并访问你选择的模型服务。依赖准备、HTTPS 和升级说明见 [部署指南](deploy/README.md)。

在服务器上安装系统依赖、取得源码并安装：

```sh
sudo apt-get update
sudo apt-get install -y git python3 sudo e2fsprogs util-linux mount bubblewrap ca-certificates
git clone --branch v2.1.1 --depth 1 https://github.com/Luoyehe/codex-harness.git
cd codex-harness
python3 -m deploy.cli pack-source --source . --output /tmp/harness-source.tgz
sudo python3 -m deploy.cli --instance demo install \
  --source /tmp/harness-source.tgz --origin http://127.0.0.1:3300 --port 3300
```

按提示设置管理员密码，默认用户名为 `admin`。安装器会准备固定版本的运行时、构建应用并注册服务；**不需要自己安装 Node.js / Codex CLI、填写 systemd 文件或生成管理令牌。** 模型账号稍后在网页设置。

安装时先用回环地址初始化，随后配置供电脑和手机访问的公网 HTTPS。准备自己的域名，将解析指向实际公网入口，在防火墙或路由器上开放并转发 **TCP 18443 → 服务器 18443**，供浏览器访问。默认本地 HTTPS 端口为 `18443`，HTTP 端口为 `18081`；网关本身保持回环监听。

**普通网络：域名和端口即可，由 Caddy 自动签发、续期，不需要 DNS API。** 默认 ACME 验证还需要至少一条公网验证通路：**公网 TCP 80 → 服务器 18081**（HTTP-01），或 **公网 TCP 443 → 服务器 18443**（TLS-ALPN-01，保持 TLS 透传）。高业务端口不能替代这两个公网验证端口。在满足这一前提的服务器上运行：

```sh
sudo python3 -m deploy.cli --instance demo https --host work.example.com
```

**公网 80/443 都被运营商封锁时：选择 DNS 验证。** 已集成阿里云、腾讯云 DNSPod、Cloudflare、华为云、Amazon Route 53 和 DigitalOcean。按域名的**权威 DNS 托管平台**选择参数，按[凭证准备说明](deploy/README.md#dns-credentials)把对应 API 凭证保存到服务器。以阿里云为例：

```sh
sudo python3 -m deploy.cli --instance demo https --host work.example.com \
  --dns-provider alidns --dns-credentials /root/harness-dns.json
```

DNS 验证不要求公网 80/443，Caddy 会自动增删临时 TXT 记录；业务端口 `18443` 仍需对客户端可达。部署工具会准备 DNS 组件，首次下载和编译可能较慢，不需要自己安装 Go 或手填 TXT。

| DNS 平台 | `--dns-provider` | 凭证 JSON 字段 |
| --- | --- | --- |
| 阿里云 DNS | `alidns` | `accessKeyId`、`accessKeySecret` |
| 腾讯云 DNSPod | `tencentcloud` | `secretId`、`secretKey`，使用腾讯云 CAM 密钥，不能填旧 DNSPod ID/Token |
| Cloudflare | `cloudflare` | `apiToken`，使用限定 Zone 的 API Token |
| 华为云 DNS | `huaweicloud` | `accessKeyId`、`secretAccessKey` |
| Amazon Route 53 | `route53` | `accessKeyId`、`secretAccessKey`、`region`（例如 `us-east-1`） |
| DigitalOcean DNS | `digitalocean` | `apiToken` |

以上命令都将 `work.example.com` 换成自己的域名，按提示验证管理员密码。命令成功后，从外部网络打开 **https://自己的域名:18443**，检查浏览器证书并登录。两种 ACME 模式都由 Caddy 管理续期，不需要 Certbot 或另设续期任务；保持 Caddy、证书数据及所选验证通路可用，DNS 模式还需持续有效的 API 凭证。未集成的平台仍可用普通 ACME，或自行管理证书。使用 Cloudflare 的默认 `18443` 入口时，将该解析记录设为 **DNS only（灰云）**；其常规橙云代理不支持这个端口。

部署前可用只读命令查看端口、签发和续期要求，无需实例、密码或联网。DNS 模式追加 `--dns-provider alidns`；它只展示输入方案，不检查现有实例或证明公网可达：

```sh
python3 -m deploy.cli https-plan --host work.example.com
```

自定义端口、自有证书、凭证轮换和已有地址迁移见[公网 HTTPS 与迁移](deploy/README.md#accounts-https-and-migration)。不要直接向公网暴露网关后端端口。

暂时没有域名时，可先通过 SSH 访问安装时的回环地址。在自己的电脑上运行并保持连接：

```sh
ssh -N -L 127.0.0.1:3300:127.0.0.1:3300 用户名@服务器地址
```

此时打开 **http://127.0.0.1:3300** 并登录。配置 HTTPS 后应使用新的 HTTPS origin；隧道不会绕过应用的账号与 Origin 检查。

## 开始使用

1. **设置模型源**：打开“设置 → 模型供应商”，选择服务；在“模型账户”完成登录或授权。
2. **添加项目**：选择服务器上的项目目录。添加目录不会上传电脑上的文件，也不会自动改变目录权限。
3. **开始对话**：点击“新会话”，输入任务并发送。需要时调整模型、审批策略与沙箱权限，再查看执行结果。

| 模型源 | 需要准备什么 |
| --- | --- |
| ChatGPT / Codex 账号 | 可使用 Codex 的账号，在网页完成设备码登录 |
| 国内智谱 Coding Plan | Coding Plan API Key 和可用模型 |
| 自定义 OpenAI 兼容服务 | 服务地址、模型 ID，以及服务要求的 Key；必须支持 **Responses API** |
| ChatGPT 企业网关 | Codex 兼容网关地址及 OAuth 配置 |
| Amazon Bedrock Runtime / Mantle | 支持区域、Bearer API Key 和模型权限 |

模型与工具的实际能力取决于供应商和账号权限。模型调用、语音及外部 MCP 可能消耗相应服务额度。

默认 **Enter 发送，Shift + Enter 换行**，可在“设置 → 通用”修改。文件、Git 和会话工具用于查看修改、继续或分支会话；“自动化”用于管理定时任务。完整能力与限制见 [功能清单](FEATURES.md)。

## 日常管理

在“设置 → 账号与安全”修改密码、管理登录设备或启用验证器两步验证；启用后请保存恢复码。工作台账号与模型供应商账号分别管理。

忘记工作台密码时，在服务器源码目录执行：

```sh
sudo python3 -m deploy.cli --instance demo account-reset --username admin
```

网关加载重置配置后，会清除两步验证并撤销已有登录。如果命令显示 `loginVerified: false`，请先恢复网关，再验证新密码。正常服务重启会保留尚未过期的登录会话。

服务状态、日志、模型配置和回执容量可在网页设置中查看。**更新请使用部署工具，不要在运行目录直接 `git pull`，也不要单独升级 Codex CLI。** 从旧版升级、迁移 Authelia、备份与故障恢复请按 [部署指南](deploy/README.md) 操作。

HTTPS 异常时，先查看 `status` 中的证书到期时间、TLS/实例验证结果，再读取 Caddy 日志。`active` 只表示进程运行，不能证明签发或续期成功：

```sh
sudo python3 -m deploy.cli --instance demo status
sudo python3 -m deploy.cli --instance demo logs --service caddy --lines 100
```

安装中断、卸载后恢复服务、离线备份和候选目录归档见[恢复与维护](deploy/RECOVERY.md)。这些操作会保留原账号和数据；不要重新安装同名实例来覆盖失败现场。

## 使用时需要知道

- 这是单管理员工作台，登录者共享项目、模型账号和执行权限。项目列表用于选择目录，不代表用户之间的安全隔离。
- 关闭网页通常不会停止模型任务；网页终端会随连接断开而清理，不能用于托管长期服务。
- 出现“结果未知”时，先检查历史与服务状态。系统不会自动重发已经提交但未确认的操作。
- 未发送的草稿和本地恢复记录保存在当前浏览器、当前访问地址下，不会跨设备同步。清除站点数据或更换域名、端口前，请先保存草稿并核对未确认的操作。
- 密码、恢复码、模型 Key 和包含凭据的备份应妥善保存，不要提交到 Git 或交给任务中的 Agent。

[部署指南](deploy/README.md) · [功能清单](FEATURES.md) · [架构与开发说明](ARCHITECTURE.md) · [验证记录](verification/WORKLOG.md)

MIT，见 [LICENSE](LICENSE)；上游组件保留各自许可。
