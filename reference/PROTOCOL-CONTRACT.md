# Codex App Server 协议契约

核验日期：2026-10-25。固定实现基线：官方 npm `@openai/codex@0.164.0`，独立 Windows x64 二进制报告 `codex-cli 0.164.0`。这是当次 npm `latest`，不代表永久最新。没有读取旧项目、旧 schema、真实用户 CODEX_HOME，也没有调用模型推理。

## 来源和可复现生成

- [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 提供流程说明。
- [官方 npm latest](https://registry.npmjs.org/@openai/codex/latest) 和 [固定 Windows 包元数据](https://registry.npmjs.org/@openai/codex/0.164.0-win32-x64) 提供版本、下载地址、完整性校验。
- Windows 包：`https://registry.npmjs.org/@openai/codex/-/codex-0.164.0-win32-x64.tgz`。
- 包 SHA-512（npm integrity）：`sha512-urWPhwh9YavuoAPIkmVYKBTtd5OtGVL4Ki0Fb28dhK/Mz6Pt4LSy+gbRrZFz5+RXrw9ubvXuXDCcd8beYcWhDg==`，下载后已验证。
- 二进制：`reference/runtime/codex-0.164.0/package/vendor/x86_64-pc-windows-msvc/bin/codex.exe`。
- 在独立子进程环境中将 `CODEX_HOME` 指向 `reference/runtime/codex-0.164.0/generation-home`，以新项目为 cwd，运行：

```text
codex.exe --version
codex.exe app-server generate-json-schema --experimental --out protocol/json
codex.exe app-server generate-ts --experimental --out protocol/ts
```

`protocol/json` 和 `protocol/ts` 是本次 CLI 新生成的完整官方产物，不手改。`--experimental` 保留完整联合类型；调用实验能力仍须初始化显式 opt-in。网页与固定版本不一致时，以固定版本生成物和隔离实测为准。源级校验入口为 `protocol/json/codex_app_server_protocol.v2.schemas.json`、`protocol/ts/ClientRequest.ts`、`ServerRequest.ts`、`ServerNotification.ts`。

## 连接与生命周期

- 启动固定二进制 `app-server --listen stdio://`；stdin/stdout 是逐行 JSON RPC，stderr 独立收集。wire 不带 `jsonrpc` 属性。
- 每条新连接只发一次 `initialize`，成功后发无 id 的 `initialized`，再放行普通请求。
- 最小 capabilities：`{ experimentalApi: true, requestAttestation: false }`。不要宣称尚未实现的 MCP 扩展；不要接管外部 ChatGPT token 刷新或 attestation。
- 请求 `{ id, method, params }`；响应 `{ id, result }` 或 `{ id, error }`；通知无 id。服务端反向请求也有 id 和 method，必须与普通 RPC 响应分开处理。
- 保留请求 id 的 string/number 类型。RPC 错误保留 code/message/data；进程退出必须拒绝全部等待中的 RPC、标记终端结束，并清除该连接待答请求。
- 断线重连重新握手；不要重放未确定成功的 turn/start 或审批。先刷新 thread/read、状态和历史，再由用户继续。

## 账号、Provider 与模型

- `account/read { refreshToken:false }` 读取状态；`account/login/start { type:"chatgptDeviceCode" }` 返回 `loginId / verificationUrl / userCode`。前端显示这三者并等待 `account/login/completed`，只有 `success:true` 才表示成功；`account/updated` 后刷新账户。取消用 `account/login/cancel { loginId }`，退出用 `account/logout`。
- 第三方 provider 的 key 使用该子进程环境变量和独立 config，不能误发给 OpenAI 的 `account/login/start {type:"apiKey"}`。配置使用独立 provider id、`base_url`、`env_key`、`wire_api="responses"`；避免占用内置 provider id。[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- 自定义地址必须支持 Responses 的请求、增量 SSE、结束事件和工具往返。只有 Chat Completions / Anthropic Messages 的地址不够；Coding Plan 如使用此类地址，需要明确实现并测试本地兼容桥。[网关兼容要求](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility)
- `model/list` 提供可选模型及 effort/inputModalities；自定义 provider 的模型 id 允许用户显式指定，不能把内置列表当作第三方可用性证明。能力 UI 采用 server/provider 实际返回值。
- 不把 key、auth token、设备登录状态写进浏览器持久存储、日志或导出诊断。测试只用独立临时 home 和本地模拟 provider。

## 项目、线程和历史

| 目标 | 0.164.0 方法与要点 |
| --- | --- |
| 项目 | schema 含 `project/list/read/create/import/update/move/delete`。`project/create` 需要 `name, roots, idempotencyKey`；若应用自管目录项目，线程仍明确传 cwd。不要把项目 id 当作路径。 |
| 列表 | `thread/list` 分页；明确 `sourceKinds:["cli","vscode","appServer","exec"]`，防止默认过滤掉 app-server 会话；按需要传 cwd / projectId / archived / modelProviders。持续读取 nextCursor。 |
| 新建 | `thread/start` 至少显式传 cwd 和选定 provider/model；sandbox 与 permissions 互斥。响应保存 `thread.id`、`thread.sessionId`、`thread.historyMode`，不要从其中一个推导另一个。 |
| 查看 | `thread/read {threadId}` 只读元数据、不订阅。 |
| 恢复 | `thread/resume {threadId,excludeTurns:true}` 加载并订阅，之后才能继续 turn。优先 id，不用 unstable path/history 导入。 |
| 分页历史 | `thread/turns/list {threadId,limit,sortDirection:"desc",itemsView:"full"}`；默认 itemsView 是 summary，不能用于完整消息渲染。保留 nextCursor/backwardsCursor，按 turn.id 去重并允许锚点内容更新。 |
| 单项详情 | `thread/items/list` 可加 turnId；默认 asc。字符串 cursor 原样回传；item anchor 需要非空 turnId。返回 `{turnId,item,...}`。 |
| 旧式历史 | `historyMode:"legacy"` 使用 `thread/read {threadId,includeTurns:true}`。分页方法明确报告 unsupported 时也可回退此路径；权限、认证、网络或任意其他错误不得伪装成 legacy fallback。 |
| 命名/归档 | `thread/name/set {threadId,name}`；`thread/archive` / `thread/unarchive`。删除接口具有永久性，不能混用归档和删除。 |

本版本 `ThreadListParams` 支持 `projectId/sectionId`，但没有网页部分示例中的 `isPinned`；不要凭网页示例添加该字段。`Thread.turns=[]` 不等于没有历史。新历史以分页为主；完整 `includeTurns` 仅用于兼容。

## 输入、流式事件和状态

- `turn/start {threadId,input:[{type:"text",text,text_elements:[]}]}`；图片可用 `{type:"localImage",path}` 或 `{type:"image",url}`。当前 UserInput 没有任意 `file` 类型：普通文件应保存在明确的附件目录，通过 text / mention 指出绝对路径，不编造上传 RPC。图片/音频能力要按 provider 实际能力显示。
- 活跃回合追加用 `turn/steer`，携带 schema 要求的预期 turn id；停止用 `turn/interrupt {threadId,turnId}`。调用成功不表示回合完成。
- Turn status：`inProgress / completed / interrupted / failed`；完成以 `turn/completed` 为准。Thread status：`notLoaded / idle / systemError / active`；activeFlags 可能含 `waitingOnApproval / waitingOnUserInput`。两套状态不能合并成一个布尔 busy。
- 以 `(threadId,turnId,itemId)` 聚合 `item/started`、增量和 `item/completed`。最终 item 替换累计中间值；断线后用持久化历史补齐，不靠一段文本当作完整对话。
- 必需通知：`turn/started/completed`、`item/started/completed`、`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`turn/plan/updated`、`turn/diff/updated`、`thread/status/changed`、`thread/tokenUsage/updated`、`serverRequest/resolved`、`error`。
- 展示 commandExecution / fileChange / mcpToolCall / dynamicToolCall 的参数、状态、结果或错误；未知 item 类型保留原始类型并用可展开详情呈现，不丢历史。
- `thread/compact/start {threadId}` 立即返回 `{}`；等待 `contextCompaction` item 生命周期及 turn 结束。旧 `thread/compacted` 只作兼容信号。压缩可能访问模型，本次未做真实推理验证。

## 审批、用户输入和 MCP

待答记录按连接和原始 request id 保存，并带 threadId/turnId/itemId；只有正在等待的记录可回答一次。返回 `{id:原id,result:有效结构}`。`serverRequest/resolved`、相关回合终止或连接终止后移除表单。

| 反向请求 method | 必须返回的 result 与验证 |
| --- | --- |
| `item/commandExecution/requestApproval` | `{decision}`；只展示 params.availableDecisions 允许的选项（存在时）。基本值 accept / acceptForSession / decline / cancel；持久规则和 network amendment 对象须完整展示、严格验证后才可发。不能把网络审批伪装成普通命令。 |
| `item/fileChange/requestApproval` | `{decision:"accept"|"acceptForSession"|"decline"|"cancel"}`，先展示路径、修改或 grantRoot。 |
| `item/permissions/requestApproval` | `{permissions:授予的子集,scope:"turn"|"session"}`。拒绝可返回空 permissions，不能额外扩充请求范围。 |
| `item/tool/requestUserInput` | **准确的方法名包含 item/**。返回 `{answers:{questionId:{answers:["实际答案"]}}}`。按 question.id 映射、验证数组内均为字符串；isOther 控制自由输入，isSecret 使用隐藏输入。最新 schema 的 isBlocking 决定阻塞展示，不以弃用 autoResolutionMs 自动作用户决定。 |
| `mcpServer/elicitation/request` | `{action:"accept"|"decline"|"cancel",content:对象或null,_meta:null}`。form 的 accept 前验证 requestedSchema；decline/cancel 使用 content:null。url 模式只允许明确用户打开并确认；不要自动接受。 |
| `item/tool/call` | 仅注册了对应 dynamicTools 才执行本地处理器，响应 `{contentItems,success}`。没有处理器必须返回失败，不能宣称工具已执行。 |
| `currentTime/read` | 如收到，返回 `{currentTimeAt:Math.floor(Date.now()/1000)}`。 |

MCP 普通 form 校验覆盖 required、string/number/integer/boolean、enum/oneOf、多选 array、min/max、minLength/maxLength 和支持的 format。空字符串、false、0 不应靠 truthiness 错判。未知 schema/扩展模式不能接受未经验证的 JSON；显示不支持并允许 cancel/decline。只有完整实现扩展后才宣告 `extensions["openai/form"]`。schema 还包含 `openai/userVerification`、`openaiForm` 兼容分支，本客户端不得把它们悄悄当普通表单。

未识别的反向请求应显式返回 JSON RPC `-32601`，不默认批准、不永远悬挂。v1 `execCommandApproval/applyPatchApproval` 仅作老服务端兼容，固定 v2 客户端不能将两种 response 结构混用。

## 原生终端

- 首选 `command/exec`，command 是非空 argv，cwd 是已选项目路径。交互终端传客户端生成的唯一 `processId`、`tty:true`、`size:{rows,cols}`。tty 隐含 stdin/output streaming。
- **command/exec 的最终 RPC response 要等进程退出**。前端终端创建接口不能等待该 response 才返回终端 id；保留后台 promise，先暴露 processId。
- `command/exec/outputDelta` 是 `{processId,stream,deltaBase64,capReached}`；按字节解码，UTF-8 跨 chunk 要使用持续 decoder。流式数据不会再放进最终 stdout/stderr。
- 写入：`command/exec/write {processId,deltaBase64,closeStdin?}`；resize：`command/exec/resize {processId,size:{rows,cols}}`；停止：`command/exec/terminate {processId}`。
- `disableTimeout` 与 timeoutMs 互斥；`disableOutputCap` 与 outputBytesCap 互斥；sandboxPolicy 与 permissionProfile 互斥。长期交互终端选择明确 timeout 策略，避免默认超时被误认为用户退出。
- 此终端 connection-scoped，原连接断开后进程终止，不能宣传服务重启后恢复 shell 进程。
- `thread/shellCommand` 和实验 `process/*` 是独立语义：前者注入会话且不继承线程 sandbox，后者绕过 Codex sandbox。不能拿它们替代上面受控终端而保持同样的权限标签。

## 已核验及边界

独立空 home 下通过：版本、两种 schema 生成、初始化握手、未登录 account/read、空 thread/list、空 project/list、cmd.exe echo 的流式输出；Windows PTY 的创建、resize、stdin 写入、echo 输出和 exitCode:0 也通过。未调用 `turn/start`、未登录真实账户、未调用付费模型。

CLI 稳定发布不等于每项 app-server 能力稳定；官方将 app-server/部分接口标为实验性。隔离 smoke 不能证明真实 ChatGPT 登录、智谱计费/套餐权益或自定义 provider 的全部工具行为。真实联调用用户明确选择的 provider，不能后台偷偷调用付费推理探测。
