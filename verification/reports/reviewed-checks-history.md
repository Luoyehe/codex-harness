# Reviewed checks 历史失败复盘

本次以 GitHub 原始运行清单、完整失败日志和保留的修复记录交叉核查，补齐早期未集中记录的失败。检查基点是 `f3909bbce01ab5d311dc3754377059d1b01acbed`；不是重新执行历史测试，也不是新的全项目产品审计。

## 范围和计数

[同一工作流](https://github.com/Luoyehe/codex-harness/actions/workflows/affected.yml)（ID `396386315`，最初名为 **Affected checks**）现有第 1–59 次运行全部纳入：**26 次失败、3 次取消、30 次成功**。所有记录的 attempt 都是 1。每次失败、取消均核对完整 job 清单；成功记录用于核对清单与后续验证范围，没有重新逐份审计所有成功日志。

这里的 26 是运行次数，不是独立 bug 数。同一提交的 push/PR、主分支/标签曾重复触发；上游失败也会使上传或覆盖汇总继续报红。取消另列，不算测试通过，也不推断是谁取消的。已经删除的运行无法由现有 API 重建；单独的 Security/Compatibility 工作流、仅本地失败和部署故障不混入此统计。

[完整机器清单](../audit-evidence/reviewed-checks-history/inventory.json)记录每次 run/head/event/attempt、29 次非成功运行的所有 job/step 及复盘映射。原始日志与制品保留在忽略目录，其文件和 ZIP 成员哈希绑定在[下载清单](../audit-evidence/reviewed-checks-history/raw-evidence-manifest.json)及分段报告中；公开归档不包含原始日志、凭据或临时下载链接。新克隆不能凭这些哈希读到本机忽略文件，仍需 GitHub 保留的原日志。

## 每次失败发生了什么

表中是主因摘要；每个失败断言、证据强度、为何漏查、具体修复、定向结果和后续验证范围见对应 JSON。对调度或崩溃原因没有直接证据时，后来的绿色运行只证明未再出现，不能倒推原因为已证实。

### 初始发布至 v2.0.1：9 次

详见[前置门禁](../audit-evidence/reviewed-checks-history/early-gates.json)和[早期平台失败](../audit-evidence/reviewed-checks-history/early-platforms.json)。

| 失败运行 / 提交 | 原因与经验 |
| --- | --- |
| [40232786765](https://github.com/Luoyehe/codex-harness/actions/runs/40232786765) · `2672e97bfe1d` | 大规模重写触发全量审查要求，旧 affected-only 流程没有相应授权执行路径；选择阶段退出 2，尚未测试。原计划被重定向且未上传，具体首个拒绝映射不保留。补全明确基点、完整审查授权及计划输出。 |
| [40232786814](https://github.com/Luoyehe/codex-harness/actions/runs/40232786814) · 同提交、标签 | 新标签的 before SHA 全为零，不能作为变更基点。现流程不由标签触发；新 ref/manual 需要明确的非零基点或有效的源代码绑定授权，不能偷用 HEAD~1。 |
| [40298008326](https://github.com/Luoyehe/codex-harness/actions/runs/40298008326) · `e1c232eb6e73` | 当前源码扫描通过，但完整 Git 对象扫描发现 32 项历史模式匹配，尚无逐对象语义审查记录。门禁正确阻止发布；保留对象级审查，不能全局忽略测试或历史。历史内容分类沿用保留记录，本轮未重新读取旧实现。 |
| [40299290026](https://github.com/Luoyehe/codex-harness/actions/runs/40299290026) · `dbabbdb7319c` | 首次历史分类覆盖范围比远端完整 refs 窄，扫描仍拒绝。后续按全部分支/标签的不可变对象补分类；原日志不足以确定第一个新增匹配项。当前源码干净不等于完整 Git 历史审查已完成。 |
| [40300576409](https://github.com/Luoyehe/codex-harness/actions/runs/40300576409) · `a3ec164b7c4c` | Windows Git Bash 选中的 GNU tar 把绝对路径盘符当远程主机，报 `Cannot connect to D: resolve failed`。改为经验证的归档文件名配合 cwd；缺少平台制品、覆盖汇总失败是连带结果。 |
| [40302433930](https://github.com/Luoyehe/codex-harness/actions/runs/40302433930) · `9a2e43e70105` | 同时暴露 Windows PowerShell 启动、Linux HTTP 管线连接清理、Guardian 按键时序、依赖默认时区的 UI 夹具，以及降权账号无法导入控制代码、root 在普通账号 checkout 中生成报告被 Git ownership 拒绝。必须区分产品生命周期缺口、夹具前提和证据生成失败。首轮每个 Windows 超时内部原因及 Guardian 的精确阶段并非全部可证。 |
| [40305525588](https://github.com/Luoyehe/codex-harness/actions/runs/40305525588) · `35f2bc280703` | Windows 四项控制器预检超时，Linux HTTP 管线测试仍失败；前次只调整 HTTP 夹具并未解决真实资源生命周期问题。不能把局部修复当完整闭环；本次与下一次运行的计划均为同基点的 169 文件全量。 |
| [40305525963](https://github.com/Luoyehe/codex-harness/actions/runs/40305525963) · 同提交、main | 与上一运行重复触发相同失败族。后续 HTTP 修复监听原 request transport，结清没有分配 socket 的排队 response；Windows 显式导入系统内置模块，保留隔离而不恢复无界自动发现。 |
| [40308175474](https://github.com/Luoyehe/codex-harness/actions/runs/40308175474) · `7af7dafb5d34` | Windows/root 已通过，Linux 剩 Guardian 激活键保护窗口与设置页独立 requirements/read 尚未完成。夹具遵循真实 CLI 按键协议，并分别控制 settings/requirements 两种完成顺序。该 Windows job 内旧/新模块引导的对照直接支持修复机制，不需猜测 Node 版本是根因。 |

早期真实修复还包括：使用可供降权账号访问的隔离控制目录、root 自有的一次性 checkout，保留真实权限边界；时区测试显式设置两个不同值，不假定运行器时区。后续 [40309851137](https://github.com/Luoyehe/codex-harness/actions/runs/40309851137) 完成当时 v2.0.1 的实际全量验证；原失败均保持失败。

### v2.1.1 / v2.2.0：10 次

逐项证据、修复和后续成功范围见[中期复盘](../audit-evidence/reviewed-checks-history/v211-v220.json)。

| 失败运行 / 提交 | 原因与经验 |
| --- | --- |
| [40955613895](https://github.com/Luoyehe/codex-harness/actions/runs/40955613895) · `363b5aa4daa1` | Linux 自动化夹具在独立操作记录读取释放保存锁前点击 Save，预期两次写入实际一次；使用真实启用状态和受控读取。Windows 仅能确定 Go 准备的 `mod` 命令族失败，底层原因仍未知；后续补精确阶段、退出码及有界诊断，不能写成已证明网络故障。 |
| [40959593986](https://github.com/Luoyehe/codex-harness/actions/runs/40959593986) · `10356ef43231` | Windows OpenSSL 不接受用 `x509 -days -1` 制造过期证书。改为有序的过去起止时间，并验证真实 TLS 握手明确返回证书过期错误；保留安全断言。 |
| [41019301457](https://github.com/Luoyehe/codex-harness/actions/runs/41019301457) · `8f5f96636440` | 折叠设置未打开、普通账号夹具误触 root 所有权门禁、mock chown 而实际调用 fchown、保存配置缺 kind、预览同意状态尚未就绪；另有 Windows worker `0xC0000409`，没有 dump 可定因。补实际 UI/域模型/权限前提及平台对照。 |
| [41020016075](https://github.com/Luoyehe/codex-harness/actions/runs/41020016075) · 同提交、PR | 重复出现上述输入/权限/配置夹具问题；还把“总记录数已增加”当作“完成记录已持久化”，操作完成计数断言过早。以实际完成结果为准。 |
| [41048935437](https://github.com/Luoyehe/codex-harness/actions/runs/41048935437) · `b09836245bc2` | 内存设置冲突文字先于第二次配置读取及重置 effect 完成；夹具尚未完成采用新版和重新确认。显式控制第二次读取，再检查版本、启用状态及唯一写入。 |
| [41050526424](https://github.com/Luoyehe/codex-harness/actions/runs/41050526424) · `adfefc0cd53e` | 检查证实非原子原生历史与已知 live turn/lifecycle 可不一致，存在真实历史完整性缺口；补身份、生命周期版本和不确定状态约束。确定性回归证明缺口，未捕获原 hosted 精确交错，不能声称唯一根因已重现。 |
| [41056493419](https://github.com/Luoyehe/codex-harness/actions/runs/41056493419) · `6052085f095b` | 再次 Windows 原生 worker 崩溃，缺 dump/调用栈，具体原因未知。CI Node 与已固定的部署版本对齐，后续验证通过；不能把上游存在 Windows TCP 修复当作此崩溃的因果证据。 |
| [41056500121](https://github.com/Luoyehe/codex-harness/actions/runs/41056500121) · 同提交、PR | 额度预览未完成时确认绑定空 hash；已渲染的按钮不代表可提交。受控预览、重新同意、启用状态及一次真实写入均须验证。 |
| [41058861511](https://github.com/Luoyehe/codex-harness/actions/runs/41058861511) · `37881beb7234` | accepted 提示早于真实 IndexedDB accepted 读取发布，旧 unknown 仍正确保持锁。等待真实读取和 Save 启用，再单次点击；同时检查其他正向创建/更新入口。 |
| [41109209531](https://github.com/Luoyehe/codex-harness/actions/runs/41109209531) · `610f929e190e` | 配对、OAuth、项目切换三项 UI 夹具没有完整建立身份读取、同意及真实 mutation 完成前提；部分原调度未可重现。同提交完整 PR 与窄 push 的结果不同，具体调度原因未证实，两者均须保留，不能用一个绿色结果覆盖另一次失败。 |

### v2.3.0 / v2.3.1 / v2.3.2：7 次

逐项证据、范围纠正及后续闭环见[近期复盘](../audit-evidence/reviewed-checks-history/v230-v232.json)，并保留原 [v2.3.0](v230-ci-lessons.md)、[v2.3.1](v231-ci-lessons.md)、[v2.3.2](v232-ci-lessons.md) 记录。

| 失败运行 / 提交 | 原因与经验 |
| --- | --- |
| [41145274221](https://github.com/Luoyehe/codex-harness/actions/runs/41145274221) · `930614562a98` | 私有 Git index 复制改变 mtime，破坏 racy-clean 检测，是产品缺陷；MCP 刷新移除 select 选项导致选择丢失，也是实际 UI 缺口。另有草稿标签、固定执行身份不完整的旧夹具。分别修产品并保留真实回归，不统称测试偶发。 |
| [41287733396](https://github.com/Luoyehe/codex-harness/actions/runs/41287733396) · `ff45dc166c17` | MCP OAuth 新增前置状态读取，gateway 的两层 Native 替身仍返回空对象，且线程测试未先加载。人工定向漏了消费者；补真实响应/线程前提，并扩大 runtime helper 的消费者选测。 |
| [41289149450](https://github.com/Luoyehe/codex-harness/actions/runs/41289149450) · `e5e4454548fb` | Windows 仅按裸 PID 判断原进程存活，且失败路径尚未观察 pending rejection。改用原进程身份并立即挂接拒绝观察；原日志不足以证明确实发生 PID 复用或原进程残留。 |
| [41290757916](https://github.com/Luoyehe/codex-harness/actions/runs/41290757916) · `1c45513e677a` | 相同错误文字对应不同 model/provider/effort 请求代次，夹具点击了被新代次替换的状态。绑定精确参数与受控响应，保留 busy、禁止双击和草稿断言。 |
| [41299562756](https://github.com/Luoyehe/codex-harness/actions/runs/41299562756) · `c923ff9aca26` | 设备登录 closed 提示不代表随后 account refresh 完成；共享模型测试仍期待旧的等待行为。人工选测漏掉中央账户/目录消费者。分别验证各异步阶段和当前 model/effort 身份，未放宽发送准入。 |
| [41316151654](https://github.com/Luoyehe/codex-harness/actions/runs/41316151654) · `b1ffa2517112` | 固定 Codex `-c` 参数进入 Node `-e` 替身而冲突；Windows argv 预期陈旧；会话夹具缺 provider；候选包缺新要求的元数据；普通 UID 事务提前撞上真实所有权门禁。变更生产者必须追踪全部执行器、构造器及语义消费者。 |
| [41318007104](https://github.com/Luoyehe/codex-harness/actions/runs/41318007104) · `a85e69161fec` | 上轮普通安装夹具替换 `release_accounts`，经直接调用 setUp 的组合关系泄漏到 root 账户恢复测试，真实降级读取被替身遮蔽。作者、独审和选测都漏了组合消费者。恢复真实 reader 并把三文件双向关联；不能只搜继承关系。 |

本轮另外取回 41145274221 的原始 Linux/Windows case 制品，哈希与 GitHub 上传摘要一致：Go 两平台各 20/20、五阶段通过，共 20 个不同用例；该运行整体仍失败。报告未提供 stderr 字段，不能推定 stderr 为空。三版最终全量闭环分别是 [41292416084](https://github.com/Luoyehe/codex-harness/actions/runs/41292416084)、[41300607471](https://github.com/Luoyehe/codex-harness/actions/runs/41300607471)、[41319241294](https://github.com/Luoyehe/codex-harness/actions/runs/41319241294)，不会把这些结果写回失败候选。

## 三次取消与容易误读的日志

- [40302281637](https://github.com/Luoyehe/codex-harness/actions/runs/40302281637)：标准作业取消后缺少平台报告，上传/覆盖汇总拒绝；不是已证实的独立产品 bug。
- [40309785986](https://github.com/Luoyehe/codex-harness/actions/runs/40309785986)：标准作业在准备期间取消，覆盖汇总拒绝；同提交后续 manual 完成，不改变这次取消状态。
- [40961314393](https://github.com/Luoyehe/codex-harness/actions/runs/40961314393)：并发运行被替代/取消，未观察到独立失败断言；后续 manual 的 61 文件是当时受影响范围，不是完整产品全量。

故意制造的 empty/broken Python fixture、setUpClass 异常、Windows 旧模块引导对照是检查“失败能否被正确捕获”的负例，不能看到 Traceback/timeout 就计成新的顶层失败。Verified case coverage 拒绝失败、缺失或未完成报告是正确行为，不能为消除红色去放宽它，也不能在汇总未完成时宣称零覆盖缺口。

## 吸收到后续工作的具体规则

1. **先确定实际失败，再改代码。** 保存完整 run/head/attempt/job/step 和原始日志，区分主因、负例输出与连带失败。诊断缺失就保留未知并改善下一次诊断，不以一次绿色重试定因。
2. **从被改变的契约追踪消费者。** 参数、响应字段、目录选项、包元数据、身份和准入改变时，检查调用方、fake、精确 argv、mock 构造和旧版本夹具。先证明测试抵达预期分支，再保留原行为断言；宽泛的“抛异常”不证明抵达目标边界。
3. **共享夹具同时查组合关系。** 除 import/继承，还查直接实例化、setUp、实例方法重绑定、共享 Manager 和 cleanup。普通账号替身不能悄悄带入 root 边界消费者；相关两种真实身份均纳入定向验证。
4. **异步 UI 等实际前提。** 用受控 promise 逐阶段验证身份读取、最新请求代次、预览同意、IndexedDB 发布及 mutation 完成，检查此时按钮是否可用、错误点击是否零写入。不要靠重复文字、任意 sleep、重试或加大超时。
5. **区分工具与运行器环境。** 固定版本仍需检查实际 PATH/工具实现、工作目录所有权、时区、PowerShell 模块引导和真实 UID。CLI 本身的按键保护窗口属于协议前提，不等于为掩盖失败添加任意延迟。
6. **核对实际测试集合。** 本地手工列表、push 差异、PR merge-base 和完整矩阵不是同一范围。先看 files/targets，再陈述结果；同提交窄测与全测不同结果都保留。现已去掉 topic push 与 PR 的重复矩阵，但 main/manual 和独立 Security 仍有各自职责。
7. **失败复盘必须落到下一候选。** 为每个失败原因链接修复、消费者检查、定向验证、未测边界及后续实际 CI。源代码授权、构建哈希、CI、部署和公开发布分别记录；preflight 成功本身不代表测试通过。

## 当前已有防护及仍然存在的边界

[防复发机制核查](../audit-evidence/reviewed-checks-history/prevention.json)逐项列出当前文件/行号、哈希和回归位置。本轮只静态核查这些机制，没有重跑其测试。

已有明确的源代码/构建绑定、基点校验、工具版本核验、普通/root 分离、Windows 控制器预检、精确 case 覆盖拒绝、部分共享夹具双向选测和具体异步回归。它们能减少重复失败，不能证明所有消费者都已自动覆盖。四项边界必须继续显式处理：

| 边界 | 此后必须执行的检查 |
| --- | --- |
| 选测仍是人工映射，不是完整反向依赖图 | 修改共享 fixture 后补查实际消费者。例如 control_update → root config_layer/service_lifecycle；service_lifecycle → candidate_archive；execution_mode → proxy_transaction；journal_schema → journal_recovery。当前映射未完整覆盖这些边，不能只依赖自动列表。 |
| 仅测试文件的修改及手工定向列表，不会自动扩成整个 Web 分区 | 中央账户/模型/会话契约改变时，明确列出集成消费者及未选原因；“生产 Web 变更会选整个分区”不能泛化到所有调用方式。 |
| 发布预检尚未机器强制检查全部失败复盘 | 下一候选人工逐项核对失败运行到证据、修复、复核和验证的对应关系；`repairsReviewed` 字段或报告存在不证明内容已充分审查。 |
| root Python 与标准矩阵 Python 的固定方式不同 | root 使用系统解释器，标准矩阵固定 3.12.10；记录实际身份/版本，不宣称环境完全一致。本轮没有证据把过去某次失败归因于此差异。 |

这些是已记录的覆盖/自动化边界，不冒称本轮已经改完。增加自动依赖闭包或复盘门禁应另做有针对性的实现和验证；本次不为编写复盘而修改运行时代码或重启在线服务。

## 对旧记录的两项范围纠正

- v2.2.0 `hosted-ci11.json` 的 pushReconciliation 保存了实际 **3 文件、76 用例通过**，但 boundary 沿用了 CI10 的失败文字。本次依据实际 API/汇总判为 CI11 选测成功，明确指出陈旧说明，原件不改写。
- v2.3.2 CI1 修复说明对真实 root 账户降级验证的措辞过宽。当时的 112 项定向验证没有运行组合依赖的 AccountRecoveryTests；CI2 正是暴露此漏项。后续三文件分组和真实 root 回归才补上，不能用 CI1 的局部绿色提前声称完整闭环。

今后的入口是 [维护预检](../../scripts/RELEASE-PREFLIGHT.md) 和 `AGENTS.md`，用户 README 继续专注部署和使用。新增失败应追加其独立记录并更新这份索引的范围，保留旧失败和未证实结论。

## v2.3.3 增量：第 61–64 次运行、最终 main 与网页验收修复

本节追加此次发布的结果，不改写此前第 1–59 次复盘的范围和计数。第 60 次不在本节复盘范围内，不能据此声称第 1–64 次已全部重新核查。

| 运行 / 候选 | 实际结果与证据边界 |
| --- | --- |
| [#61 / 41334305304](https://github.com/Luoyehe/codex-harness/actions/runs/41334305304) · `0523873bda28` | **失败，attempt 1。** Linux、Windows 各出现相同的五项 prediction 失败，属于同一个夹具契约遗漏。模拟 Native 没有实现 `thread/items/list`，以 `{}` 代替合法空页，在原有业务断言前被严格分页校验拒绝。Root/Security 通过不改变整体失败，覆盖作业正确拒绝失败平台。保留[原失败证据](../audit-evidence/v233-final/ci1-failure.json)。 |
| [#62 / 41335749136](https://github.com/Luoyehe/codex-harness/actions/runs/41335749136) · `fd3c8c9d780e` | **完整验证通过，attempt 1。** 源 `091ada4bcbd908ca9e25ebe37612cb9b218c4ca574109c1dade30d29ed66829a`：269 文件、3,157 个独立用例、覆盖缺口为零，保留各平台原始跳过和适用平台通过记录。此结果只属于修复启动提示之前的候选。 |
| [#63 / 41336966118](https://github.com/Luoyehe/codex-harness/actions/runs/41336966118) · `fd3c8c9d780e` / main | **运行通过，attempt 1。** main push 的 Linux、Windows、Linux-root 和覆盖作业均成功；独立 Security 运行 `41336966123` 也成功。这里记录真实终态，不将 #62 的独立完整制品核对重新冠名为 main 制品核对。 |
| [#64 / 41337968648](https://github.com/Luoyehe/codex-harness/actions/runs/41337968648) · `424e8f5ab267` | **完整验证通过，attempt 1。** 实际 Linux、Windows、Linux-root 制品及 hosted/local 覆盖核对一致：269 文件、3,160 个独立用例、覆盖缺口为空，各平台跳过仍按原样保留；Security 运行 `41337984727` 通过。见[当前完整 CI 证据](../audit-evidence/v233-final/ci.json)。 该结果绑定源 `15a740ee49afed60d1828287f5cbf3f15d44d652f22f957e8b77f14314092940`，独立于 #62 的旧源统计。 |
| [最终 main / 41339050083](https://github.com/Luoyehe/codex-harness/actions/runs/41339050083) · `424e8f5ab267` | **所需检查通过，attempt 1。** 选择 92 个 Web 文件，Linux、Windows、覆盖作业成功；root 部署夹具按此次差异正确跳过。独立 [Security 41339050092](https://github.com/Luoyehe/codex-harness/actions/runs/41339050092) 通过。[真实 main 终态证据](../audit-evidence/v233-final/main-ci.json) 与 #64 的完整制品核对分开保留，不把本次选测称为全量。 |

#61 的修复仅补上官方空页响应 `{data: [], nextCursor: null, backwardsCursor: null}`，未改生产分页边界、断言、超时或重试。18 个实际历史消费者、186 例定向全部通过。遗漏发生于人工缩小的定向选择，自动选测原本已包含该文件。今后共享历史读取变更必须追踪 `RuntimeService` 的间接消费者，并核对回合、条目和时间线模拟响应；记录文件哈希或只看导入关系不能证明契约兼容。这一经验已写入[维护预检](../../scripts/RELEASE-PREFLIGHT.md)。

随后实际网页验收发现另一项产品缺陷：新 ROOT 标签先收到项目列表、尚未收到执行身份时，自动选择项目触发了面向手动导航的错误提示。身份后来已确认、发送已经可用，错误条仍残留。**这是网页验收发现的问题，不是 #62 或 #63 的 CI 失败。** 修复让自动项目同步等待身份确认，并在门禁解除后使用最新项目数据重试；保留真实身份变化和草稿保护。新增空草稿、已有 ROOT 草稿、已有项目选择三个案例；七个相关文件、70 例与类型检查均通过，[独立增量审计](../audit-evidence/v233-initial-identity-repair/audit.json)重新绑定源，并要求新的完整 CI。

实际新版 bundle 的本地浏览器验收还将 ROOT 状态故意延迟到首次项目响应后 1,022 ms，确认无需手动重读就能自动就绪；只输入后清空临时草稿，没有发送任务。预防重点是覆盖“新标签、无 sessionStorage 项目、相同 ROOT 身份延迟确认”的真实初始化顺序，而不只测已打开页面里的模式切换。旧通过、旧失败和修复后的新结果分别保留；不靠重试、隐藏警告或放宽权限门禁制造通过。
