# 重写边界与实现契约

本文描述 2.2.0 的实现边界；交付验证状态以 `verification/WORKLOG.md` 为准。本目录从空项目开始，测试也重新编写，固定上游协议为 Codex CLI 0.164.0。

## 产品范围

单管理员自托管 Codex 网页工作台。基础会话、审批、附件、终端和部署之外，提供队列、目标、子 Agent、审查、定时任务、文件与 Git 恢复、worktree、技能/插件/MCP、记忆、远端环境及原生语音工作流。供应商包括 ChatGPT、企业网关、智谱、自定义 Responses 和 Bedrock。逐项入口、官方平台限制及验收证据见 `FEATURES.md` 和 `verification/feature-evidence/capability-coverage.json`。

不增加多用户协作或跨用户隔离承诺。项目列表是工作目录选择，不能冒充安全边界。网页终端显式使用 worker 的 shell 权限，与某个模型回合的 sandbox 设置无关。

## 模块所有权

- `src/core`: 不依赖 HTTP/UI/进程的校验、错误类型、SQLite 操作回执、任务准入与资源预算。提交结果只有 accepted / not_sent / unknown；未知不是可重试的失败。
- `src/runtime`: 独立 control 身份运行 supervisor，管理官方 CLI 的 stdio、模型/线程/审批/附件/终端。只接受固定 RPC 方法；通过固定 launcher 以另一个 native 身份启动 CLI、检查目录或执行受控文件操作，不获得 root 管理权限。native 身份不能连接控制 socket、读取 supervisor 进程资源或修改附件索引与受保护的成功记录。
- `src/gateway`: gateway 身份下运行，持有单管理员账号、登录会话、持久化操作日志和项目注册；验证网页请求，控制操作准入，通过私有 Unix socket 调用 worker；管理调用交给固定 root 管理入口。
- `web`: React 页面，各资源独立状态及代际号。操作意图先提交到 IndexedDB 事务，再发送，断线只查询回执。网络状态与页面导航分离。远端内容作为不可信数据呈现。
- `deploy`: Python 标准库的安装与管理事务。源码/运行时不可由服务账号修改。依赖准备与候选执行分离，候选以隔离非 root 身份验证。停机确认前不切换发布目录；恢复不确定时保留材料并失败。

网页会话外壳、工作区编排、消息条目与 Markdown 排版、输入选项、服务管理各有独立组件。历史数据预算与可见 DOM 窗口分开：保留已加载的完整数据，最多显示 150 条时间线记录；Markdown 在解析前检查字符/结构预算，解析后检查节点数和深度，失败只降级当前消息。计划和思考增量沿用条目身份及终态保护；没有共同水位的历史快照和增量不猜测拼接。

供应商以独立连接保存 endpoint、凭据和模型目录，可同时启用。新会话使用明确选择的 modelProvider；已有会话保持原供应商身份。模型目录和思考强度按供应商、模型联合匹配，分页不合并不同供应商的同名模型。非默认原生供应商的目录与共享 ChatGPT 状态通过有界只读探针读取；供应商设置修改仍经 root 事务生效。既有单供应商配置在配置层迁移中转换，保留账号和模型凭据。

浏览器从已认证 session、服务状态及 WebSocket 状态获取操作日志代际，仅新操作 ID 使用对应 UUID v8；资源 ID 不随之改变。归档维护必须完整读取分片、核对 SHA-256、下载并经用户确认，发送前另存维护身份；未知轮换结果只按代际和归档摘要核对，不能重发。旧代际回执保持 unknown/archived，不能降为 not_sent。管理器的只读状态与日志请求串行执行，取消页面读取不提前释放已发请求的客户端队列。

浏览器操作恢复协议 2 使用 IndexedDB 的操作表与常量大小的迁移标记。同源页面的创建、单调状态更新、确认和显式停止未知恢复通过事务串行化；最多保留 200 条活跃记录，已确认项删除后不会由迟到更新重建，也不留下每操作永久墓碑。旧 localStorage 记录只在已认证服务确认协议 2 后迁入，操作身份与迁移标记一起提交，再清理旧键；迁入的旧草稿保守保留。数据库不可用时，新操作在发送前失败；服务端已经接受的响应不会因本地清理失败而改成未发送。草稿与浏览器恢复数据按 origin 隔离，更换设备、域名或端口不会自动转移。

Node 24 LTS；TypeScript、React；服务端只引入必要的 WebSocket、协议校验和配置解析依赖。持久化使用 Node 自带 SQLite（WAL、synchronous=FULL、约束与事务）。操作回执只存恢复所需的身份与状态，不存对话正文、API Key、授权链接或任意环境变量；用户明确保存的自动化配置另存任务提示和执行设置。原生 CLI 是固定独立运行时，不从 PATH 猜测。

自 2.1.0 起，MCP 的临时 OAuth 授权链接也通过绑定发起连接和运行时的有界易失交接提供，不进入新回执。历史 MCP 回执在对外读取和新导出时隐藏该链接，保留原有操作身份及接受状态；升级不会安全擦除旧数据库、WAL 或已导出的备份。此处的授权链接是临时登录交接地址，不包括用户明确保存的 OAuth 端点配置或主动创建的共享链接。

## 服务间接口

浏览器：`POST /api/session` 使用工作台账号登录；`DELETE /api/session` 退出；`GET /api/session` 得到初始化状态与登录状态/CSRF；`POST /api/rpc` 收发 JSON；`GET /api/events` 升级只接收事件的 WebSocket。登录与初始化检查 Origin，已登录的变更请求同时检查 `X-Harness-CSRF`，WS 验证 Origin/Host/cookie。密码、验证器密钥和恢复码绝不写 localStorage 或交给 worker。

已认证 session 公布 `operationRecoveryProtocol: 2`。网页 RPC 带 `X-Harness-Recovery: 2`；旧协议的业务写入、实时写入和回执维护在派发及回执登记之前被拒绝为 `not_sent`，要求刷新页面。明确列出的只读 RPC 与工作台登录、初始化、账号安全流程保持可用。这是浏览器存储迁移的旧页面准入边界，不替代身份、CSRF 或连接所有权检查。

工作台使用内置单管理员身份，Caddy 只负责 TLS 与反向代理。账号和会话在 gateway 私有 SQLite 中持久化；密码使用独立随机盐的 scrypt，密码推导有并发和资源上限。服务器上的 root 管理命令通过带版本的账号初始化文件建立或重置身份；相同版本不能覆盖网页修改后的密码。旧管理令牌只可在账号尚未建立时用于一次性初始化，已初始化后不再授予网页登录权限。修改密码、会话撤销和两步验证变更在服务端生效；相关 WebSocket 随会话撤销关闭。身份认证持久化不改变操作回执与连接资源的所有权，也不把进程重启前的终端当作仍在运行。

公网入口默认使用 HTTPS 18443。DNS-01 支持 AliDNS、腾讯云 DNSPod、Cloudflare、华为云、Route 53 和 DigitalOcean，不依赖公网 80/443。固定源码和模块锁构建独立 Caddy 代际，证书仍由 Caddy 持久管理。每个平台有独立、严格的凭证字段；凭证使用 root 私有的不可变代际，经 systemd 仅交给 edge 身份，应用、模型和构建身份不读取凭证。HTTPS 事务同时绑定旧配置及候选 DNS 代际，控制工具升级与恢复逐个平台检查能力兼容性；旧 AliDNS 单插件代际不能充当其他平台支持。公网路由、实际签发与未来续期分别验证，不把进程运行当作证书验收。

RPC 请求 `{method,params,operationId?}`；成功 `{ok:true,result}`；失败 `{ok:false,error:{code,message,delivery?,operationId?}}`。需持久回执的业务变更必须使用 UUID operationId；回执轮换使用绑定导出身份、摘要与下一代际的专用事务，实时输入使用连接所有权和单调序号，不写入普通操作回执。普通操作结果按 operationId 查询，`not_received` 只表示此刻没有记录。重用 ID 且内容不同必须拒绝；不自动重放已越过写入边界的操作。

事件 `{type,data}` 包含状态、通知、审批、回执及终端/进程/MCP/语音/预测等专用类型。所有权事件绑定服务端确认的 clientId 与连接代际，不向其他连接广播。事件有大小限制；慢客户端断开后明确要求重新同步，不能静默丢事件。连接断开不取消普通模型任务，但撤销临时授权交接、私有结果与连接拥有的执行资源。

HTTP 同时限制连接数、处理中的请求数及实际保留的响应字节。请求占用持续到后台处理和响应完成两者都结束；客户端提前断开不释放仍在后台使用的准入额度。响应预算在 socket 完成或关闭时释放，写入超过 15 秒的慢客户端会断开；静态资源在读取前也需预留预算。

私有 worker 使用 HTTP over Unix socket（Windows 隔离开发用 loopback + 独立临时 token），同样的 RPC envelope 和事件流。gateway 的 `WorkerClient.call(method,params,context)` 返回 Promise<JsonValue>；context 绑定连接所有者、操作编号，文件变更另带网关计算的原请求摘要与项目编号。浏览器不能提供这些可信上下文字段。worker 的调用错误明确标记 delivery（not_sent/unknown）。工作进程启动时生成 epoch；进程中断导致已写请求 unknown，不能由一次普通连接重连解除。

## RPC 方法

- gateway：`project/list|defaults|create|add|remove`，`operation/read|retire`，`system/status|logs|restart|provider/read|provider/write|models/refresh`。
- runtime：`conversation/start`，`thread/list|resume|read|history|name/set|archive|unarchive|compact`，`turn/start|interrupt`，`model/list`，`defaults/read`，`account/read|login|login/cancel|logout|rateLimits`，`mcp/list|oauth`，`prompt/list|answer`，`attachment/upload|read|remove`，`terminal/open|write|resize|close`，`runtime/status`。
- “新会话”在浏览器创建草稿，首次发送才调用 `conversation/start`，内部创建原生线程并启动第一回合，返回 `{thread,turn}`；gateway 将已注册 projectId 转为 cwd，客户端不可覆盖。上游空线程尚未物化，不能作为持久会话承诺。部分创建后的错误保持 unknown，可携带已创建 threadId 帮助核对；不自动重放。输入可包含附件、受控上下文引用和经过验证的模型、权限、协作模式及输出 schema；确切允许字段由 `validation.ts` 定义。`thread/history` 同时遍历回合和原生时间线，返回分项完整性、历史版本与 owner 绑定的不透明续页标识；容量不足、时间线变化或未走完所有分页都不能标 complete。
- terminal/open 返回 `{terminalId}`，后续输出通过事件传递，不等待命令最终退出；终端必须绑定 clientId，最多每连接 2 个，非所有者不能控制。网页 clientId 由服务端会话/连接绑定，不信任提交字段。
- `prompt/answer` 接收 `{promptId,response}`；检查当前 epoch、类型、字段及字节预算，合法且确实写入成功才移除提示。`attachment/upload` 使用受限 base64 内容，返回不可猜的 ID；不接受任意文件路径。附件读取通过同一鉴权入口，不开放任意路径下载。
- 新能力使用 `src/core/feature-methods.ts` 和 `extension-methods.ts` 中明确枚举的方法。读操作、启动任务、继续任务、要求空闲的操作和配置操作分别准入；不是任意原生 RPC 代理。
- `thread/session` 只读当前进程已确认的会话设置，缓存缺失返回 `requiresResume:true`。查看历史不调用原生 resume。`thread/resume` 是持久化的显式继续操作，可能继续原生目标或队列；必须先完成当前连接的完整历史核对。空闲线程的 queue/add 也可能立即执行，不能归类为普通元数据修改。已激活目标、待执行队列及其核对过程在回合之间仍计入活动状态。
- 技能切换从当前项目的原生目录解析身份；插件安装以刚查看的详情摘要核对当前身份和策略。安装返回的认证需求、更新的逐项失败均保留；reconcile 不作为工具就绪证明。配置修改固定写原生用户配置、检查版本，不允许浏览器指定任意配置路径或改写供应商管理边界。
- 登录回执只有登录 ID；设备码与网关授权链接只在当前连接私有内存中读取。未确认的登录和取消不重复提交。诊断与预测内容同样通过 owner 绑定的临时结果读取；建议只能由用户明确放入草稿，不自动发送。
- 固定原生 Codex / Cloud 交互终端持有全局执行租约，准备、运行与进程树回收期间禁止并发配置和任务；确认结束后先送达尚在处理的 HTTP 回执，再自动重建后台进程，重新同步 CLI 可能修改的设置与账号。无法确认进程退出时仍保留未知状态。云任务启动前检查共享 ChatGPT 登录；原生诊断使用固定只读命令和独立进程回收证明。
- 文件写入通过 native 身份的描述符相对路径操作，校验旧版本并保留恢复材料。native 可写的恢复日志只供检查；supervisor 在收到并验证成功应答后，先将最小回执写入自己的私有 SQLite，再返回结果。`operation/read` 仅凭匹配操作、项目、原请求摘要的 supervisor 成功记录解除对应未知回执；只有 native 日志或缺少记录时保持未知，不重放文件变更。

浏览器需从 /api/session 获取 CSRF，POST /api/rpc 时带上。只订阅服务器事件，终端写入仍走鉴权 RPC。所有请求超时都有独立状态，过时代际回调不修改当前页面。

`operation/retire` 接收 `{operationId}`：仅当原编号从未登记时写入持久拒绝记录，使之后迟到的同编号请求确定不会执行；已有回执保持原状态。一次 `not_received` 查询本身不能证明请求永远不会到达。显式 `system/restart` 会终止当前任务与终端，并在 root 管理器确认实例进程全部停止后恢复准入；未知回执保持未知。仍在网关提交中的任务会暂时阻止重启，供应商及配置变更仍要求无活动任务。

## 审计与迁移

见 PROBLEM-ACCEPTANCE.md 的逐项回归条件，以及 FEATURES.md 的支持与验收边界。独立实例验证与生产数据迁移分别记录；安装器不会自动迁移旧实例。迁移须先备份并验证数据、保留可恢复旧实例，再明确切换，不把在线目录当作测试夹具。

## 开发与验证

开发机需要 Node 24 LTS（24.15+）和 pnpm 11.22.0，测试只使用隔离的 Codex 配置目录。安装依赖与常用检查：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
pnpm test:targeted tests/core/ledger.test.ts tests/gateway/http.test.ts
```

代码修改期间运行受影响的定向测试。全量测试在完整审计通过后执行；本次 2.2.0 发布按维护者明确指定的一轮完整审计无新增问题标准收尾，审计与授权记录绑定实际源码摘要。平台跳过项须由适用平台补足，不能计作测试通过。CI 同时提供 CodeQL、依赖漏洞和固定上游版本检查；真实供应商、公网证书及外部服务需另有实测证据。具体证据与完整测试入口见 [验证说明](verification/RELEASE-CHECKS.md)。
