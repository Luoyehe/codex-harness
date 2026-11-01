本页记录 v2.3.2 的 CI1（b1ffa251）、CI2（a85e691）失败与 CI3（d9e42d7）实际闭环；原失败不改写为成功。

1. **启动参数改变，要追踪所有可执行程序夹具。** 固定 `-c thread_unload_delay_secs=0` 被 Node `--eval` 夹具解释为 `--check`，导致立即退出；Windows 精确 argv 断言也漏了新增参数。这不是已证实的清理超时。此前定向测试只覆盖官方 CLI，漏掉自定义启动器消费者。改用文件脚本，保留实际延迟、转义和进程退出断言；今后参数变更须检查 eval、脚本和 Windows 控制器三类消费者。[CI1 复盘](../audit-evidence/v232-ci-repair/failedCiReview.json)、[JS 修复](../audit-evidence/v232-ci-repair/jsAuthor.json)。

2. **UI 夹具必须具备真实选择所需的身份。** 当前供应商筛选生效后，旧 defaults 夹具缺少 thread/session 的供应商，旧 change 事件实际上没有选中可用模型。此前只验证新模型菜单，遗漏旧 defaults 集成消费者。补齐 thread/session/catalog 的同一身份，先断言选项确实存在和已选中，再核对完整发送参数；不能修改产品规则迎合缺失身份的夹具。[独立复核](../audit-evidence/v232-ci-repair/webTestsAndDocs.json)。

3. **部署安全门禁的夹具，要真实到达目标分支。** CI1 部分发布目录缺少 `app/package.json`；另有普通 UID 夹具不能满足真实 ROOT 认证元数据所有权检查，提前失败而未进入原测试场景。补全必要发布元数据，仅在原本模拟 ROOT 服务的普通身份夹具内作实例级替身；保留 ROOT 权限、回滚和能力校验断言。检查具体错误码及服务调用序列，不能只凭“抛出了异常”认定覆盖成功。[部署修复](../audit-evidence/v232-ci-repair/deploymentAuthor.json)、[独立复核](../audit-evidence/v232-ci-repair/deployTests.json)。

4. **共享 setUp 的组合调用，也必须进入自动测试选择。** CI2 的 ROOT AccountRecovery 通过调用普通夹具 setUp 并复用 Manager，带入了 `release_accounts=False` 替身；不是类继承。上一轮漏查该消费者，选择器也遗漏它。恢复该实例的真实读取方法，并把 installation recovery、ROOT account recovery、release reuse 三文件双向成组；新增精确成员断言及缺少伴随文件时拒绝选择的回归。受影响验证 53 项通过，CI3 原两失败用例均实际通过。[CI2 复盘](../audit-evidence/v232-fixture-isolation/failedCiReview.json)、[修复与预防](../audit-evidence/v232-fixture-isolation/author.json)。

5. **每次失败都留下复盘，再用新源码完成闭环。** AGENTS 与发布预检现要求保留 HEAD/job、真实失败、根因、漏检原因、相邻消费者、预防动作和验证边界。CI3 手动全量精确绑定 `d9e42d7` / source `00847eac…`：263 文件、3073 去重用例、`coverageGaps=[]`；CI1、CI2 原失败逐项有实际通过记录。合法平台 skip 由适用平台补齐，不能把平台总数相加当去重数；main 自动检查只是额外确认。[CI3 全量](../audit-evidence/v232-final/ci3.json)、[main 检查](../audit-evidence/v232-final/main-push.json)。

边界：未下载各平台完整 case JSON 制品，逐用例去重以托管汇总及其原日志 SHA 为证；本文不声称真实供应商推理、MCP 调用或线上部署已验收。CodeQL 仍有 19 条 open、2 条 closed，无新增编号；16 条当前告警沿已绑定语义审查，3 条旧实现告警仅核清单，未读取旧源码，也未消除告警。[最终 CodeQL 记录](../audit-evidence/v232-final/codeql.json)。
