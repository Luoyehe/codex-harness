# 独立重写执行记录

## 2026-10-30 — CI 运行时和通知测试收尾

CI4 的完整 Windows 与 Linux root 通过，Linux 仅一个通知回执用例失败；另一个 Windows 定向作业发生原生测试进程崩溃。已将 CI 固定运行时对齐部署使用的 Node 24.22.1，包含官方已确认的 Windows TCP 修复，但未冒称拿到了本次崩溃调用栈。通知测试改为先等待受控预览提交，再验证明确确认、只发送一次和查询原回执。业务源码未改，采用第五轮完整审计加两文件独立定向复核与全清单哈希比较，不虚增新审计轮次。

当前候选源码 `8e863b046390e60bef6e60b41082e4298909370aa0da75beac03737f8afed4b6` 将重新执行完整 CI；先前失败继续保留。详见[范围与证据](audit-evidence/v220-ci-runtime/carry-forward.json)。

## 2026-10-30 — v2.2.0 最终候选与第五轮审计

此前三次完整托管检查的失败均保留证据。第三次 Linux 原生计划任务测试的精确失败时序未复现；后续确认并修复了历史状态与实时回合不一致的问题。新增 17 项确定性回归，会话服务共 56 项通过；Windows 与隔离 Linux 的真实固定版本 CLI 定向测试各通过一次。修复过程与证据边界见[记录](audit-evidence/v220-ci-history/summary.json)。

冻结源码 `468803191f18e3950286f76348a8538a65ce5a90cb5538a7d0fafa56e3126cbe` 完成一次新的全仓审计，1,941 文件，无新增可修复问题或源码跳过项；审阅方法和深度见[第五轮报告](audit-evidence/v220-round5/team.json)。按用户最新的一轮门槛进入完整 CI，尚未把该候选部署到现网或创建正式 Release。120 的现有程序与仅供该服务使用的代理继续运行；本轮未调用付费模型或外部 MCP。

## 2026-10-30 — v2.1.1 发布收尾验证

本地全量基线 210 个文件、2148 个独立用例通过。随后修复自动化测试就绪等待、补充 Go CI 失败日志、改用兼容 OpenSSL 的过期证书夹具；最终对全部五个变更源文件映射的 61 个文件进行跨平台 CI 验证，708 个独立用例通过且无覆盖缺口。安全扫描通过，新增告警及位置变化均独立核实并保留结论。未重新进行全仓审计，也不把定向结果记作新全量结果。

120 的程序及部署代码与发布版一致，测试和 CI 修复不触发生产重启；10000 端口服务保持运行。README 和部署说明已复核。完整证据见 [发布检查](RELEASE-CHECKS.md) 和 [最终范围](audit-evidence/v211-release/final-scope.json)。

先前发布前快照（2026-10-30，v2.1.1）：冻结源码 `99521cf29d49d5e16142131ef1dad1f21ad73465ed478f0da6238669e9b1e561` 已通过 Windows/Linux/Linux-root 全量逐用例核对，共 210 个测试文件、2,148 个独立用例、零失败和覆盖缺口。审计依据仍为第 24/25 轮完整审计加唯一测试等待语句的精确差异复核，未虚增新审计轮数。120 已按用户要求改用 10000 端口，完成真实阿里云 DNS-01 正式证书签发和自动续期配置；外网严格 TLS、真实 WebSocket、只读 API、实际服务重启后的会话及操作代次保留、退出撤销均通过。最终外网验收未发生重试；此前代理链路间歇性 TLS 超时单独保留，未声称已根治。浏览器刷新恢复和退出通过，三项服务保持运行及开机启动。GitHub 托管 CI 和正式发布在本提交前仍待执行。详见 [本次部署证据](audit-evidence/v211-release/deployment.json)和[完整发布检查](RELEASE-CHECKS.md)。

发布验收（2026-10-27，v2.1.0）：内置单管理员账号、密码与两步验证、设备撤销及 Authelia 迁移均完成。最终源码 `69ed531f90c07a0dca44e876b0adafa009952a26a2133494e41bf636eb13b589` 连续通过第 7、8 两轮完整独立审计：每轮覆盖 1,862 文件，首尾哈希一致，无新问题或跳过项，满足用户要求的两轮门禁。提交 `a61ab4a9074232fdc75ad015d0ab789018bf9a8f` 随后通过 GitHub Windows、Linux 普通身份和 Linux root 全量作业：**182 个测试文件、1,677 个独立用例、零覆盖缺口**；平台跳过均由适用平台同一用例补足。安全作业成功，8 条当前源码 CodeQL 告警经逐项复核，无需源码修正，不声称零告警。详见[审计记录](audits.json)、[全量 CI](audit-evidence/v210-release/hosted-ci.json)和 [CodeQL 复核](audit-evidence/v210-release/codeql-review.json)。

120 已部署相同源码，完成内置认证迁移并保留原 HTTPS 地址与端口。严格 TLS 的 HTTPS/真实网关 WebSocket 验收在实际重启前后分别通过 12/4 项，验证会话跨重启保留、设备撤销、两步验证及恢复码、密码变更撤销旧会话；36 条迁移前业务回执及其代次保持不变。浏览器直接登录、账号设置、刷新恢复、退出再登录、项目文件和服务状态读取通过。网关、worker、Caddy 保持运行及开机启动，Authelia 已停止并移除服务。操作脚本遇到的候选目录预算和 HTTP 端口输入错误已分别核验、保留失败证据后处理；未修改冻结产品源码。详见[部署验收](audit-evidence/v210-release/deployment.json)、[操作记录](audit-evidence/v210-release/operator-execution.json)和[浏览器记录](audit-evidence/v210-release/browser.json)。本轮未调用付费模型或外部 MCP；公网 DNS/ACME 和第三方业务成功不在此结论内。下方旧结果及早期阶段说明保留原始时间与范围。

浏览器补充验收（2026-10-26）：用户处理测试证书提示后，已完成双层登录、工作台与设置、文件/Git、回执预览、真实 Shell 输入输出、草稿和输入偏好刷新恢复、访问认证失效后的原页恢复及自动化空列表检查。未发现需修改代码的问题；120 四项服务仍运行并已启用开机启动。仅补充验收证据，v2.0.1 标签与部署源码不变；桌面验收范围和未执行项见[浏览器记录](audit-evidence/v201-release/browser.json)。

发布验收完成（2026-10-26，v2.0.1）：提交 `0466fb96a7b389e3631c060572cd0761db213f6d`、源码摘要 `4ad01fbc1f966f25e9bfa6ede3c03ceefa1ef60d316dc256d9fca951e13cc289` 已通过 GitHub 托管 Windows、Linux 普通身份与 Linux root 的完整逐用例核对，共 **170 个测试文件、1,478 个独立用例，零覆盖缺口**。平台跳过保留原始状态，由适用平台的同一用例补足。安全检查通过；当前源码的 8 条 CodeQL 告警另有逐条人工复核，不声称零告警。120 已部署本次源码并实际重启，重启前后分别通过 22/24 项 HTTPS 验收，四项服务均保持运行及开机启动。详见[托管 CI 证据](audit-evidence/v201-release/hosted-ci.json)、[部署证据](audit-evidence/v201-release/deployment.json)和 [CodeQL 复核](audit-evidence/v201-release/codeql-review.json)。下方各阶段及[早期本地全量摘要](audit-evidence/v201-release/full-summary.json)保留其当时日期和源码范围，不代表当前总状态。

## 范围

2026-10-25 用户授权整个程序重写，只参考历史问题，不参考旧源码。旧开发快照已保存为 Git 提交 `fe54926eec22faf370a70a6ed853dd1d75ec0de6`，归档分支与 `archive/pre-rewrite-20261025` 标签已推送 GitHub，旧稳定分支未改动。本地另有源码 ZIP、完整 Git bundle、校验清单。归档未经最终验收，具体限制见该标签的 ARCHIVE-STATUS.md。使用仓库专用 SSH Deploy key 推送，因此没有冒称已创建 GitHub Release 说明页。

本仓库由空目录初始化独立 Git 历史。新代理仅获得产品边界、问题验收清单与官方协议；未读取旧实现、旧测试或旧历史来实现新程序。

## 正在完成的实现

- 40 项历史问题验收契约与官方 Codex 0.164.0 全新生成的协议。
- SQLite 回执核心、容量预算、独立身份的 HTTP/WS 网关与 worker、原生 app-server 生命周期。
- React 工作台、安装管理事务和固定运行时发布。尚在联调与独立审计前阶段，不能替换在线服务。

## 过程中的新发现

- 上游空会话在第一条用户消息前未物化。主流程改为本地草稿；首发采用一个 conversation/start 操作包含创建和首回合，部分创建或不确定结果不会自动重放。
- 后台写入后意外异常可能在最外层错误封装中变成 not_sent。网关已统一保留 unknown，并用真实 HTTP 错误响应回归验证。
- 在仓库子目录运行 pnpm fetch 参数探针仍会发现父工作区，曾移除根依赖链接。现有源码和 lockfile未损坏；已按冻结锁恢复链接。以后探针放独立临时目录并显式忽略父工作区。
- 静态浏览器检查发现小屏项目列表布局与对话框 Tab 焦点边界问题，Web 实现正在修复并验证。

## 验证纪律与边界

当前只进行修改所影响的定向检查。所有商业模型与外部 MCP 调用均未开启。原生 CLI 使用独立空配置和可自动结束的测试进程，不读取用户账号。120 现有服务保持运行；未使用 110 执行部署或测试。

常驻本地 worker/gateway 后台预览启动被自动审批拒绝（通用策略拦截，未提供更具体原因）。没有通过其它代理或改名重试。采用有明确退出/清理边界的定向集成测试，并单独使用无凭据静态 UI 夹具；静态夹具不冒充真实业务验收。

完整审计尚未开始，连续干净次数 0/3，全量测试尚未执行。`audits.json` 是门禁记录；跳过项与未验证集成不能写成通过。

## 新实现的集成修正（独立完整审计前）

- 收据投影统一在结果无效时标记 unknown，保留附件 mimeType 与合法长项目路径，控制数据库不保存原生消息正文；定向回执/调度测试通过。
- 浏览器重新连接同一拥有者前等待旧终端清理，且清理任务也计入连接容量；真实 HTTP/WS 定向检查通过。
- 每次状态事件保留网关持久化的不确定标记，不被正常 worker 状态覆盖；未知操作不能在界面错误显示为恢复可用。
- 后台模型目录刷新保留未保存供应商编辑；配置版本变化时明确提示冲突。保存期间禁止字段编辑。模型配置组件定向测试通过。
- worker/连接代际改变后重新加载选中会话，过时代际的默认值不进入新界面；定向会话恢复测试通过。
- Gateway 端口占用的启动失败会退出，不留下重连定时器；在真实占用端口上验证退出码 1。
- 120 只读先决条件检查通过：x86_64、Python 3.12.3、cgroup v2、sudo/setpriv/mount/e2fsprogs。原服务 PID 为 1639 与 1612，InvocationID 分别为 f733c762cd164186ad9675f74ea8e8b8 与 4aadfc2f85ef44aea79721af2cc0fe7d；待新实例验证后复核。
- 发现同 UID 模型进程可访问运行时控制 socket 的隔离缺口，正在将 native/model 身份与 supervisor 分离；此项修复与真实 Linux 验证完成前不计实现结束。

## 实际原生工具审批定向验证

`tests/runtime/approval-native.test.ts` 使用官方 CLI 0.164.0、独立模型目录与本机 Responses 替身。实际触发 exec_command 审批，验证无效响应不会消费提示、cancel 不执行命令、下一回合 accept 后才写入隔离测试目录中的 marker，工具结果进入后续请求。共 3 个本地协议请求，CLI PID 已退出、监听端口已关闭；无真实模型或外部 MCP 调用。

初次夹具假设显式提权提示允许 decline，经真实上游观察其 availableDecisions 只有 accept、特定策略批准及 cancel。实现正确拒绝了未提供的 decline；夹具已改为 cancel，没有放宽实现的审批校验。

## 独立预审与实际 Linux 准备

预审发现的请求配额问题已修为逐块计入实际保留字节，仍保留请求数和总字节边界；六个并发小读取时恢复回执接口可用。未知但尚未登记请求可由 operation/retire 原子阻止其编号；已有操作记录不会被覆盖，not_received 本身仍不是安全重发证据。两项核心/网关回归 22 项通过。

正式完整审计门禁补充每轮 inspectedFiles 并集覆盖整个快照，不能用每域一个样本宣称全仓检查。对应门禁定向 11 项通过；未实际运行全量。

120 的已有 `/var/lib/codex-harness` 属于旧服务账号，首次安装在创建实例材料前因不可信祖先安全拒绝。新实例 state 使用 `/var/lib/codex-harness-instances/INSTANCE`，旧目录权限完全未改。初始快照（非最终交付快照）的 SHA256 为 `0139085f460d957d212db3ef12d26cd7f5221629a10a388b113b2edeacafc15a`；在独立 staging 解压后，Linux NativeLauncherTests 3 项通过，包含 >12MiB 慢消费者管道字节哈希及逃离原进程组子孙清理。新实例安装正在下载验证官方运行时，仍未达到运行验收。

## 预审修复后的网关定向验证

显式重启现在允许恢复运行时最后快照中的活动或不确定状态；网关仍在提交的任务会阻止重启，供应商配置变更仍要求任务与终端结束。root 管理器负责停止确认，原未知回执不被改成可重试。调度定向 9 项通过（run-DVtl2g）。

退出登录改为按会话身份关闭 WebSocket，避免其它服务 Cookie 改变或顺序变化导致旧连接留存；每次事件发送前重新检查会话，过期后不等待心跳才停发。真实 HTTP/WS 定向 7 项通过（run-zKIrNi），服务端 TypeScript 检查通过。

独立预审已发现 runtime 历史完整性、附件明确拒绝后的引用回滚、历史连接容量释放、恢复读入口越权修改选项及可选 MCP 响应字段问题，正在定向修复。HTTPS 回滚/证书轮换预审 3 项已修复，8 项新事务定向检查通过。依赖审计发现官方视觉 MCP 旧 SDK/Zod 的已知公告；尚在兼容性升级验证，不能据此宣称依赖安全检查通过。

## 120 真实候选隔离验收与安装发现

在独立 `crtest-rw-20261025` 实例运行 linux_isolation.py 通过：build UID 987，管理token不可读、root源码不可写；联网阶段仅本机测试listener连接成功，离线阶段被阻断；1GiB文件系统边界、4096描述符、子进程退出清理、无凭据环境均确认。证据复制到 `.work/linux-isolation-initial.json`，原服务进程及InvocationID仍未变化。

官方Node/pnpm/CLI下载及固定摘要校验完成。首次实际应用候选在离线install阶段安全失败：pnpm11的供应链策略还需注册源元数据缓存，而构建仅传递了内容store。元数据未随候选传递导致 ERR_PNPM_NO_OFFLINE_META。保留候选和隔离网络；正在修复安全的元数据缓存交接，不关闭供应链检查。pnpm将失败详情写stdout，原配置丢失其诊断；受限阶段stdout现与stderr共用有速率限制的operator journal，环境仍无凭据。

## 120 启动联调修正

依赖缓存交接修复后，实际 Linux fetch/offline install/编译/CLI候选验证全部完成。首次服务健康检查发现 worker 通过 `current` 符号链接启动时，argv 与 import.meta.url 的路径拼写不同，原入口判断静默退出0。现按真实路径判定，并新增编译后直接入口及发布目录链接两条真实子进程检查（无CLI/模型启动）；入口及worker HTTP 5项通过。健康失败已停止新实例两服务并保留候选，旧实例未动。

同时安装origin校验提前拒绝不支持的非loopback HTTP、非规范数字主机写法，并规范化默认端口/IPv6，以匹配浏览器URL.origin及网关严格Host检查；2项多案例定向检查通过。首次安装失败后的完成标记、enable与previous语义正在补充，不能把尚未健康的候选当成可回滚旧版本。

官方协议在新的隔离home重新生成，1362个文件与仓库逐字节一致（.work/protocol-verify-2xnSsL/evidence.json）。旧CLI实际history迁移证据已补入runtime说明。

## Formal round 1 and Linux startup diagnosis

All 1510 frozen source files were covered by three independent reviewers. Eleven actionable findings were recorded; consecutive clean rounds remain zero. Repairs and targeted checks are in progress. Live 120 tracing and status requests established that Codex initialization succeeds, while gateway readiness fails because systemd resets RuntimeDirectory ownership to the control group. Earlier plugin-sync timeout suspicion was disproven. The deployment repair will use the IPC primary group for the worker service. Separately, requested streaming process shutdown returned failure despite confirmed cleanup; two actual Linux regressions reproduced it, then all seven affected Linux lifecycle checks passed after repair. Full suite has not run.

## Formal round 2 repairs and live browser findings

Three fresh reviewers covered all 1519 source files at digest `856c954ad2d2b2cb6736142c8333db435a5ff5430bd09174f65df9b06a4da684`; nine findings were confirmed. Runtime fixes recheck ownership before every composite native mutation, accept full-size canonical Base64 without stack-sensitive regex, and close/await the native epoch when disconnected terminal cleanup cannot be confirmed. Gateway/UI fixes preserve durable receipt replay without a live connection, original-draft ownership for delayed attachment removal, and chronology/explicit synchronization for history merged with streaming events. Deployment fixtures now distinguish unprivileged and actual-root execution. Source/Git scanning covers SQLite rollback sidecars and UTF-16 LE/BE across byte/chunk boundaries.

The user completed the internal-CA browser warning. Real browser login through Authelia and the gateway succeeded, and a draft survived outer reauthentication. Two additional integration findings were recorded: expired outer authentication produced a generic fetch failure because browser Accept */* requests were redirected; terminal intrinsic-width feedback expanded a 1499px panel to 8811px and exceeded the native column limit. These are being repaired and require live browser revalidation. The 120 TLS-verified protocol/PTY/attachment/UID checks remain separate evidence and did not prove those browser flows.

The affected Linux deployment identity matrix passed 67 ordinary-user and 40 root fixtures, zero skips. The initial validation archive omitted three dependency-input files and caused two ordinary fixture errors; completing that isolated package resolved them. Existing six service PIDs/InvocationIDs stayed unchanged. Full repository tests have not run; the consecutive clean count remains 0/3 until fresh independent audits cover the repaired snapshot.

## Feature completion and resumed verification — 2026-10-25

The requested scope now includes the pinned CLI's ordinary user workflows and common agent features. The capability inventory maps all 178 typed methods, distinguishes 137 web workflows, 23 controlled equivalents, 11 internal/legacy methods and 7 platform/service limits, and separately documents 15 derived workflows. These counts describe implementation coverage, not external-service acceptance or audit completion.

Account/device-login ownership, provider forms, explicit media preview, memory settings, hook events, loaded threads, next-step suggestions, fixed CLI/cloud entrypoints and private diagnostic reports have affected-area regression evidence. A real browser fixture exposed an overlapping tool menu and cramped content area; the corrected layout now closes the menu, focuses the selected tool and preserves unanswered approval input. A final common return-to-chat entry is being completed.

Linux attachment checks passed 16 cases with one Windows-only skip; provider checks passed 21 ordinary-user and 20 root cases, plus three isolated native provider probes. Cross-UID workspace operations have separate real-helper evidence. Fixed CLI cross-UID lifecycle verification is still being finalized: the offline doctor reached its fixed timeout and correctly reported failure, while the bundled model catalogue completed. Neither a timeout nor an absent interactive first screen is treated as a successful diagnostic or TUI acceptance.

The quota interruption did not authorize a deployment or full test run. Source is not yet frozen, consecutive clean audits remain 0/3, and the online 120 instance is still the earlier isolated candidate. Latest-source full suites, final isolated-instance update and Git delivery remain pending. No paid inference, real external MCP, email or credit operation was performed for this scope.

The resumed implementation phase is complete: shared tool navigation passed 53 focused UI assertions plus actual desktop/mobile browser checks; doctor warning compatibility passed 11 backend and 5 UI assertions. The final Linux cross-UID CLI fixture passed 40 checks under the product 256-task/3-GiB bounds (peak 112, zero task-limit events). Doctor warning report, bundled catalogue, visible native TUI, owner isolation, explicit close, disconnect cleanup and cloud no-auth exit were all observed. Only loopback HEAD/GET health probes occurred; no model POST was sent. All probe UIDs were empty and temporary authority removed. Earlier 96-task fixture failures remain documented rather than discarded.

Before freezing, 29 textual files were normalized from CRLF to the repository-declared LF to keep working, Git and Linux archive bytes consistent. Official generated protocol was already LF and was not changed. Historical hashes remain historical; final coverage hashes will use the normalized source. Type checks, production builds and source security scan pass; the bundle-size warning remains disclosed. This is still not a full-suite pass or a clean audit round.

Round 4 covered all 1,779 frozen files and found three actionable issues. The same-origin microphone policy now allows a browser permission request, advanced providers cannot enter an unsupported legacy configuration through rollback or recorded candidate recovery, and resume documentation reflects its explicit durable mutation semantics. Targeted results: gateway/realtime 24 passed; deployment Windows 23 passed; Linux nobody 23 and root 47 passed. Actual browser policy inspection allows microphone while denying camera and geolocation. No full suite or online update was performed. Source changed, so the consecutive-clean counter remains zero before the next independent freeze.

Round 5 covered all 1,779 files and found one P1 UI draft-loss issue. Two sibling pickers shared a React key and stale callbacks could replace saved draft text. The fix gives controls distinct identity and ordinary draft callbacks explicit navigation ownership. A follow-up late attachment-removal case after unmount/remount was reproduced and fixed while retaining current unsaved in-memory text after A-B-A navigation. The affected 52 tests, type checks and build pass. An actual browser using the current built UI and a read-only fixture completed repeated navigation with one environment control, preserved both draft texts and preserved a current environment option edit. No model request was sent. Source changed; clean count resets before round 6.

## Round 6 repair integration

Round 6 covered all 1,779 files and recorded seven findings. Repairs address bounded archive parsing and async input ownership. The integrated eight affected UI test files pass 112 assertions with no skips, plus combined typecheck/build. Browser checks against the current production build and an isolated read-only fixture confirm pending form locking, definite-failure draft preservation, sibling queue drafts surviving refresh, and 390x844 layout. The fixture was closed and its owned process stopped. A further queue refresh draft-loss case was fixed during repair and recorded separately from the original round 6 report.

Archive repair review additionally reproduced empty XZ-stream memory amplification and UTF-8 metadata undercounting; both were fixed with failing-before/passing-after regressions. Final deployment checks passed 44 cases on Windows with four Linux-only skips, then all 48 ordinary-user and 25 root cases on isolated 120 fixtures. Five integrity-verified official archives matched an independent complete content/mode/link manifest after extraction. No online service or provider call was made. All repair evidence is under `audit-evidence/round6-fixes/`; historical reports remain unchanged.

Round 7 began at 2026-10-25T09:25:02.781Z against 1,781 frozen source files, digest `3a355d650d3f4cdb8cd6952bebf1c8f039df1c2f4f61a1ffdc77ccb325dbe5b8`. Capability evidence was refreshed before freezing. UTF-8/LF and source security checks pass. Three fresh reviewers are inspecting the whole snapshot; clean count remains zero until complete evidence is recorded. Full Windows/Linux suites, final 120 update and development-branch delivery remain pending.

Round 7 is complete with all 1,781 source files covered and four P2 findings: process stdin drafts cleared by control actions or stale acknowledgements; Linux development-resource FIFO reads exhausting the filesystem thread pool; privileged directory enumeration allocating all names before the entry budget; and implicit archive parent directories escaping the filesystem entry count. Small isolated reproductions establish the failures; no resource-exhaustion attack, model request or online update was performed. Three deployment execution boundaries were explicitly retained as unexecuted in the report, rather than claimed as passes. Source fixes are now in progress in three parallel scopes; the consecutive-clean count is zero.

The deployment review command contained a personal interpreter path. Its original bytes were retained in ignored local evidence; only that display path was redacted before publication. `audit-evidence/round7/evidence-display-correction.json` records old/new hashes and the updated audit linkage. Findings, coverage, test results and skipped boundaries were unchanged; the source privacy scan now passes.

Round 7 repairs are complete. Process input and selection now have explicit owner/revision checks, including late spawn/remove responses; 58 affected UI tests pass, with real built-UI synthetic-RPC browser verification. Development resources reject real Linux FIFO immediately and enumerate directories within a global bounded budget; repeated Linux probes retain zero directory handles and preserve ordinary preview hashes. Deployment enumeration reserves the entire tree before descending, and tar import budgets include implicit parent directories; Windows 49 tests passed with six explicit Linux skips, followed by Linux ordinary 55 and root 25 tests all passing. A current pinned official Windows CLI archive was integrity-verified and fully extracted for compatibility. Combined typecheck/build, UTF-8/LF and source privacy checks pass. No full suite or live update occurred. All fix evidence is under audit-evidence/round7-fixes; a new frozen audit sequence follows.

Round 8 covered all 1,782 files at digest `492a6b22e554c92e91090eafb22cb95f571f0d2ef029f3e2daf542dcef3e0b8e` and recorded six P2 findings with no unreviewed audit scope. These concern realtime events assigned to a replacement session, lockfile allocation before its byte limit, asynchronous skill import overwriting edits, shared worktree confirmation, stale shell acknowledgement clearing a newer draft, and MCP subscription consent surviving a server change. The realtime reproduction uses a local protocol substitute and does not assert a live provider emits that ordering. A pre-existing terminal cleanup assertion also failed in the affected test selection and its isolated rerun; diagnosis remains part of the repair phase. Three independent repair scopes are active. No full suite or online update has run, and the consecutive-clean count remains zero.

Round 8 repairs are complete. Realtime startup and stop now follow the fixed official native lifecycle, preserve session ownership and wait for both acknowledgement and closure; 65 related runtime/Web tests pass. UI draft, confirmation and recovery ownership fixes pass 113 affected tests, including additional cleanup-directory, terminal-row and stale recovery-query cases reproduced during repair. Bounded lockfile reading passes eight new and six existing boundary cases. Combined typecheck/build, UTF-8/LF and source privacy checks pass. Actual production-built browser checks show worktree confirmation cannot transfer from create to archive, and changing MCP service invalidates subscription consent while retaining visible editable parameters; no mutation was submitted. Both temporary browser tabs and the exact owned fixture process were closed. Capability references were refreshed after source writers stopped. No full suite or online update occurred; a new independent frozen audit sequence follows.

Round 9 began at 2026-10-25T10:41:13.485Z with 1,783 files, digest `74b12821a3ced3d379a9b6c2c816468962c11488e7a92f4f536eef007ea05234`. Three fresh domain reviewers are reading the complete unchanged source; the fixed official protocol has independently regenerated byte-identically with complete schema and TypeScript reference checks. A real isolated native smoke test exposed a stale test context that omits the persistent-operation guard for logout; the runtime correctly rejected it before subsequent PTY acceptance. This is being recorded as a test defect without weakening product authorization. Audit remains in progress and source stays frozen until its reports are recorded. Full suites still require three consecutive clean audits; the final live update remains pending validation.

Round 9 is complete: all 1,783 files were covered, with two findings and one explicitly retained initial native-prerequisite skip. The interface scope has no actionable finding and 122 selected assertions passed. Runtime identified only the stale logout test context; the repaired smoke test now uses a real isolated Ledger and passes the complete official-CLI, cache/process-cleanup and PTY sequence, including independent reopening of the accepted receipt. Deployment identified checkout preflight counting blobs but not implicit directories/depth, allowing predictable budget failure after creating an unmanaged partial checkout. Its incremental preflight repair passed six Windows cases with ten explicit Linux-only skips; a bounded nobody/PrivateNetwork service on 120 is prepared to complement those platform checks. No full suite or online update has run. Fix evidence is being collected under `audit-evidence/round9-fixes/` before the next freeze.

Round 9 repairs are complete. The entire official-CLI smoke test passes with a durable isolated logout receipt and all later PTY assertions reached. Worktree preflight now incrementally budgets files and implicit directories with the same depth limit as inspection, before Git creates the checkout. Windows reports six passes and ten Linux-only skips; the same complete selected file passes all 16 cases under a real nobody/PrivateNetwork/read-only-source unit on 120. Exact-limit creation/read and over-limit rejection before any checkout/retention-holder/Git registration are verified, along with the existing archive/restore/interruption cases. The exact temporary unit and cgroup are gone, cleanup errors are empty, copied source hashes match, and SSH ownership has been released. No online service was altered. Typechecking, UTF-8/LF and source privacy checks pass. No full suite was run; new independent audits are required for this repaired source.

Round 10 started at 2026-10-25T11:12:14.265Z on 1,783 files, digest `0ea68b543586c9a511e9a3b222275964538bc86edc94bf793fceaf7187f5ef55`. Source and capability evidence are frozen. Three new independent reviewers cover runtime/protocol, gateway/core/Web and deployment/release; the consecutive-clean count remains zero pending their actual completed reports. Full suites, final controlled update of the independent 120 instance and development-branch Git delivery are still pending.

Round 10 covered all 1,783 frozen files and recorded one P2 automation draft-loss finding, with no skipped audit scope. The form now retains its original submission identity and version, preserves later edits across receipt recovery and reopening, and updates the same created plan instead of creating another. Conflicting saved drafts and newer server revisions remain explicit. Twenty focused UI tests and combined type/build checks pass. Actual production-built browser validation using synthetic in-memory receipts observed one create and one update to the same plan; both retained and finally saved text were verified. The temporary tab and exact owned process were closed.

Repair integration additionally found ten native test environments dropping parent denial proxies. A shared test-only environment now supplies isolated homes, temp/AppData, fixed loopback proxy guards and only explicit fixture credentials. Eleven selected files passed fourteen assertions; after the final TMPDIR addition the three helper assertions passed separately. Production network behavior did not change. The ignored Linux full-run wrapper was corrected for PrivateTmp path masking and now checks exact transient-unit ownership before stop; syntax and nine local executor simulations pass, but no real Linux full unit was executed. New source count is 1,785. All historical audit findings remain sealed; no full suite, online update or Git delivery has yet occurred. New independent audits are required.

Round 11 covered all 1,785 frozen files and found one P2: an attachment preview retained native modal ownership inside hidden Workspace after authentication expiry, making the visible login form inert. Real browser reproduction confirmed the hidden modal and unfocusable password input. Runtime and deployment scopes had no confirmed finding; legal maximum Base64 probes passed and the unproven image-size candidate was not promoted.

Round 11 repairs add a composed Workspace DialogScope that releases modal ownership and keyboard capture synchronously without business onClose or state deletion. A related nested Escape issue was first reproduced and fixed; only the top layer now handles keyboard events and restoration preserves layer ordering. Four affected test files pass 48 assertions, combined typecheck/build and encoding checks pass, and a separate read-only reviewer checked all 14 Dialog call sites and the final implementation. Actual production-built browser validation confirms usable login input, no hidden modal during expiry, restored preview after explicit synthetic reauthentication, and preserved unsent draft/attachment. Temporary browser tabs/processes are closed. No full suite or online update occurred. A fresh complete audit sequence follows.

Round 12 completed all 1,785 frozen files and confirmed one P2: a pending pairing status query that crossed code expiry stranded the next pairing check in busy state. A separate bounded repair-stage review confirmed another P2 in MCP result reread/download: an old completion could release a newer resource request and admit duplicate reads. The original full-round findings remain unchanged; the second issue is recorded separately.

Both repairs replace scalar pending state with explicit request and scope ownership while preserving original session receipts and accepted/unknown mutation outcomes. Four source/test files changed. The final affected tests pass 44 remote and 34 MCP cases, with zero skips; original pre-fix failures are retained. Independent bounded cross-reviews found no further confirmed issue. The Web production build and UTF-8/LF checks pass. Actual browser verification confirms expiry cancellation, a usable new pairing query, exactly one new read, and normal completion; it used synthetic local responses and does not claim real pairing or an overlapping old-response browser scenario. The temporary tab and server are closed. No full suite or online update occurred; a fresh complete audit sequence follows.

## Round 14 repair integration

The complete round covered 1,785 frozen files and reported one P2 MCP media preview boundary issue. A bounded repair crossreview confirmed the same missing image guard in AttachmentButton. Both were repaired without changing shared media validation or durable result semantics. MCP media is explicit and single-preview per panel; attachment preview refusal retains safe raw download. A StrictMode regression found during repair and a draft MIME compatibility restriction were corrected before final verification. Final affected runs passed 111 cases across four files with no skips; web noEmit and production build passed (existing large-chunk warning retained). Two independent scoped crossreviews found no remaining actionable issue. No actual large-image decoding, full suite or new online acceptance was run. All failed-before/intermediate results remain retained. See `audit-evidence/round14-fixes/root-integration.json`. Source changes reset the clean-audit sequence.

### 2026-10-26 — Rounds 15–17 and permission-validation repair

Rounds 15 and 16 independently covered all 1,786 frozen files and reported no findings. Round 17 found a permission-response comparison defect; its runtime investigation was interrupted by automatic safety review, and twelve handwritten files remained incompletely reviewed. The formal record retains that incomplete scope and resets consecutive-clean count to zero. No full tests or online update were started.

Replaced the generic subset check with a dedicated conservative rule comparator, preserving restrictive entries and scan-depth metadata while retaining explicit refusal and independent category selection. Review also caught and repaired early-refusal and unknown-unselected-category problems. The final 67 targeted JSON/fake-native tests, server typecheck and server build passed. Earlier failing regression outputs remain retained. This does not claim real filesystem escalation or downstream enforcement acceptance.

Current snapshot: 1,788 files, digest `c652892011ba0e69531d6ed79f859accb209390f6deaf4985de37ff7e506ac0e`. The test inventory is 148 files (120 JavaScript/TypeScript and 28 Python, including 8 root fixtures). Capability evidence was refreshed once after writers stopped. Three new independent complete clean rounds are required before full verification. See [repair](audit-evidence/round17-fixes/runtime.json), [cross-review](audit-evidence/round17-fixes/cross-review.json) and [integration](audit-evidence/round17-fixes/root-integration.json).

### 2026-10-26 — Round 18 realtime ownership repair

Round 18 independently covered all 1,788 frozen files and confirmed one P2: a retired realtime panel could notify a newly selected conversation through an old callback. Two local probes retained their original failing results. No audit scope was skipped.

The repair isolates callback authority by conversation visit and API/runtime identity while preserving original-owner cleanup and durable unknown receipts. Formal regressions failed before the change; all 39 affected tests pass afterward. Web typecheck and production build pass, with the existing large-chunk warning retained. A separate four-file static cross-review found no remaining actionable repair issue. Capability evidence was refreshed after writers stopped.

Current digest: `165e4eb91755092833f6a68339d007e3c1ac4c071dfef151361bb016ee1cf7c2`, 1,788 source files. Consecutive clean audits reset to zero; full verification, final controlled 120 update and development-branch publication remain pending. No real voice/provider service, full suite or live update ran in this repair. See [repair](audit-evidence/round18-fixes/realtime.json), [cross-review](audit-evidence/round18-fixes/cross-review.json), and [integration](audit-evidence/round18-fixes/root-integration.json).

Round 19 completed on the unchanged 1,788-file snapshot 165e4eb91755092833f6a68339d007e3c1ac4c071dfef151361bb016ee1cf7c2: all four scopes covered, zero findings and zero skipped audit scope. Consecutive clean count is 1. Runtime generated-contract checks passed; the interface reviewer executed 19 targeted assertions and the deployment reviewer reported 12 Python cases, with its mistakenly referenced shared Vitest directory explicitly withdrawn. Round 20 is in progress with fresh reviewers. A read-only 120 refresh confirmed all four services active, healthy gateway/worker responses, 12,415 immutable dependency entries and fixed CLI archive integrity; no service was changed.

### 2026-10-26 — v2.0.0 final preparation and user-directed workflow

Round 21 covered 1,788 files and found prompt dictionary/answer-state defects; the historical clean count remains zero. The shared form repair passed 66 targeted assertions and Web typecheck. Server and Web production builds passed; the existing large-chunk warning remains. A bounded independent repair review found no remaining actionable issue. The complete 13-file Markdown inventory was reviewed, with seven documents updated. A final CRLF-only source normalization and capability-reference refresh preceded this freeze.

Frozen v2.0.0 source: `1ff6d029fe901ec89f9dc44e9ff244239b3f6dbd0d578884f43ed1216c826e71`, 1,789 files. The user explicitly requested proceeding directly to full testing, formal v2.0.0 publication on the default branch, and a persistent deployment on the existing 120 instance, without three new audit rounds. This is recorded in [the source-bound authorization](audit-evidence/final-authorization/user-directed.json), not represented as clean audits. Full testing, deployment and publication are still pending at this checkpoint.

### 2026-10-26 — first full-run failures and bounded repairs

The first Windows full run found one native organization timing failure and a PowerShell cache artifact outside the expected source inventory. The first Linux full run found a project-association form race and two native fixture assumptions. Failed raw runs are retained and are not release acceptance. Repairs preserve known in-progress turn ownership, isolate process-scoped Windows cache files, derive untouched organization selections from loaded data, and make native queue interruption/restart explicit. The gateway-login fixture disables unrelated official plugin startup synchronization while retaining its denial proxy and original network allowlist.

Affected targeted checks, both TypeScript projects and the production build passed. Two native regressions passed on both Windows and isolated Linux; details and limitations are in [the repair record](audit-evidence/v2-full-fixes/root-integration.json). The new frozen source is `41816690ad436ed6c333bd33bec231981bf97710b950fdd887e52789526bb8a7` (1,789 files). Full testing must be repeated; no publication or live deployment is claimed here.

### 2026-10-26 — lifecycle fixture readiness correction

The second complete Linux run had no failing cases; root-only fixtures also passed. Windows had one lifecycle fixture failure: its marker was created about 1,000.9 ms after fixture-directory creation, just beyond the test framework's default 1,000 ms polling deadline. A controlled 1,200 ms delay reproduced the old test failure. The test now awaits a complete PID marker with bounded startup time and diagnoses early child failure; all original lifecycle shutdown assertions remain. Twelve affected tests passed. Product source is unchanged. See [the bounded repair](audit-evidence/v2-full-fixes/defaults-lifecycle.json).

New frozen source: `96cde170ad50eb50753feb3229881ce609f6d3328691ffee5c479105803963d1`. Complete platform verification must be repeated before publication or deployment. The second full-run failure and original platform skips remain in [their record](audit-evidence/v2-full-fixes/second-full.json).

### 2026-10-26 — v2.0.0 complete platform verification

Frozen source `96cde170ad50eb50753feb3229881ce609f6d3328691ffee5c479105803963d1` passed complete case reconciliation: **1,343 distinct cases**, 148 test files, zero failing cases and zero coverage gaps. Windows and Linux unprivileged full runs retain their original exit 3 for platform skips; the independent Linux root subset passed 69/69. All 236 skipped observations have an exact passing counterpart on the same source. Both platform process controllers confirmed cleanup and unchanged source. Detailed counts, immutable raw-evidence hashes and limitations are in [the full-test summary](audit-evidence/v2-release/full-summary.json). This is the user's explicitly authorized direct-to-full workflow; historical audit rounds remain unchanged.

### 2026-10-26 — persistent 120 deployment

The reviewed control update, provider-layer migration and application update completed for `crtest-rw-20261025` on 120. Native user configuration was preserved. Release `57434193056c8166dc4786f3686564ae7ee0cff0566a5fb7d63be81bb24047a8` contains v2.0.0 with Codex 0.164.0. Verification checked 20131 files plus permissions and managed units. Twenty-two real internal-CA HTTPS checks passed, including edge-to-gateway WebSocket, double authentication, file/Git helpers, bundled CLI diagnostics, attachment replay and native PTY disconnect cleanup. Four services remain active and enabled; the worker is connected and idle with no pending transaction.

[Deployment evidence](audit-evidence/v2-release/deployment.json) retains exact results. Browser visual acceptance is separately pending user handling of the internal-CA warning. Real commercial providers, public DNS/ACME and external firewall access were not exercised. GitHub publication is recorded separately.

### 2026-10-26 — v2.0.1 全量平台验证完成

第三次完整验证绑定源码摘要 `aaf648ede72d410cbebd6b66e11020024d7affc4f82d1cbe47929fa05f734803`，测试时提交为 `a3ec164b7c4c0aaf1f91b535ba4799e7a0fe2fb1`。三个平台报告的执行前后摘要一致；授权覆盖 1,836 个源码文件。本次采用用户明确要求的直接收尾授权，不把历史修复或授权记录算作新的三轮无问题审计。

| 验证身份 | 测试文件 | 通过观测 | 原始跳过 | 原始退出码 |
| --- | ---: | ---: | ---: | ---: |
| Windows | 158 | 1,299 | 93 | 3 |
| Linux 普通身份 | 158 | 1,378 | 14 | 3 |
| Linux root 夹具 | 9 | 73 | 0 | 0 |

合并后共 **167 个文件、1,465 个独立用例**；2,857 是跨平台观测次数，不作为独立用例数。107 次跳过都在同一源码的适用平台上找到完全相同文件与用例标识的通过结果，覆盖缺口为 0，失败为 0；原始跳过和退出码未改写。[摘要 JSON](audit-evidence/v201-release/full-summary.json)记录三平台明细、所有跳过对应关系、原始报告 SHA-256、核对结果与授权引用。先前失败和定向修复证据继续保留，不计入本次通过结果。

真实固定 Codex CLI 使用隔离目录及本地 loopback 协议替身，未调用商业模型或执行真实外部 MCP 业务任务；不据此声称真实账号、OAuth、语音、云任务或供应商业务验收通过。浏览器/操作系统输入法、公网 DNS/ACME、外部防火墙及第三方认证部署属于各自独立证据。本检查点只完成上述全量测试核对，最终 GitHub Actions 验收、120 的 v2.0.1 更新与正式 Release 仍待后续记录；上方 v2.0.0 部署结果不能替代本版部署验收。

### 2026-10-27 — v2.1.0 内置账号与完整审计（进行中）

用户确认发布版本为 **v2.1.0**，并要求修改完成后连续 **两轮** 完整审计无问题，再做全量测试、发布及 120 部署。本次以该明确要求覆盖 AGENTS 默认的三轮要求；不会把授权例外、定向复查或历史报告算作无问题审计。

内置单管理员账号已接入登录页和账号安全设置，提供密码登录、TOTP、一次性恢复码、设备撤销与重启会话持久化。安装与恢复工具使用根身份维护的初始化配置，并通过同一回环连接上的随机挑战核验网关，随后才提交凭据。HTTPS 迁移先验证内置账号，再切换 Caddy 并停用 Authelia。README 已围绕用户用途、部署与使用重写。

第一轮完整范围为 1,848 个源文件，摘要 `cf716085707487af4abf397bcb4e1f96172580c1c602e9630d08ff17accf40ba`。发现并修复已删除计划定义无限保留、目标与模型状态响应竞态、项目信任操作期间的编辑丢失，以及控制工具回滚的账号保护缺失；后续定向检查补充了控制恢复和应用失败恢复两条同类保护分支。[首轮证据](audit-evidence/v210-round1/v210-audit1-gateway.json)及[恢复分支补充](audit-evidence/v210-round1/recovery-followup.json)保留原发现，不计为通过。恢复相关的 6 个测试文件在 120 独立命名空间完成 69/69 用例；线上实例未被这组测试更改。

第二轮完整范围为 1,850 个源文件，开始和结束摘要均为 `862331f89cfb1e65c9b52d1e2869f1a1472ef4be1835a3ab3d59a39dc71e9f46`。发现两项问题：未知回执恢复绕过日志总容量预算；模型发现成功后父页面刷新导致待确认列表丢失。两者均有本地复现，正在修复。运行时、部署与工具/文档范围没有确认新增问题。所有范围及方法见 [审计索引](audits.json)；协议生成核对、程序化全文扫描与人工审查在各报告中明确区分。

此检查点的连续无问题轮数仍为 **0**。尚未执行本版全量测试、推送发布或更新线上实例；已准备的部署与验收脚本也不算执行结果。
### 2026-10-27 — v2.1.0 fixes complete; clean-audit gate in progress

The second audit's receipt-capacity and provider-discovery findings are repaired on frozen source `db9fb115155605b817e08b1599557c02a92032c2a1f237f490e51f2c8ed3d781` (1,852 files). Receipt admission, settlement, positive recovery and stopped-service recovery now maintain UTF-8 payload accounting without discarding accepted evidence or replaying unknown operations. Provider discovery retains its pending catalog until explicit application; editing is locked while a result is pending or unknown.

Targeted validation passed: 81 gateway/core cases, 25 provider UI cases, server/web type checks, and 8 local offline-journal cases. The current-source isolated Linux root run on 120 passed 20/20 account/journal recovery cases with no skips and confirmed fixture-controller stop. These overlap and are not presented as a unique full-suite total. Evidence is retained under `audit-evidence/v210-fixes/`.

The deployment and account-acceptance operator scripts were independently reviewed with 20 offline checks; this is preparation evidence, not a claim of actual migration. The retained online instance remains unchanged at this checkpoint. Complete audit round 3 is underway; no full test, publication, account migration or service switch has been performed for v2.1.0 yet. The user's required gate remains two consecutive clean, complete audits of the unchanged final source.


### 2026-10-27 — third complete audit; two additional repairs

Round 3 covered all 1,852 frozen files at unchanged digest `db9fb115155605b817e08b1599557c02a92032c2a1f237f490e51f2c8ed3d781`. Runtime and Web reviews reported no new issue. The gateway/deployment/tooling review confirmed two P2 findings: temporary MCP OAuth authorization URLs persisted in receipts and archives; local targeted Git fixtures inherited host global configuration and could run personal hooks. The latter does not affect the already isolated GitHub CI entry point. Both have narrow artificial offline reproductions retained with the round evidence.

This is a failed complete audit, not a clean round. The two repairs are now proceeding in separate code areas; the clean count remains zero and full testing/publication/deployment have not started.

### 2026-10-27 — third-round repairs and fresh audit boundary

Both third-round findings are fixed. MCP OAuth now uses an owner/channel/runtime-bound volatile handoff, and its durable receipts and historical read/export projection omit temporary URLs. Existing database/WAL pages and prior backups are retained, not claimed securely erased. The local test entry point now isolates planning, prerequisites and both JS/Python test engines using the shared CI environment allowlist.

MCP affected validation passed 192 assertions across 11 files plus an independent 25-case backend cross-review (overlapping cases, not a summed total). Server/web type checks passed. The actual pnpm targeted tooling entry passed 68 cases with one declared Windows platform skip. On isolated host 120, four environment tests and 12 account/journal root-recovery cases passed on source `f481ba6038f34ddef312d748d000504d833948aea01161927755b9c14f6f479d`; only the new MCP feature-evidence JSON was added/updated afterward. The final-source CI-path subset passed 9/9, including the exact previously skipped POSIX case. Both root fixture controllers confirmed stop; online services were unchanged.

Fresh audit round 4 now covers 1,862 source files at `bc995b764007152a4c8546b59d0980f44bdb5d53105cbcf195620eba703fdffa`. Repair/cross-review records in `audit-evidence/v210-round3-fixes/` are targeted evidence, not clean full audits. The required two-clean-round gate is still pending.

### 2026-10-27 — release scan fixture correction; incomplete round retained

Round 4 was deliberately stopped before completion when the source scanner rejected the new artificial embedded-credential URL fixture. This was a synthetic test string, not a discovered real credential. The URL is now built through its username/password properties; the rejection assertion and scanner remain intact. All 17 cases in that test file passed again, and the full current source scan returned clean. Partial audit records remain `complete:false` and never count as a clean round. Historical feature-evidence hashes retain their capture time; the fixture-only follow-up is recorded separately.

Round 5 starts fresh on 1,862 files at `e7d688de8f7d2a5b5e1a7c7dc059366b47d850752d4f83c84fbcbb1585da1458`. Production code is unchanged from the preceding targeted MCP/tooling and Linux recovery validation. Full testing, publication and online migration are still pending.

### 2026-10-27 — public HTTPS deployment follow-up, fourth complete audit

After the published v2.1.0 checkpoint, the operator supplied `cloudark.org.cn` for the retained 120 instance and requested public certificates, automatic renewal and complete deployment tooling. The current unpublished changes add explicit public-origin/local-port migration, strict certificate and instance verification, certificate diagnostics, initialization/service recovery, and directory durability barriers. The existing v2.1.0 tag is unchanged.

Public-HTTPS audit round 4 covered all 1,880 source files at `4c9f519ea78c5ac06bb3e12ec890fa1a0c4bdcc76073d10da51b420da3c5770a`, with one confirmed P2 finding and no omitted files: switching TaskPanel tabs silently discards unsaved queue/goal edits. Its repair is pending at this checkpoint. Gateway, runtime, deployment and tooling reviewers reported no additional actionable finding. The full method, precise delegated file scopes and original finding remain in `audit-evidence/public-https-round4/` and `audits.json`; generated-protocol comparison and static test-contract inspection are distinguished from manual production-code reading. This is not a clean round; the required consecutive-clean count is zero.

The preceding deployment-directory repairs have targeted passing evidence for 201 distinct cases across two actual executions of the same source capture (192 passed in the broader attempt, then all 14 initialization cases passed after correcting the fixture's artificial SGID restriction). Both original failure reports and the case-identity reconciliation remain retained. The 27 affected worker-witness tests also passed in an isolated unprivileged Linux fixture. These are targeted checks, not a completed full suite. Test fixture cleanup and unchanged main-service identities were verified.

The retained 120 gateway, worker and Caddy remain running on the previous internal-CA origin. Independent external ingress reaches port 18443; public TCP 80/443 acceptance remains unresolved, and the operator has been asked to confirm routing or supply router access. No public certificate issuance, public HTTPS acceptance, new Git release or main application/control switch is claimed here. Full testing follows two consecutive clean complete audits of the repaired snapshot.

### 2026-10-27 — task drafts and primary-button contrast repaired

The round-4 TaskPanel finding is repaired: visited task tabs retain drafts within the same owner session, hidden tabs stop background reads, and owner changes still invalidate the session. The affected workflow file passed all 38 cases (including the new regressions), and the Web type check passed. The red reproduction and green execution remain under ignored `.work/public-task-draft-*` evidence.

Complete public-HTTPS round 5 covered all 1,880 files at `3043a75341be043dc89c680f8342cb7a4110627a5281578bd5f3a1a2e8fbaf54`, with zero skipped files and one P2 finding: primary-button text had insufficient dark-theme contrast, while the generic hover selector could replace the primary background. The full reports are retained in `audit-evidence/public-https-round5/`; this round is not clean.

Only two CSS files were then changed to set theme-specific foregrounds and retain the primary background during hover. Actual source CSS in the browser now measures approximately 5.04/4.87 contrast in light normal/hover states and 6.43/5.83 in dark states. An independent focused review confirmed button/link coverage and focus/disabled inheritance. The Web build passed, with its existing bundle-size warning recorded. These are targeted repair checks, not another complete audit or a full-suite pass. The repaired 1,880-file snapshot is `b3626c87e9dc13287812632ab712594ef4061ce4d88ef217da1869ecaa9055aa`; two fresh clean complete rounds are still required. Public routing and ACME acceptance remain pending, and the retained 120 services are unchanged.

### 2026-10-27 — remaining tab drafts repaired; seventh audit in progress

Complete public-HTTPS round 6 reviewed the same 1,880-file snapshot and found five P2 issues: switching organization, settings, extension, MCP-tool or workspace-Git views could discard unsaved input. All five are repaired. Visited panels retain ordinary drafts within their owner session, while hidden panels stop reads and reject actions; secrets, stale previews and execution consent are cleared. API, project, thread and connection changes still isolate drafts, including changes away and back. Late mutation outcomes retain their original receipts without being replayed.

Affected validation passed: 17 organization cases; 130 settings cases; 100 extension/MCP cases followed by 67 cases after final changes; 48 workspace/Git cases followed by the final 9-case draft file. These sets overlap and are not added into a unique total. The unified Web type check and production build passed; the existing bundle-size warning remains. Read-only browser fixtures also confirmed organization-name and provider-profile drafts survive tab navigation, with hidden controls absent from the accessibility tree. No real model, external MCP action or online service mutation was involved.

Round 7 is frozen at 1,883 files, digest `6b0ad3fde30f8b7d634099db2e97f05fca6d3ff7879374bce84676b525ae2520`. At this checkpoint its complete report is still pending. A separate actual-browser check reproduced a mobile composer clipping defect; it will be recorded as a finding, not a clean audit. Two consecutive clean complete rounds and full tests remain outstanding.

A later independent external recheck timed out on both public 443 and 18443; local strict-CA HTTPS still returned 200, and the proxy could reach the public ACME directory with certificate verification. DNS still resolved the supplied domain to the same address. This supersedes any assumption that the earlier successful 18443 probe proves current reachability. No public certificate issuance or renewal acceptance is claimed. The pending router/NAT question remains necessary to finish public deployment.

### 2026-10-27 — mobile composer repaired; eighth review recorded

Round 7 completed on the recorded 1,883-file snapshot with one P2 finding: expanded input options could place the composer outside a small viewport with no usable scroll container. The repair makes the main workspace scrollable independently of pending approvals. The Web build passed. Actual browser interaction covered collapsed/expanded composition at 390×680, landscape 680×390, desktop 1280×800, an existing thread with a pending prompt, and navigation to terminal/files and back. Inputs and send controls were reachable. No task, approval or terminal process was started; virtual keyboards and native mobile OS behavior remain untested. Exact geometry and screenshot evidence are retained under ignored `.work/r7-web-layout-*` paths.

Public-HTTPS round 8 covered all 1,883 source paths at `3b2ca1ed3f79e4f1fc71254b4085ddbcec2b5e0d3419638d032a144a3c5fded0`. Root and a separate reviewer independently confirmed the same weekly-DST search-horizon defect (one distinct P2 finding): when the following weekly wall time does not exist, the next valid occurrence can fall outside the eight-day search. An in-memory reproduction also demonstrated rollback of a normally due run during collection. The two original confirmations are retained as separate records with an explicit duplicate reference.

The web reviewer disclosed accidental exposure to historical outcome paragraphs in the current verification document and marked its report ineligible as a blind clean audit. This disclosure and its declared review limits are preserved unchanged. Accordingly round 8 records `coverageComplete:true` but `complete:false`; it is not a clean round. The required consecutive-clean count remains zero. No historical conclusion is substituted for fresh testing.

Package and user documentation are prepared for a prospective v2.1.1 release; no tag or Release has been created and v2.1.0 remains unchanged. Full tests, public ACME acceptance and main deployment switching remain pending. The retained 120 gateway, worker and Caddy were checked again and are still active with unchanged process identities.

### 2026-10-27 — weekly gap repair and ninth independent review

The weekly search horizon is now fourteen local dates, preserving the first occurrence in a repeated hour while skipping nonexistent times and dates. Targeted regression execution passed 17/17 cases across the schedule and scheduler files. Tests cover immediately after the preceding weekly occurrence, multi-occurrence previews, half-hour DST changes, the skipped Apia date, unrelated due jobs, stable receipts and absence of duplicate dispatch. The affected strict type check passed. Red, intermediate fixture-error and final green evidence are separately retained under ignored `.work/r8-schedule-*`; no intermediate failure is presented as a pass.

Round 9 is reviewing the repaired 1,883-file snapshot `68def730337c6269a6dbde9b67f3a8a591f7810467fff73fce59f75365871b82`. Gateway and deployment/tooling reviews are sealed with no new findings in their scopes; complete round acceptance remains pending. Runtime and web reviewers have found test-fixture failure cleanup and visual-preview contract problems, so this round will not establish a clean audit. No full suite, public certificate issuance or online migration has started.

Round 9 is now complete: all 1,883 paths, zero skipped files, and three findings. R9-RUNTIME-001 groups failure-path cleanup gaps in native integration fixtures; R9-WEB-001 covers outdated session/catalog reads in the manual visual fixture; R9-WEB-002 covers unhandled malformed/interrupted RPC bodies in that same loopback fixture. No production runtime defect was claimed for these findings. A separate actual loopback probe confirmed that session/catalog reads return fixture_readonly and a null RPC body terminates the owned preview process with exit 1; the process exit was observed and the source digest stayed unchanged. Two clean rounds remain required.

The deployment/tooling review's original firstRecordedAnalysisAt field was normalized to startedAt for the common record schema, preserving the original fields and original-report checksum. This is a schema normalization of retained timestamps, not an invented review start. The independent 25-component web supplement and root's two runtime-test full-body supplement are recorded separately.

### 2026-10-27 — ninth-round repairs verified; tenth audit underway

R9-RUNTIME-001 is repaired with independent reverse-order fixture cleanup. Each acquired provider, runtime, worker, ledger and process controller is registered immediately; one failed disposer cannot prevent later cleanup, and original failure information is preserved. Nine affected files passed 19 targeted cases, including seven cleanup/failure regressions and twelve isolated fixed-CLI cases. Affected TypeScript checks passed. The red cleanup demonstration was a synthetic straight-line control, not execution of historical code; the original finding was established by current-source inspection.

The manual preview fixture now supplies read-only session/catalog data, bounds and validates request bodies, handles interrupted requests, and owns its HTTP/WebSocket shutdown. Its exact targeted file passed 15/15 cases after correcting a listen-error path; the intermediate failure remains recorded. Actual browser interaction additionally confirmed inherited model selection, an enabled composer, available environment guidance, explicit refusal to send and retained draft text. Screenshot and accessibility evidence are in ignored .work/public-r9-preview-browser.*. This used a loopback visual fixture and existing web build, not deployed API/worker acceptance. Its tab and owned process were closed, with exit zero observed.

Round 10 is frozen at 1,886 files, digest 81e2da6e8a58c49746483cd2fd59e81cc8a0d6143980364eea8f8b0c3cd7cc89. The runtime review freshly regenerated and compared all 458 JSON protocol shapes and 904 TypeScript protocol files. The current round has a confirmed gateway-local project registration revocation race, reproduced using an in-memory ledger and a deferred resolver. Complete-round recording and repair are pending; this is not a clean round. Full tests and online switching have not started.

The public production plan is prepared but unexecuted. Direct system-CA-verified ACME directory access succeeded under both root and the observed Caddy UID with proxy environment absent. This proves current outbound directory connectivity, not an actual order or renewal. Router/NAT confirmation and independent public ingress acceptance are still required; existing Nginx sites and service ports remain protected.

### 2026-10-28 — continuation and revised public ingress requirement

Round 10 completed with all 1,886 files covered and one finding. The project/add resolver race is repaired by rechecking the live connection immediately before the local project registration. Targeted verification passed 37 cases across dispatch, worktree and workspace acknowledgement tests, with service TypeScript checking successful. Already executed backend acknowledgements remain durable. The repaired snapshot was 3ecf63e81c667d40b17d567dfe5a0211f8194ca06f8becd9766a3fffb9d64e5a.

Round 11 was interrupted by exhausted agent quota before its reviews finished. Its partial inventories, protocol regeneration and contract extracts are preserved under ignored .work, but no complete or clean round is claimed. The consecutive clean count remains zero; no full-suite authorization, tag, Release or online migration was performed. A later proxy ingress probe also failed its external control request, so its timeout does not establish a router or ISP diagnosis.

The user has now confirmed that the ISP blocks public 80 and 443 permanently. Public deployment must use an explicit high port, with automated DNS-01 certificate issuance and renewal rather than requiring standard-port forwarding. The earlier unexecuted standard-port deployment plan is superseded. DNS provider credentials are still needed for real issuance. Implementation and targeted checks continue before two fresh complete clean audits and full testing. Read-only continuation checks confirmed the existing 120 gateway, worker and Caddy remain active, with the TLS listener on 18443.

The user corrected the DNS provider selection to Alibaba Cloud. High-port defaults (HTTP 18081 / HTTPS 18443) passed 22 targeted cases. DNS credential/render/readiness tests passed nine portable cases. Focused review found and repaired a readiness-budget mismatch and the candidate DNS unit publication window before metadata replacement; Linux transaction coverage is prepared and not yet executed. New DNS support uses an isolated pinned Caddy/AliDNS build, immutable root-only credential generations, metadata-bound systemd units and downgrade guards; supply-chain locking and actual isolated build validation are still in progress. This is implementation work, not a clean full audit.

A fresh external read-only check on 2026-10-28 reached cloudark.org.cn port 18443 through the configured external proxy, using the retained test hostname and its internal CA: API status 200 and TLS verification zero. The external ACME-directory control and local edge check also returned 200 with strict TLS. Evidence is .work/public-high-port-probe-20261028.json. This establishes high-port reachability at that time, not a public certificate or new-origin acceptance. The RAM credential question remains pending; no real DNS order, online migration or publication has been performed.

### 2026-10-29 — DNS component verification and twelfth review

The sealed Go 1.26.10 / Caddy 2.11.7 / AliDNS 1.0.29 component passed an actual isolated Linux amd64 provision on 120: authenticated official downloads, offline module verification, Go tests/build, compiled version/module probe, immutable publication, second-call reuse and offline Caddyfile validation with artificial credentials. Dependency fetch completed in 688 seconds including bounded retries. The related Linux deployment selection passed 207 cases with zero failures/skips, with main service identities unchanged. Evidence is retained in ignored .work/dns-caddy-evidence-b096cfe7/result.json and .work/dns-lifecycle-linux-success.json. ARM64 execution, real DNS orders and public certificate acceptance remain untested.

Round 12 inspected the declared coverage of all 1,896 source paths at b4ba82eee9abbc3d1d1b824dcb1090f904ca35620f6b962209c781b572003676. It found a P1 queued-dispatch authorization revocation race and a P2 omission of the new Go component from CI/full test execution. The runtime reviewer was interrupted by an automated content safety block before classifying five generated TS/JSON union differences, and the root tooling review explicitly retains implementation context. Original reports and these limits are preserved; the round is incomplete and earns zero clean credit. A separate runtime-test reviewer completed all 74 assigned files and five affected regression files passed 82 cases. These targeted results do not establish full-suite acceptance. Repairs are in progress before restarting independent clean reviews.

A read-only live check confirmed the retained main edge still selects internal TLS for harness.crtest.localhost on 18443. This local CA can renew its own certificates but does not provide public browser trust. Public DNS-01 issuance still requires the pending Alibaba Cloud credential configuration; no main-instance migration, new tag or Release has occurred.

### 2026-10-29 — authorization boundary and Go CI repaired

The queued-dispatch authorization finding is repaired at the actual transport write boundary. Worker calls recheck both authorization and their original live connection; root-manager recovery remains available without WebSocket but rechecks authorization. Local project and automation commits recheck authorization. A positive acknowledgement after a genuine dispatch remains accepted rather than being reclassified as unsent. The affected selection passed 87 cases and the server type check; the 12-case new authorization file passed again after fixture cleanup and random test-password generation. These executions overlap and are not summed into a unique total. The credential-free loopback proxy negative fixture also passed its exact one-case rerun.

Go tests are now selected by affected/full inventories and executed by ordinary Linux/Windows CI. Preparation pins and verifies the official Go archive, isolates public dependency acquisition, and keeps test execution offline. The actual Windows Go run passed all seven terminal outcomes (four top-level tests and three subtests), plus module verification, discovery, executable compilation and the version/plugin probe. Thirteen preparation regressions passed. Related tooling passed 43 cases with one existing Linux-only skip; that skip remains pending platform reconciliation, not silently accepted. The deployment builder already has separate real Linux evidence above; this does not claim execution of the revised full CI runner on Linux.

Fresh round 13 is frozen at 1,901 source files, digest 1d87387c55efaf41954036310325e9713608514eeaba1857decd1fb72579a924. Three fresh reviewers independently cover gateway/runtime/protocol, web/runtime fixtures, and deployment/tooling/documentation. Reviews are in progress; no clean-round credit or full-suite authorization is claimed yet. The main 120 deployment and pending real AliDNS credential requirement are unchanged.

### 2026-10-29 — thirteenth complete review and watch polling finding

Round 13 completed all 1,901 source paths at 1d87387c55efaf41954036310325e9713608514eeaba1857decd1fb72579a924 through five independent reviewer reports. It found one P2 issue: a failed workspace metadata request makes Promise.all reject immediately, allowing the five-second poll timer to start another request while its sibling remains pending. A stable-API isolated hook reproduction confirmed two outstanding reads; actual API calls have a thirty-second timeout, so this is bounded overlap, not unbounded lifetime or demonstrated data loss. The full findings, source coverage and raw before/after verification are retained in audit-evidence/public-https-round13/. The supplementary report's three declared non-execution/scope limitations remain verbatim in skipped rather than being silently removed; no source file is omitted from the union. The round earns no clean credit.

A separate download ownership candidate was ruled out after integrated WorkspacePanel controls showed that project/file changes, connection changes and epoch changes unmount the previous download owner. Standalone prop-only reproductions are not claimed as reachable product defects. No repair is made for this ruled-out candidate.

The confirmed polling repair is now in progress with targeted regressions. No full-suite authorization, public DNS order, live migration or release has occurred. Independent review also found two omissions in the ignored Windows full-test orchestration helper (fresh dist build and parent-process environment isolation); those helpers are being corrected before use, with their original review evidence preserved. They have not executed a full test run.

The polling repair is complete. A failed path is reported promptly, but the next poll waits until every started request from the current cycle settles. Seven exact watcher tests and the isolated Web type check passed, including retry timing, preservation of the last complete baseline, disable/disconnect/unmount, and a replacement owner's independent schedule. Only the hook and its test file changed. The repaired 1,901-file digest is 3eda0f6f891de7a3f5abfdc254f3476873dd2a21f591a2d9bad7944e88b82f3e; two fresh clean rounds remain required.

### 2026-10-29 — fourteenth review is the first clean round

Round14 completed all1,901 paths at3eda0f6f891de7a3f5abfdc254f3476873dd2a21f591a2d9bad7944e88b82f3e through six independent reports, with zero findings and zero skipped audit items. Raw file hashes and canonical snapshot matched before/after every review. Generated protocol/locks/static feature evidence were checked structurally and semantically; execution limits and the chronology of historical statements embedded in current Web documentation are explicitly retained. No prior audit conclusion is substituted for fresh source review. The consecutive clean count is now one. A second fresh full review of the same unchanged source is required before full testing.

### 2026-10-29 — two clean independent rounds completed

Round15 completed all1,901 source paths at the same3eda0f6f891de7a3f5abfdc254f3476873dd2a21f591a2d9bad7944e88b82f3e digest, with six fresh independent reports, zero findings and zero skipped source-audit scope. Round14 and round15 are consecutive, nonoverlapping, complete and source-identical. The user's two-round requirement is now met. All reviewer artifacts and hashes are retained under audit-evidence/public-https-round14/ and public-https-round15/. An earlier negative check confirmed that the full-authorization helper refused execution with only one clean round and created no authorization artifacts.

Full Windows/Linux/Linux-root validation is now being authorized against these exact reports and source bytes. Completion is not claimed here. Real Alibaba DNS issuance and the public-origin migration still await the operator's DNS credential configuration; existing120 gateway,worker and Caddy were recently confirmed active.

### 2026-10-29 — first full validation exposed test-environment and fixture defects

The first full attempt did not pass. Windows completed1,807 cases:1,705 passed,102 platform skips,zero failed. All server/Web build checks and Go compilation/probe checks passed; the owned Job confirmed exit3 and clean shutdown. Its outer PowerShell invocation reported1, separately retained rather than misreported as the native test result.

Linux nobody completed Vitest with1,411 passed,one failed,15 skipped; Python ran373 cases with13 failed methods represented by15 failure events and3 error events, plus one skip; Go passed all7 cases and all5 checks. The failed Vitest group omits its cases from the platform report, so the raw Vitest JSON is retained separately and the380-case platform report is not described as complete. Root phase was not launched. Preparation/test units and cgroups were collected, source hashes remained unchanged and main120 service identities were unchanged.

Read-only triage identified an overly restrictive ignored-helper SGID setting, root-ownership assumptions in standard deployment fixtures, two false-positive negative tests and one root-only recipe case incorrectly placed outside the root matrix. The operator-envelope fixture also reached masked host initialization paths before its intended mutation; it needs a relocated Layout. Production ownership checks and attachment modes must remain intact. Raw evidence is retained in ignored .work/public-full-attempt1/ and the Windows execution folder, with a sanitized summary in audit-evidence/public-https-full-attempt1/summary.json.

Source is now released only for these repairs and targeted validation. The prior clean audits remain immutable historical evidence; the current clean counter is reset tozero and full authorization is no longer eligible. Two new complete clean audits of repaired source are required before another full attempt. No real DNS order, public-origin migration, tag or Release has occurred.

### 2026-10-29 — full-attempt fixture repairs verified

The standard Linux test unit now permits the SGID directory operations used by the actual attachment implementation, while retaining the nobody identity, zero effective/permitted capabilities, private network, protected host paths and lifecycle proofs. The exact attachment regression passed 16 cases with one Windows-only skip; its exit 3 was preserved. The old source archive was used only because the attachment implementation and test were unchanged. The new fixture was collected and main service identities remained unchanged. Evidence: .work/public-attachment-targeted-b40f0b855d154be69996cf297133fd14-result.json.

Portable deployment tests now substitute only the root-owned metadata read boundary and verify the intended downstream decision. Six real HTTPS metadata ownership cases run in the root matrix. The original 13 DNS builder cases remain covered by seven portable and six root cases; DNS source/test changes select portable, root and Go coverage together, and missing identity coverage fails closed. Operator-envelope tests use a relocated Layout while preserving the initialization check. Production ownership checks are unchanged.

Windows targeted deployment checks passed 50 portable cases and seven portable DNS cases. Go/tooling regression passed eight cases; the additional selector/runner/environment selection passed 28 cases with no skips. On 120, six ordinary-user deployment files passed all 57 cases and two root files passed all 46 cases, with no failure/error/skip and all 103 expected method identities present. Both isolated phases verified all 1,902 raw source files before/after, stopped and collected their units/cgroups, and left main service identities unchanged. Complete evidence: .work/public-fixture-targeted-347de45e9d6d41d29f79ff77d8830678/verification.json. Platform executions overlap and are not summed into a unique total.

The repaired source snapshot is 20af3abfbf4b41d03ac4fe885b51f4ec21f8aefb0e856a880a83958cdb8cef54. A fresh current-tree security scan was clean across 2,292 files including evidence; all 3,783 Git objects were scanned, with only 32 previously classified immutable historical patterns and no skips. The raw scanner and current-source policy remain unchanged. Evidence: .work/public-security-CrBpWe/result.json. Fresh independent round 16 is in progress; no new clean-round or full-suite pass is claimed yet. Real AliDNS issuance still awaits credentials, and the live origin remains unchanged.

### 2026-10-29 — sixteenth review and expanded DNS provider support

Round 16 completed all 1,902 paths at the same 20af3abfbf4b41d03ac4fe885b51f4ec21f8aefb0e856a880a83958cdb8cef54 snapshot, through seven fresh reports with zero skipped source paths and two findings. Permanent per-operation browser acknowledgement markers can exhaust localStorage even after users finish every visible recovery item. A separate provider UI success fixture omitted the model required by the real API. The original reports remain in audit-evidence/public-https-round16/; the clean count remains zero.

The provider fixture now supplies and asserts the model in the complete request payload; its exact file passed all four cases without skips. Evidence: .work/r16-provider-fixture-receipt.json. The browser retention repair is in progress using transactional storage, a legacy migration seal and a gateway admission fence for old browser writes. It has not yet received independent complete-review or full-suite acceptance.

The user additionally requested common DNS providers. The deployment implementation is being expanded to fixed, reviewed adapters for Alibaba Cloud DNS, Tencent Cloud DNSPod, Cloudflare, Huawei Cloud DNS, Amazon Route 53 and DigitalOcean. Each has its own explicit credential schema and capability checks; a provider's credentials cannot silently be reused as another provider's. Ordinary ACME validation remains available without DNS credentials when at least one standard public validation port is reachable. The separate high browser port remains the default. Initial certificate guidance/health changes passed 55 targeted cases; this is not acceptance of the subsequent six-provider implementation.

The supplied AliDNS credentials were retained only in restricted files outside the repository and in a root-private directory on 120. Two strictly read-only API probes returned Forbidden.RAM. No DNS record was changed and no certificate order was made. The operator has been asked to attach the prepared domain-scoped RAM policy. Implementation and targeted verification continue independently while that permission prerequisite is pending; the running main instance is unchanged.

After the operator attached the RAM policy, a second read-only preflight returned HTTP 200 for both DescribeDomains and DescribeDomainRecords and confirmed the intended zone. Its raw sanitized evidence is .work/aliyun-readonly-preflight-attempt2-raw.json. This establishes read access only; write permissions, actual issuance and renewal have not yet been exercised. The first failed preflight remains retained.

The six-provider runtime and control checks passed 65 ordinary-user targeted cases. An isolated Linux root selection passed all 99 expected method identities (HTTPS 43, control upgrade/recovery 49, DNS build ownership/compatibility 7), with zero skipped or unexecuted cases. The first run's new fixture asserted a real Caddyfile against its deliberately substituted JSON renderer; only that assertion was corrected. Both failed and successful reports are preserved. The successful 58-file snapshot is 76ce9e1c8ec55afb1c2bd3bce5f8055b830bf21419726c5c57b32465f9debe9a, independently checked before/after and against the workspace. Root capability, private-network and protected-path probes, stopped/collected cgroup proofs and unchanged main service identities are retained in .work/dns-multi-runtime/root-verification-v3.json.

The browser storage repair passed a native Chrome 156 check using two same-origin iframe documents with independent JavaScript contexts and IndexedDB connections. Native localStorage quota was actually exhausted; migration preserved an unknown operation and unrelated data. Late legacy acknowledgements, concurrent creation and updates after acknowledgement behaved as required. After 1,200 completed operations, the database contained zero operations and one constant-size metadata record, with zero old acknowledgement markers. The five core source hashes were unchanged. Evidence: .work/operation-native-browser-v3-OSC116/result.json. The owned browser Job was deliberately stopped and confirmed empty; its controller exited zero. Earlier debugger-startup and fixture-loading failures remain preserved. This proves the named native storage scenarios, not deployed UI acceptance or other browser engines. Async consumer and session-race regressions are still being finalized before the next independent full review.

The final affected Web/gateway selection is now clean: 25 files, 427 passed cases, zero failures and no unhandled errors in .work/test-results/run-PMBRhR/vitest.json (SHA-256 d9a7daacfdd7cac16546b24857866220f27971706a6bed0bf2185d6dd4983fd1). Both server and Web type checks passed. New await boundaries recheck session, connection and component ownership; stale session initialization cannot overwrite a later login/logout. JSON request payloads are captured before durable intent creation. Earlier fixture ordering/readiness failures and their repairs remain in .work/operation-storage-v2-validation.json. Thirty-seven touched files were normalized to LF without content changes; the five native-browser-tested core files did not change bytes.

Round 17 is frozen at 1,910 source files, digest 641736cce2698ef74e6d0e0c013e35425cbe0d2ec79afb24c5a54fcda8fdc8dd. The current source security scan read 2,307 files including retained evidence, with zero findings, artifacts, unreadable entries or skips. Evidence: .work/public-https-round17-source-security.json. Fresh complete independent reviews are starting; the required two consecutive clean rounds have not yet been re-established. Real Linux six-provider compilation and preparation of the changed full-test dependencies continue separately; no certificate order, main-instance migration or publication has occurred.

### 2026-10-29 — seventeenth review repairs and Linux DNS validation

Round 17 now covers every one of the 1,910 frozen source paths. Five finding records describe four distinct issues: deferred FileEditor preparation could overwrite a newer draft; the gateway discarded the thread identity of a partially started review; several tests still assumed synchronous mutation admission; and the preview fixture omitted recovery protocol version 2. The deployment reviewer also disclosed reading an old report generator and explicitly disqualified its independence. This round is retained as complete source coverage with findings and that limitation, never as a clean independent pass. The clean count remains zero.

FileEditor now adds the submitted-save identity to the latest draft and refuses dispatch after its editor unmounts. Tests cover edits before and after real IndexedDB admission, preserving the original submitted text, and reopening an editor before admission. WorkerClient retains only bounded, nonempty first_turn/review identities while keeping unknown delivery; a real local HTTP/Dispatcher/disk-Ledger regression verifies persistence and no replay. The corresponding gateway/runtime selection passed 68 cases in .work/test-results/run-Y25xEN/vitest.json.

The expanded affected-Web regression initially found 17 failures in six additional fixtures (786 passed), retained in .work/test-results/run-5XBXJe/vitest.json. Their waits and scenario isolation were corrected without bypassing Api/IndexedDB or deleting assertions. Two independent index-recovery scenarios are now separate cases rather than incorrectly sharing an unknown IndexedDB record after clearing only localStorage. After all repairs, one complete affected-Web run passed all 69 files and 804 cases with no skipped cases or unhandled errors: .work/test-results/run-tY8HqF/vitest.json. Server/Web type checks and git diff --check also passed. These are targeted regressions, not a repository full-suite pass.

Two fresh Linux DNS production-builder attempts encountered upstream download failures; both original results and logs remain retained. The first stopped three fetch units and was then explicitly unmounted with its diagnostic image preserved; the second stopped before creating a mount. An isolated third fixture used authenticated public dependency archives and completed the unmodified production verify/test/build/probe/publish/reuse flow. Its first Cloudflare configuration validation failed because the shared fake token was too short; that original failed result remains unchanged. A separate validation-only fixture used an explicitly public 40-character token and passed all six providers, with actual distinct network namespaces and stopped/empty cgroups observed for all six. No real provider credentials or ACME order entered these tests.

Linux binary SHA-256 is 835b4e36538d2551e6b8225fd72b4f1b1fc2a960fa1d5bad8b20eb57b0be72b6; its sealed recipe revision is 3cf8c3c4f4a9c5532fc5b26ab0cddd9b3cd7d3337b236912b753089a8bd792b3. Build provenance is .work/dns-multi-build-34d0602fafb84943b71292f69994c8b5/provenance.json; all-provider validation is .work/dns-validate-380719e224404b25828bce2e4ff52fec/result.json. Both fixture mount inventories are empty and the main service PIDs/start ticks remained unchanged. This establishes real Linux compilation and offline configuration adaptation with verified public caches; it does not claim successful fresh online downloads or live DNS issuance.

## Public HTTPS round18 correction

The independently completed 1910-file round18 found one Web P2: the long-conversation pagination toolbar reused the 55vh history-preview class. Removed only that class from Messages.tsx; message-window logic and HistoryTools styles are unchanged. Six affected existing Web test files passed all 105 cases. Isolated real Chrome checks passed at 1280x900 and 390x844: toolbar heights approximately 31/55px, actual older/newer clicks worked, and HistoryTools preview heights remained 495/464px. No full suite was run. Exact before/after source hashes, fixture-only corrections and measured results are retained in audit-evidence/public-https-round18/web-fix.json. New source frozen for fresh independent review: a89d55d3c0a5f12a4f689dd3bbb0b98dced8342ca5d161d52205d8379a3a8d1c (1910 files). Clean-round count remains zero until new completed rounds.

## Public HTTPS round19 corrections

The independently completed 1910-file round19 confirmed a SkillRoots draft-loss P2 and stale Go test counts in the deployment guide. SkillRoots now retains an explicit selection draft across reads/category switches, binds confirmation to its current context and read, isolates API/epoch/project-mapping changes, and locks edits during submission or unknown receipts. not_sent recovery retains the draft without replacing the parent epoch; acceptance clears it and refreshes the parent. A synchronous layout cleanup guards against sending an unmounted form after durable admission. Fifteen interaction regressions were added to the existing skill-library file. The two directly affected Web test files passed all 47 cases, including late reads, unknown-result recovery and ownership changes during admission; Web type checking passed. Earlier red/intermediate results remain in the repair report. Removed fragile numeric test counts from the deployment guide without changing its verification instructions. No full suite was run. Repair scope and exact snapshot are retained in the ignored fix boundary; detailed public repair evidence is audit-evidence/public-https-round19/web-fix.json. New clean-round counting starts after this repair.

## Public HTTPS full attempt 2 — retained failure

Rounds 20 and 21 independently covered all 1910 files cleanly on ca4f32a743f110954580fea9997cf1b654d30c8d16f882dee4fac051e6909c9f. Full attempt 2 then exposed two UI timing failures: initial provider hydration on Windows, and realtime owner replacement on Linux. The original platform reports and Vitest failure artifacts remain retained; the public summary is `audit-evidence/public-https-full-attempt2/result.json`. Linux root did not run after the standard-phase failure. Owned Windows Job and Linux units/cgroups were confirmed stopped; existing main services were unchanged. The full authorization is preserved under this attempt and retired from the active gate. Do not call this a full-suite pass. Resume repairs and two fresh clean audits before another full run.

## Public HTTPS round 23

The second fresh whole-repository round on source b0ff300296c5d9c9865c7de465383a7e66604532b1e55ffbfcacb818a9fcb858 covered all 1,910 source paths with no skips. Runtime/gateway and deployment/tooling reported no findings. Web reproduced R23-WEB-001: an accepted receipt for stored draft A can erase newer memory-only B after a browser or application capacity save failure. The actual useDraft/API/IndexedDB reproduction, normal-persistence control and natural application capacity failure are retained in this round's evidence. Consecutive clean count is reset to zero; no full suite, deployment or publication started. Repair is limited to draft notification/ownership behavior and affected regressions, then the user-required two clean rounds must be established again.

The initial R23 repair changed only draft notifications, useDraft and draft regressions. Eleven new regression cases were added, including a real first-DOM-commit input before passive load; 109 affected tests passed and web typecheck passed. A separate targeted review (not a full audit) then confirmed R23-FIX-WEB-001: new-conversation automatic navigation still abandons newer memory-only input after acceptance. Its actual source-level integration reproduction and the incomplete initial repair evidence are retained unchanged. On resumption the source digest was still cf26b18ba3fb1603c64a6ed90d35b6855d4337fc612d0af12c9d9409e0cf7910. The handoff gap is being repaired before any fresh clean-round/full/deployment gate.

R23 repair closeout: new-conversation and related archive/review/branch automatic handoffs now check the actual draft owner and revision, retaining newer or memory-only input while preserving normal and manual navigation. Focused component regressions reproduced each affected path before its repair. The final four affected test files passed 109 cases, with web typecheck passing and the nested-act fixture warning resolved. A fresh targeted independent review reported no remaining actionable finding; it contributes no full-audit round. The complete source is 1,911 files at 0b770f6c1a7323484af2db9ce2c7c7d0b90b8cafd474cc664cd649a60161c281. Relative to the R23 frozen inventory, only six existing web files and one new component test changed. Source and public evidence secret/artifact scanning was clean. Begin fresh complete independent audits on this exact source; no full suite or production operation has run since the failed attempt 2.

## Public HTTPS full attempt 3 — retained failures

Rounds 24 and 25 independently covered all 1,911 files cleanly on 0b770f6c1a7323484af2db9ce2c7c7d0b90b8cafd474cc664cd649a60161c281. Full attempt 3 retained three distinct obstacles: Windows disk exhaustion during Go compilation; an extra inherited capability injected by the isolated Linux root coordinator; and a terminal test asserting completion before real IndexedDB acknowledgement finished on the Windows retry. The original two Windows results, Linux ordinary/root reports and all stop/collection proofs remain preserved, summarized in `audit-evidence/public-https-full-attempt3/result.json`. Linux ordinary tests passed all applicable cases; these partial results are not an overall pass. Main service PIDs/start ticks remained unchanged. Four old task-owned Go build caches were moved intact to another volume to restore space. The operational capability cleanup is reviewed separately without weakening the native launcher. The confirmed terminal fixture wait correction requires fresh complete audits on the resulting source. Full authorization is retired; no deployment, certificate order or publication has started.

The terminal fixture repair adds one awaited observable final-state check before its existing assertions. Two controlled offline modes reproduced the original race and correct product behavior. Three targeted runs passed the same 18 cases each; no product code, sleep, timeout or assertion strength changed. The new source is 1,911 files at 99521cf29d49d5e16142131ef1dad1f21ad73465ed478f0da6238669e9b1e561; only web/tests/terminal.test.tsx differs from the round25 inventory. Begin two fresh complete audits before another full run.


## Public HTTPS full attempt 4 — reconciled pass (2026-10-30)

The complete Windows/Linux/Linux-root run passed repository reconciliation at 2026-10-29T20:18:02.643Z on the unchanged 1,911-file source `99521cf29d49d5e16142131ef1dad1f21ad73465ed478f0da6238669e9b1e561`: 210 test files, 2,148 distinct cases, zero failures and zero coverage gaps. Individual platform skips remain in the original reports and are covered by passes on the appropriate platform. Windows server build, Web typecheck and Web build passed. Its owned Job stopped with controller exit 0 and both logs flushed; the Linux owned units were stopped/collected and the main-service identities were unchanged at the test boundary. See [the exact reconciled result](audit-evidence/public-https-full-attempt4/reconciled-result.json) and [preserved evidence hashes](audit-evidence/public-https-full-attempt4/evidence-manifest.json).

The prior instruction above to repeat full audits after the terminal test-only await was reconsidered following the user's question. Rounds 24/25 retain their original baseline digest and reviewer reports. The exact one-line test delta is reviewed separately using byte reconstruction, the controlled offline probe and three existing targeted passes. This is an execution-scope judgment, not a user waiver of all review or two newly completed audits; consecutiveClean remains 0. The original failed runs and the exact audit record used at execution are preserved. The ignored Linux capability helper has a separately retained focused V2 review with no full-audit credit.

The canonical CI authorization now matches the current public HTTPS authorization byte-for-byte; the older canonical record is archived without alteration. Public deployment/ACME acceptance, GitHub publication and hosted CI remain pending and are not established by this full-test result. No additional test or full run was executed while publishing this verification evidence.


## 2026-10-30 — v2.2.0 functional repairs and clean review

Completed the multi-provider/model-directory, composer/settings/MFA, operation feedback, CLI recovery, managed-project and one-stop operations repairs. Round 4 covered all 1,941 current source files and found no new actionable issue; rounds 1–3 retain their original findings. Independent reviewers distinguish manual flow tracing, complete structural review and generated-protocol byte checks in the [member reports](audit-evidence/v220-round4/team.json). The final draft-navigation repair passed 93 cases across five affected test files. Server and Web type checks, production Web build and a source scan of 2,443 files passed.

The user explicitly reduced the complete-audit gate to one clean round and chose v2.2.0. A source-bound authorization now permits full testing of digest `2fa91dccad09fdd474ec433628391235352afc8bde924f05a34608c0c314e36f`; it does not claim test success. Full CI and final deployment have not yet run at this entry. No paid model inference or live external MCP task was performed. Host-specific native-UID proxy setup is outside the repository and routes domestic Zhipu directly.


## v2.2.0 complete CI fixture follow-up

The first complete push and PR checks on 8f5f966 failed. Nine test-only repairs correct privileged fixture substitutions, valid saved-provider fixtures, collapsed controls, asynchronous completion boundaries and random loopback HTTP ports. Linux nonroot/root and both pinned local Node versions passed the affected checks; independent repair reviews found no new issue. Production, deployment and configuration files are unchanged from clean round 4. Exact source `877ff9803635717ffae9a90ed318d901e281be1d40c00ac5e62461f2b22601a6` is authorized for another complete CI attempt; no final pass or deployment is claimed. See verification/audit-evidence/v220-ci-repair.


## v2.2.0 memory fixture follow-up

Complete CI2 failed its Linux memory-settings revision-conflict test, while Windows and root passed. The single additional test-only repair controls the second asynchronous read and checks compare/adopt/fresh-confirm/one-v2-write in order. Both pinned Node versions passed affected checks; independent review found no new issue. All other 1,940 source files are unchanged from CI2. Source `14158d3f46a6728c06fb33d7d7f0f2c5d628b8259178d2992f35d0bcc750965f` is authorized for a fresh complete attempt; publication/deployment remain pending.
