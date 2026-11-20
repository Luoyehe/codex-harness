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
