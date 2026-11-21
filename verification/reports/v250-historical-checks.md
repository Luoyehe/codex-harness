# v2.5.0 发布前历史 CI 失败复核

2026-11-20 复核。取得 GitHub Actions 的六份原始运行日志、相应的工作流、PR 差异、合并对象父提交，以及 #77 的原始 ci-plan.json。六次失败均发生在 v2.4.0 发布前。复核时六份 Dependabot PR 均未合并。

## 逐次结论

| Reviewed checks | 依赖 PR | 第一个阻断点 | 对修复与回归的影响 |
|---|---|---|---|
| [#70](https://github.com/Luoyehe/codex-harness/actions/runs/44131258467) | [#11 Caddy 2.11.7 → 2.11.9](https://github.com/Luoyehe/codex-harness/pull/11/files) | Linux、Windows 准备 Go 时拒绝 DNS Caddy 源码摘要。Linux root 校验相同配方时也失败。 | 候选继续验证完整配方。采纳此升级时须重新审查 Go 锁、同步配方摘要并验证编译出的 Caddy 版本及插件。 |
| [#71](https://github.com/Luoyehe/codex-harness/actions/runs/44131263991) | [#12 Vitest 5.0.5 → 5.1.0](https://github.com/Luoyehe/codex-harness/pull/12/files) | 包清单和锁文件变化需要当前源码的完整审计授权。计划阶段拒绝，三个平台作业均跳过。 | 保留精确源码授权要求。此次运行没有关于新 Vitest 自身兼容性的测试结果。 |
| [#72](https://github.com/Luoyehe/codex-harness/actions/runs/44131272571) | [#13 Route53 1.6.2 → 1.6.3](https://github.com/Luoyehe/codex-harness/pull/13/files) | 与 #70 相同的配方摘要校验，两个标准平台与 Linux root 均受影响。 | 采纳此升级时须同步审查与验证 DNS 模块及其锁文件。 |
| [#73](https://github.com/Luoyehe/codex-harness/actions/runs/44131326838) | [#14 fake-indexeddb 6.2.6 → 6.2.8](https://github.com/Luoyehe/codex-harness/pull/14/files) | 与 #71 相同的授权门禁。 | 该次运行没有执行 IndexedDB 用例。 |
| [#74](https://github.com/Luoyehe/codex-harness/actions/runs/44131386791) | [#15 @vitejs/plugin-react 6.1.2 → 6.3.0](https://github.com/Luoyehe/codex-harness/pull/15/files) | 与 #71 相同的授权门禁。 | 该次运行没有执行 React 或构建测试。 |
| [#77](https://github.com/Luoyehe/codex-harness/actions/runs/44147902052) | [#10 CodeQL init 4.39.1 → 4.39.3](https://github.com/Luoyehe/codex-harness/pull/10/files) | Windows 下载固定 Go 工具链时触发 300 秒预算，未开始 Windows 用例。Linux 和 Linux root 通过。 | 修正工具链大文件下载在慢速和短暂断线时的恢复能力，保留来源、长度和摘要验证。 |

### DNS Caddy 配方与三个平台

两份 PR 都只改动 `deploy/caddy_dns_source/go.mod` 和 `go.sum`。准备 Go 脚本首先调用 `source_material()`，逐文件比较实际 SHA-256 与配方中已审查的摘要。Linux 和 Windows 的失败原文均为 `Go preparation refused: DNS Caddy source differs from reviewed recipe`，发生在工具链下载前。两次 Linux root 作业各运行 355 个用例，共有 78 个不同用例失败。unittest 分别记录 78 个 error 和 8 个 failure，按用例标识去重后，70 个用例记录错误、8 个用例记录断言失败。多条后续断言分别报告事务尚未建立或恢复原因没有达到预期，根因可追溯到更早的配方验证。候选源码保留了校验，并有针对配方变化的部署测试。 [#70 Linux](https://github.com/Luoyehe/codex-harness/actions/runs/44131258467/job/134208915630) · [#72 root](https://github.com/Luoyehe/codex-harness/actions/runs/44131272571/job/134209050893) · [配方校验](../../deploy/dns_caddy_build.py) · [回归测试](../../tests/deploy/root/test_dns_caddy_build.py)

### 三次依赖元数据授权拒绝

#71、#73、#74 的计划日志均给出 `Change scope requires complete review and an exact-source closeout authorization; no tests were started`。后继汇总统一报告 `Test planning did not succeed`。三次绿灯缺失的原因已由官方原始日志确定。v2.5.0 保留对授权缺失、过期与 PR 自批的拒绝，并允许真实三个审计轮次形成的、与源码和证据绑定的完整发布授权。 [#74 计划](https://github.com/Luoyehe/codex-harness/actions/runs/44131386791/job/134209094459) · [CI 计划与回归](../../tests/tooling/ci-checks.test.ts)

### Windows 工具链下载超时

#77 仅改动 `.github/workflows/security.yml`。官方 ci-plan 选择了 82 个文件，其中标准平台 57 个、Linux root 25 个，包含 `deploy/caddy_dns_source/main_test.go`。Windows 步骤从 UTC 18:28:05.6965954 开始，18:33:07.0778121 报 `Go preparation refused: Go download budget exceeded`，相隔 301.38 秒。旧代码把 256 MiB 上限与 300 秒时间上限合并为同一错误。该固定 Windows 包官方大小是 75,004,774 字节，SHA-256 与仓库 pin 一致；时间线与官方大小将原因定位到正常归档传输的时间预算。原日志没有逐块流量记录，无法从其反推出链路速度、网络运营侧或瞬时故障点。Windows 结果文件缺失以及最终覆盖汇总失败均发生在下载失败后。 [Windows 作业](https://github.com/Luoyehe/codex-harness/actions/runs/44147902052/job/134268214431) · [官方计划产物](https://github.com/Luoyehe/codex-harness/actions/runs/44147902052/artifacts/14358285398) · [官方 Go 发布清单](https://go.dev/dl/?mode=json&include=all)

v2.5.0 下载器为三个尝试共用 480 秒传输预算。中断后优先请求未完成的字节区间，服务器返回完整响应时从头校验。Linux 归档固定为 66,936,659 字节，Windows 归档固定为 75,004,774 字节。只在长度、来源及完整 SHA-256 验证通过后原子发布归档。对错误区间、错误长度、校验不符、权限拒绝和可恢复网络错误分别处理。下载失败清理本次临时文件，允许在同一检出目录重试。Reviewed checks 标准作业外层限时 30 分钟，Security CodeQL 作业外层限时 20 分钟，余下时间供加载模块、构建及验证使用。 [准备脚本](../../scripts/prepare-ci-go.py) · [针对性用例](../../tests/deploy/test_prepare_ci_go.py) · [Reviewed checks](../../.github/workflows/affected.yml) · [Security](../../.github/workflows/security.yml)

本机使用 Python 3.12.14 对两个官方分发包实际下载并核验 SHA-256，Windows 压缩包用时 5.8 秒，Linux 压缩包用时 6.0 秒，长度与 SHA-256 均与官方清单一致。准备脚本的 22 个定向用例全部通过，覆盖持续 315 秒的传输、断线续传、服务器忽略 Range、长度与摘要偏差、临时错误重试上界、共享时限、同一目录失败后重新准备以及防止覆盖已有文件。慢速和中断场景使用受控模拟，两份真实归档的传输在本机执行。

### 相邻运行及发布点

同期 main #67 进入 Windows 的 app-lifecycle 测试后失败。#75 的 main Reviewed checks 通过，同一提交的 Security #57 因 pnpm 依赖审计失败。#76 的相邻 CodeQL analyze PR 通过，分支与 #77 不同。最终已发布的 v2.4.0 main 提交 `historical-commit-107` 的 Reviewed checks #78 与 Security #60 都通过。 [#67](https://github.com/Luoyehe/codex-harness/actions/runs/44130969420) · [#75](https://github.com/Luoyehe/codex-harness/actions/runs/44147510598) · [Security #57](https://github.com/Luoyehe/codex-harness/actions/runs/44147510629) · [#76](https://github.com/Luoyehe/codex-harness/actions/runs/44147899421) · [v2.4.0 Reviewed](https://github.com/Luoyehe/codex-harness/actions/runs/44155358666) · [v2.4.0 Security](https://github.com/Luoyehe/codex-harness/actions/runs/44155358832)

## 源码与日志溯源

六次工作流均显式检出 PR head。已逐一核验下表试合并对象的两个父提交与 PR base、head 一致。v2.5.0 工作流改用 GitHub 事件的合并 SHA。下表保留历史实际受测源码和当时的试合并对象。六份日志均为 GitHub Actions 对应运行的 attempt 1 官方 ZIP。

| 运行 | PR base | 实际检出的 head | GitHub 试合并对象 | 下载的原始日志包 SHA-256 |
|---|---|---|---|---|
| #70 | [historical-commit-018](https://github.com/Luoyehe/codex-harness) | [historical-commit-041](https://github.com/Luoyehe/codex-harness) | [historical-commit-063](https://github.com/Luoyehe/codex-harness) | `8c4a187ed3ba64910746a3e6a4fb0a495bcd7ce2ec0dd4b5253c83c7599ca0da` |
| #71 | [historical-commit-018](https://github.com/Luoyehe/codex-harness) | [historical-commit-125](https://github.com/Luoyehe/codex-harness) | [86e6d8b1d1d1](https://github.com/Luoyehe/codex-harness) | `f397ab64ca8e190d95eec69f5bb714be3f73e0ba7bc92e9a7ece964a704567e6` |
| #72 | [historical-commit-018](https://github.com/Luoyehe/codex-harness) | [historical-commit-029](https://github.com/Luoyehe/codex-harness) | [historical-commit-036](https://github.com/Luoyehe/codex-harness) | `46e6b8f971e69f729cc42b557dfd475f468249e5f0058f488e459d15a634d5a7` |
| #73 | [historical-commit-018](https://github.com/Luoyehe/codex-harness) | [historical-commit-042](https://github.com/Luoyehe/codex-harness) | [fba1b46dd646](https://github.com/Luoyehe/codex-harness) | `88e50889828e16d56889bd29a105f02465da386f019f5e0c0dccb70f67d30131` |
| #74 | [historical-commit-018](https://github.com/Luoyehe/codex-harness) | [historical-commit-046](https://github.com/Luoyehe/codex-harness) | [9dfe27e6f1a2](https://github.com/Luoyehe/codex-harness) | `0ff81a48d87759a552066f3e252ec541e00299e69c124e941bbe68b61031b6cb` |
| #77 | [historical-commit-073](https://github.com/Luoyehe/codex-harness) | [historical-commit-131](https://github.com/Luoyehe/codex-harness) | [a76eb29100d5](https://github.com/Luoyehe/codex-harness) | `40946340b2ea19667626068325243c73a2f376cf1d69b049efcaee618aa438ab` |

## v2.5.0 首个全量候选的失败复盘

候选 `historical-commit-122` 已通过两轮整库审计和构建预检。首次 GitHub 全量在 303 个测试文件中报告 **17 个不同的失败用例、20 次平台失败**。其中一项确认是 Windows 下实际的项目可信状态显示缺陷。其他失败涉及测试环境、测试数据、资源收尾、用例时限及旧断言。覆盖对账因前置作业失败而正确拒绝该候选。安全检查单独通过。这次运行没有发布版本。[失败的全量运行](https://github.com/Luoyehe/codex-harness/actions/runs/44905367136) · [同期安全检查](https://github.com/Luoyehe/codex-harness/actions/runs/44905372420)

| 执行目标 | 失败用例 | 计数依据 |
| --- | ---: | --- |
| Linux 普通用户 | 5 | Vitest 原始报告 3 项，Python 用例 2 项 |
| Windows 普通用户 | 10 | Vitest 原始报告 5 项，Python 用例 5 项 |
| Linux 特权用户 | 5 | 375 项实际执行，370 项通过、5 项失败 |
| 跨平台重复 | 3 | 临时测试仓的脚本遗漏、HTTPS 启动依赖断言、MCP 环境字段冷加载超时，各在两个系统报告 |

已核对三个作业的原始日志、三个逐用例结果、两份 Vitest 原始报告以及完整日志压缩包。Vitest 失败时，平台总表未附该组的逐项结果，因此按原始 Vitest 报告还原该组失败。压缩包 66 个成员均通过完整性检查，SHA-256 为 `b4c84e121e125918ad3df6d8ff7dea2c2ac92a505b026a35a90e6649bdfc5132`。每个失败用例的完整标识、所处平台和原始文件校验值均保留在清单里。[逐用例对账](../audit-evidence/v250-platform/candidate-44905367136.json)

### Linux 特权环境的 5 项

- **真实 ext4 归档 1 项。** 普通构建归档夹具用裸名称调用 `mkfs.ext4`，托管特权进程的最小 PATH 无法找到它。此前验证过的 DNS 归档已经使用系统工具的固定路径，掩盖了普通归档入口的差异。现在这组用例直接定位格式化、挂载、读取卷内容及卸载程序。按托管环境的最小 PATH 实际创建卷、走归档、逐字节读回保留内容，均已通过。
- **HTTPS 恢复 2 项。** 旧格式恢复记录和已提交迁移的两项重置，都把受管实例放在共享临时目录下。其祖先目录全局可写，生产校验在读回执前即拒绝。测试改在 root 私有目录中建立实例，并反向验证同一回执处于可组写的祖先下时会被拒绝，原配置完整保留；恢复权限后可成功重置。
- **边缘程序持久化 2 项。** 两项首先遇到同样的祖先权限拒绝。移到私有目录后，仍有两项失败。文件同步发生在临时文件上，旧观察器却按最终文件名记账，故障注入也未命中。修复后用真实文件描述符识别已同步的内容和权限，再核对重命名后的目标为同一 inode、父目录同步先于清单发布。另一次命中实际待发布文件的同步失败时，目标、清单和临时残件均不存在。

专用 Debian 模拟了托管执行时的普通用户可写检出、root 专用源副本、最小 PATH、共享临时目录和隔离挂载。对上述三个文件执行同一批 83 项，旧候选 78 项通过，首次修正后 81 项通过，修正持久化观察器后 83 项全部通过。另分别省略文件或上级目录同步，两次负对照都使新断言失败。今后修改归档、HTTPS 恢复或原子发布时，在该环境同时执行 `test_candidate_archive.py`、`test_https.py` 和 `test_tree_durability.py` 三个 root 文件，并核对原失败编号。此前运行的普通用户工作区和 root DNS 用例没有覆盖这三个文件。[原条件三次对照](../audit-evidence/v250-platform/root-ci-conditions.json)

### 普通用户环境的 12 项不同失败

| 涉及用例 | 失败原因与此前盲区 | 修复与预防性验证 |
| --- | --- | --- |
| 正式测试入口隔离，1 项，Linux 和 Windows | 临时仓手工复制脚本清单，遗漏后来间接导入的 `audit-rounds.mjs`。真实入口在验证 Git 隔离前就报模块不存在。原变更选择规则未要求重跑这个临时仓用例。 | 从正式脚本目录带入 JavaScript 与 Python 脚本。审计及发布授权模块变化时，选择器会纳入真实入口隔离测试。已核对正对照中的 Git hook 确实执行，再以隔离入口检验其不能干扰测例。 |
| 内置 HTTPS 的 systemd 依赖，1 项，Linux 和 Windows | 网络延迟上线修复将 `network-online.target` 加入网关之前的启动顺序。旧断言只接受 `After=` 后紧跟网关名称，因而拒绝已经包含两项依赖的正确配置。 | 在生成的 Unit 段解析全部 `After=` 依赖，核对网关与网络上线目标，并检查 `Wants=network-online.target` 和内置认证无需独立身份服务。普通用户 HTTPS 文件的 11 项通过。今后调整 unit 渲染时与特权恢复用例一起运行。 |
| Git 项目根与可信状态，2 项 | Linux 的“普通祖先目录”被建在运行器自己的 Git 仓中，真实根发现正确找到了宿主仓。Windows 另有产品缺陷，项目层和工作目录的分隔符不同，或位于驱动器根时，已核实的可信项目会错误显示为未观测到。此前 POSIX 路径用例不能触发该比较。 | Linux 的负对照明确建在仓外，并继续验证真实 Git 主工作树与链接工作树。产品按完整路径段判断层级，保留配置键精确匹配。Windows 路径语义下复核四组，原失败路径、混合分隔符和驱动器根均由未识别恢复为原生项目层，同前缀兄弟目录仍未获可信状态。 |
| 自建 MCP 的配置保全与冷加载，2 项，Linux 失败两项、Windows 失败一项 | 两个完整场景顺序启动 46 和 75 个配置校验辅助进程，通用的 15 秒用例上限会在最终断言前终止。快速主机上的单次通过没有检验整个序列的时限。 | 原生多步用例采用 60 秒整段时限，保留每次协议操作的原时限和真实 CLI 冷加载。给两版的每个辅助进程同加 320 毫秒启动延迟，旧版两项均超时，修复后分别用 20.419 秒、33.049 秒完成原配置与字段断言。两项用例以外的原生集成场景仍需单独验证其环境和时限。 |
| 会话反馈保存目录，1 项，Windows | 夹具固定返回 POSIX 拼写的反馈目录，Windows 正式实现按本机路径拼接并严格校验目的地，导致写入前出现 `feedback_scope`。此前 POSIX 验证两端拼写相同。 | 用注册项目的本机绝对路径构造夹具，检验完整的项目私有目录、操作编号和 ZIP 文件名，保留跨项目及自定义目的地的拒绝断言。 |
| 模型选择视觉工具时传递的路径，1 项，Windows | 正式提示将路径写成 JSON 字符串。旧断言直接搜索操作系统路径的原始字节，因此遇反斜杠转义就失败。此前常规 POSIX 目录名没有需要转义的字符。 | 从模型实际收到的文本中解码路径，读取该文件，将同一路径用于模型选择的工具调用。另用含反斜杠和双引号的本地目录驱动真实 CLI 验证，确认仍能读回原图。图片模型原生输入与仅文本模型的工具选择分别验收。 |
| 附件扫描断点及读取队列，4 项，Windows | 断点用例在已序列化 JSON 中直接替换未经转义的路径，Windows 上实际文件字节未变，扫描仍返回第一张图。另三项是内联证据、长队列和队列重开清空，用例提交事务后仍持有 SQLite 连接，Windows 清理临时数据库时报文件被占用。POSIX 对打开文件的删除行为不同。 | 按正式格式重新序列化变更记录，明确断言总长相同而字节确已变化，再核对第二张图。六处临时队列连接均显式关闭，保留事务提交和原业务断言。在 macOS 的历史与反馈定向文件，43 项通过、1 项 Windows 专属用例按条件跳过。 |

在 Debian 普通用户条件重跑 Git 根、HTTPS 与历史三个文件，分别有 1、11、40 项通过，另有 1 项 Windows 专属用例跳过。整合提交 `historical-commit-108` 的八份定向文件在 macOS 运行，45 项 JavaScript/TypeScript、51 项 Python 通过，1 项 Windows 专属用例跳过。首次指定的独立二进制缺少官方包元数据，运行器在测试开始前拒绝执行；上述结果取自补正同一固定版本官方包路径后的重跑。托管 Windows 的真实盘符、文件锁、工具路径以及各平台在全量负载下的用例时限，均须在修改后的候选上以正式工作流重新确认。本次失败运行只用于溯源及对照，发布资格由后续同一源码的独立审计和全量结果另行建立。
