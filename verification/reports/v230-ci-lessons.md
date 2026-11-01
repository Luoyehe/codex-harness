本页只复盘 CI4、CI5、CI6 已封存的失败与修复，供下次发布前检查；CI7 最终通过的结果见发布记录，本页不执行或替代发布门禁。

1. **接口变化要检查跨层夹具的消费者。** MCP OAuth 增加状态预检后，gateway 的内存和真实管道夹具都必须返回完整状态页；线程作用域还须先加载线程。修改共享 runtime 夹具时，把 gateway 消费者纳入定向选择。CI4 全量实际已选中这些测试；此前手选定向范围不足和共享夹具映射缺口须分别处理。[夹具修复](../audit-evidence/v230-ci5/fixtureAuthor.json)、[选择器修复](../audit-evidence/v230-ci5/selectorAuthor.json)。

2. **验证原进程退出，不能只查旧 PID。** Windows 在受控子进程仍存活时记录 PID 与创建时间，关闭后比较同一身份；创建时间保留精确文本，查询异常不能当作进程消失。立即观察待完成 Promise 的拒绝，避免主断言失败后清理又产生未处理错误，同时保留原拒绝断言。CI5 日志不足以证明实际发生了 PID 复用。[独立复核](../audit-evidence/v230-ci6/identity-review.json)。

3. **UI 错误文案必须对应精确的最新请求阶段。** 连续改变模型与思考强度会产生不同防抖资源键；相同错误文本可能属于旧设置。用受控响应核对最终参数，再释放该请求的失败并点击重试；保留加载中禁用、重复点击、草稿和 unknown 状态断言，不靠延长超时。CI6 修复还验证了新键撤下旧错误和旧按钮。[独立复核](../audit-evidence/v230-ci7/retry-review.json)。

4. **预检和全量结果都绑定精确候选。** 先提交候选，在推送前使用固定 Node、CLI、依赖锁完成本地 preflight/build，记录 commit、source digest、文件数和实际 full plan；它们不能替代托管全量结果。最终按 case ID 去重，要求每项在适用平台通过且 `coverageGaps=[]`；合法平台 skip 可由其它平台补齐，失败组的 `cases:null` 不能记成零失败或成功覆盖。CI5、CI6 的 coverage 均因失败平台被正确拒绝。[CI5 记录](../audit-evidence/v230-ci6/ci5-failure.json)、[CI6 记录](../audit-evidence/v230-ci7/ci6-failure.json)。

5. **先保留失败，再修可证明的缺口。** 保存原日志、提交和哈希，先核产品契约，再做最小修复、受影响测试和独立复核；不要盲目重跑直到变绿，也不要让旧源码的全测结论覆盖新源码。将已证实的夹具缺口与历史触发假说分开：CI5 的 PID 复用、CI6 的精确调度交错都未被历史证据证明；本地原用例通过也不等于 CI 误报。[CI5 作者边界](../audit-evidence/v230-ci6/identity-author.json)、[CI6 作者边界](../audit-evidence/v230-ci7/retry-author.json)。
