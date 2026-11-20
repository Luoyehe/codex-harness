# codex-harness v2.4.0 全量修复与验收报告

> 隐私整理说明：下文的运行与验收结果来自当时发布的原始版本。公开副本移除了私人部署记录；整理后的提交需要独立核验，旧签名和旧发布授权不能沿用。

2026 年 11 月 20 日，独立修复分支 `luoyehe/repair-v240`。原版标签为 `v2.4.0`，提交 `historical-commit-107`。

## 验收范围

按最终审计和逐项底稿核对 **169 个修复编号、51 个工作包**。编号原级为 P0 一项、P1 三项、P2 六十九项、P3 九十六项。工作包原级为 P0 四组、P1 十二组、P2 二十组、P3 十一组和四组治理建议。两组评级对应不同对象，一个工作包可以包含多个不同级别的编号。

每个编号在正文有独立条目。真实文件系统、数据库、编译器与原生进程能够验明的行为直接执行；断线、并发写入、存储故障与供应商失败使用受控条件触发，再检查真实应用的派发、持久化、恢复与页面状态。通过自动化验证的手机行为与仍需设备实测的部分分别说明。

## 四条用户可直接观察的修复

| 场景 | 修复后观察与证据 |
| --- | --- |
| 手机侧栏点“删除会话”没有反应 | 在 Edge 的 390×844 触屏视口加载 45 行，滚至最后一行，打开菜单并让焦点短时回到抽屉，能看到该行的确认框。取消发出 0 次删除，重新确认仅发出 1 次并且目标正确。另测后台刷新、外部轻点、滑动和离线说明。实体手机上的原始故障来自用户反馈，本次修复回归使用桌面 Edge 的触屏模拟和 WebKit。 |
| 超长会话不能继续或压缩 | 原版后端 2,000 个表示项或 8 MiB 完整遍历预算，确实能单独导致续聊/压缩被拒。前端 400 万字符展示预算也能独立触发。现在大历史从尾部加载，发送前另核对当前执行状态、审批、语音和待定写入。固定 CLI 加本地供应商实测，兼容旧接口的完整表示在 333 回合可读、第 334 回合触限。网页改为独立保留正文、用引用标记时间线位置，该夹具在 500 回合能完整读取及导出，到第 501 回合切换为有界展示。积累至 503 回合，关闭并重开原会话后可续聊、分叉、回退和压缩。超限完整导出明确报错，避免把尾部片段当成完整文件。另用真实 CLI 连续完成 5 次 43 万字符回复。旧表示共 4,307,587 字符，网页新表示为 2,156,274 字符，五份回复逐字相同，完整 Markdown 也可导出。回合数取决于每回合产生的消息与事件。 |
| 智谱 MCP 有时显示失败 | 三个默认兼容性不足的远端 HTTP 服务与本地视觉服务分别配置。页面区分启动、工具目录与执行，能从旧失败状态恢复；系统继承服务支持单独启停、复核保存/生效值与撤销。真实智谱软件包遇模拟上游 503 时错误返回原模型回合，正常调用时读取原始字节。用户当时遇到的真实失败原因仍缺服务名和上游日志，账号、网络及配额的当前可用性没有由本地验收证明。 |
| 导航时经常被软键盘打断 | 查看会话、关闭侧栏/设置、从工具页返回、创建新会话及定位历史，不主动将焦点送回聊天输入框。被动进入登录页、打开项目选择、启动终端或查询恢复终端也保留阅读焦点。主动轻点输入、明确搜索/重命名或提交密码后需要输入验证码时，可进入输入位置。见 passive-keyboard.log。桌面 Edge 的触屏操作验证了应用的焦点目标，软键盘最终是否弹出由实体手机的系统和输入法决定。 |

### 图片发送与视觉 MCP

| 当前模型及情形 | 实际派发与结果 |
| --- | --- |
| 原生支持图片 | 走模型原生图片输入。关掉视觉 MCP，真实 CLI 仍把 PNG 内联交给本地主模型端点。小图可逐字节一致。固定 CLI 会自行调整部分大尺寸图片，分辨率和编码取决于原生处理。 |
| 仅文本、能调用工具，模型直接回答 | 用户照常附图发送，普通回合收到会话受管文件引用。未给主模型传图片字节，视觉端请求数为 0。 |
| 仅文本，模型选择视觉工具 | 继续沿用该工具授权与审批。拒绝时视觉端 0 请求；获准后收到与上传件相同的图片，结果回到同一模型回合。网页没有“由用户调用视觉 MCP”的步骤。 |
| 工具或媒介不受支持、上游故障 | 文件格式、模型目录及工具执行分层校验。实际 `@z_ai/mcp-server@0.1.6` 对 JPEG/PNG、MOV/MP4 与 GIF/WebP 分别跑过；上游模拟 503 仍能向模型报告失败。用户截图中的“目录未声明支持图片”发生在派发之前，与工具已经被调用后的失败分属不同阶段。 |

对于已有队列，原生 CLI 会把多模态待办图片固化为内联数据，也会把文本模型待办保留为受管文件引用。两种方向均用真实 CLI 经过两次冷启动，核对恢复后原 PNG 字节一致，重复确认只产生一次投递。跨供应商转换支持逐份选择移交，转换完成时回传新会话编号和副本的单独移交结果。另用四张各约 2.4 MiB 的图片产生超过 12 MiB 的原生记录。多模态模型在热态自动消费、重启后按原编号执行两种情况下都收到四份完整图像，消息只投递一次，共享连接可继续使用。见 web-queue-native-final.log。

**旧版本升级实测。** 直接编译原始 v2.4.0 标签，用它的正常上传、排队入口生成旧版索引和 SQLite 队列。原上传宽图为 2,950,323 字节，原生 CLI 将队列图片转存为 822,440 字节，摘要也改变。换成修复版首次启动，原上传文件完整保留。旧版没有记录这两份文件的对应关系，用户保存待办副本时会看到“原生队列保存版”，该副本与 SQLite 里的字节一致。确认删除原待办并再次重启后，原图候选仍保留，副本可恢复。新版正常接受排队时能记录原图、队列项和图片位置的对应关系。对于既有未证实的候选，来源会话可查看并下载。实测三次下载的 SHA-256 均与原上传一致，覆盖删除前、删除后重启以及跨供应商转换后再重启。目的会话不可枚举、不可取走源候选。见 upgrade-baseline.log、upgrade-actual-accept.log、deploy-actual-v3-download.log、rt-wide-image-cold-known.log。

### 可复核的测量

| 测量 | 样本与结果 |
| --- | --- |
| 历史读取往返 | 同一份 333 回合持久会话，原版和修复版均冷启动，用网页正常的每页 30 条读完。总原生调用从 2,011 次降到 435 次，时间线调用从 1,332 次降至 89 次，完整历史均为 333 回合。当次读取耗时分别为 1,314 ms 和 316 ms。见 history-rpc.log。 |
| 历史列表重绘 | Edge 152，190 回合、704,381 字符。初次渲染 75 行；输入草稿后历史行重绘 0 次，连续 8 次流式增量各重绘 1 行。同一台 Edge 对同一份 40 回合、1,612,211 UTF-16 码元历史，各输入 35 键。原标签与修复后的同步输入处理 p95 在正常 CPU 下分别为 201.6 ms 和 4.7 ms，四倍限速下分别为 827.8 ms 和 9.0 ms。原版两组按键共重绘 2800 个历史行，修复后为 0。 |
| 回执导出期间并行健康读取 | 420 行、8,440,273 字节的真实 SQLite 账本预览期间重叠 11 次读取，p95 为 7.26 ms。1,200 行、24,115,353 字节时重叠 31 次读取，p95 为 7.05 ms，最大 8.08 ms。 |
| 归档内存 | Edge 限制 JS 老生代为 128 MiB，4、32、80、128 MiB 四档实际导出均校验摘要。128 MiB 档完整导出 134,217,728 字节，已用 JS 堆采样峰值约 3.83 MB，浏览器渲染进程 RSS 从约 239 MiB 到最高 313 MiB。在 80 MiB 的对照中读到 24 MiB 时取消，作业结束。操作系统回收 RSS 的时间独立于应用。 |
| 部署冷启动 | Debian 12 ARM64 专属虚拟机两次真实引导，接口故意延后约 6 秒可用。网络就绪及两个边缘单元探针的实际时间顺序均有记录，随后分别单独启动也通过。 |

## 逐项修复与验收

以下按逐项底稿的工作包顺序排列。编号和 P 级保留原终稿定义。每项列出原来的故障和修复后的观察结果，源码链接指向本次修复后的文件。记录中的日志文件可在配套证据包中按文件名检索。

### F-P0-01　移动端交互 · 侧边栏与模态框事件链

**工作包补充验收。** 窄屏只挂载一个侧栏。检查短列表、末行滚动、焦点回落、后台刷新、四种行操作、触摸取消与键盘退出。Edge 触屏模拟中，删除取消产生 0 次请求，确认后只产生 1 次。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R01** · P2 | 触屏侧栏过早关闭行菜单，点中删除后无确认框，长列表滚动也会收起菜单<br>[Sidebar.tsx](../../web/components/Sidebar.tsx) [Workspace.tsx](../../web/Workspace.tsx) [styles-responsive.css](../../web/styles-responsive.css) | 手机抽屉里只挂载一个侧栏。行菜单不再把触摸滚动或祖先 dialog 短暂取得焦点当作取消。真实桌面 Edge 152.0.4191.53，独立浏览器配置、390×844、触摸模拟，45 行，点最后一行的删除，模拟中途对话框接管焦点，实际出现对应的确认框。取消后删除请求 0 次，勾选并确认后请求 1 次，ID 与行目标相同。见 web-edge.log。sidebar.test.tsx 另测 60 行、刷新、Escape、键盘、外围点击。 |
| **R02** · P3 | 离线时删除确认框允许勾选，但没有解释为何无法继续<br>[Workspace.tsx](../../web/Workspace.tsx) [SidebarManagementDialog.tsx](../../web/components/SidebarManagementDialog.tsx) | 确认框显示离线/未就绪原因，断线禁提交，恢复后重新读取同一目标的当前原生状态。sidebar-management、sidebar 测试覆盖身份及忙碌条件，Edge 实测联网确认路径。 对应验收底稿见 web.md。 |
| **R95** · P3 | 后台同范围的会话列表刷新会关闭已展开的行菜单<br>[usePaged.ts](../../web/hooks/usePaged.ts) [Workspace.tsx](../../web/Workspace.tsx) [Sidebar.tsx](../../web/components/Sidebar.tsx) | 同范围刷新原行保留，菜单能活过重新渲染。范围变化仍撤销原所有者。sidebar、paged-threads 的长页面、刷新与项目切换用例。 对应验收底稿见 web.md。 |

### F-P0-02　长上下文容量 · 前后端会话历史与同步状态机

**工作包补充验收。** 前后端超限均有最近窗口，执行另核对线程、活动回合、审批及未知写入。完整导出仍要求全量依据，转换、压缩、分叉与回退分别核对原生条件。同一消息正文在网页和主历史接口只存一份，独立的语音及时间线消息保留。用新旧边界对照、一次分页超过 8 MiB、改版后的尾部增量及异常回退分别验明。见 R03、R25、R37。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R03** · P1 | 长会话超过本地历史预算后，重开仍无法续聊或从网页发起压缩<br>[web/lib/history.ts](../../web/lib/history.ts) [src/runtime/history.ts](../../src/runtime/history.ts) [service.ts](../../src/runtime/service.ts) | 浏览器与服务端的历史预算分别触发降级展示。执行前另行核实会话、审批、语音与在途写入。同一真实 CLI 夹具，兼容旧接口的表示在第 334 回合触限。网页引用表示可完整读及导出 500 回合，第 501 回合触及完整读取预算。到 503 回合重新启动服务，继续在原会话发送、分叉、回退和压缩。5 个长输出共 215 万字符的对照保留所有正文、时间线独有内容和语音，恢复到前端预算内。对 335 回合另作跨商转换，目标保留首、中、末消息且可续聊。完整导出超限仍明确拒绝。见 history-compact-native.log、history-long-prose.log、history-references.log、long-conversion-final.log。 |
| **R25** · P2 | 发送受理或回合结束后全量重读同一会话，遍历期间输入被禁用<br>[Workspace.tsx](../../web/Workspace.tsx) [useConversation.ts](../../web/hooks/useConversation.ts) | 原生通知已给齐内容时，同会话不重读历史。需要补齐时，用之前完整读过的版本、同一连接、实时观察的开始事件与最近窗口中的回合和时间线两个锚点校验，只追加已验证的内容。两端消息分页先后相反、版本变化、失去连接、语音活动或锚点缺失都经过对照，回落到正常重读。固定 CLI 十一个实际回合，截断窗口与旧版本重叠并能核准新回合。见 web-anchored-tests-final.log、rt-incremental-tail-native.log。 |
| **R37** · P2 | 长会话尚未到容量上限，完整同步已需要逐项串行调用<br>[media-history.ts](../../src/runtime/media-history.ts) | 普通 24 项仅需一次回合元信息和一次批量明细读取，生成大图等超长响应按实际大小缩小读取批次。超过 8 MiB 的时间线分批使用原生游标继续，逐个位置和每批开头的语音状态都能对齐。正文和时间线分页交错到达也能释放重复文本。同一真实 333 回合，冷启动全读的底层调用从 2,011 次降到 435 次。见 history-rpc.log、history-references.log、history-compact-native.log。 |
| **R106** · P2 | 同一会话重读失败后新增内容不再显示<br>[useConversation.ts](../../web/hooks/useConversation.ts) | 后台重读第二页报错后，从已验证的旧视图恢复并合并期间及之后的流事件。新用例实测旧回合+新回合唯一排序、新增文本可见、ready=false。 对应验收底稿见 web.md。 |

### F-P0-03　MCP 子系统 · 智谱 Coding Plan 部署、代理分流与状态同步

**工作包补充验收。** 远端三个 HTTP 服务与本地视觉 stdio 分开配置；工具、认证列表和手动预检轻读，资源页完整读取。进一步用 Linux 上的固定 CLI 验证只改一个服务后，重启、撤销、读回和更改其他原生设置均正常；外部供应商真实故障见验收边界。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R05** · P2 | MCP 服务恢复后，已打开的面板仍显示“连接失败”<br>[McpPanel.tsx](../../web/components/McpPanel.tsx) [service.ts](../../src/runtime/service.ts) | 直接切换原生启动状态、异会话通知、丢事件补同步及手动刷新分别验收。当前会话失败→成功，外会话忽略。丢事件重新读取服务目录、订阅和当前有效配置，工具页保持精简查询，资源页取完整信息。web-detail-final.log。 |
| **R06** · P2 | MCP 启动失败诊断漏用已有的敏感字段脱敏规则<br>[ServerNotification.ts](../../protocol/ts/ServerNotification.ts) [McpServerStatusUpdatedNotification.ts](../../protocol/ts/v2/McpServerStatusUpdatedNotification.ts) [service.ts](../../src/runtime/service.ts) | 按正式的 `mcpServer/startupStatus/updated` 方法脱敏失败原因，保留原通知。测试将同一动态凭据并行放进启动失败、诊断警告、普通助手正文，前两者隐藏，正文保留。 对应验收底稿见 runtime.md。 |
| **R96** · P2 | 智谱官方安装器针对 Codex 跳过的三个远程 MCP，Harness 仍默认启用<br>[provider.py](../../deploy/provider.py) [provider_registry.py](../../deploy/provider_registry.py) | 三个系统注入远端 MCP 的默认兼容策略由部署工作包实现。运行时对继承开关和真实状态诊断提供 R06、R97–R99 的相关验证。 智谱每条连接分别生成三个默认关闭的 HTTP 服务及独立启用的本地视觉 stdio。test_all_managed_cn_mcp_match_reviewed_contract_and_reuse_each_saved_plan_key 覆盖两条连接和停用一条。test_migrate_preserves_old_immutable_coding_plan_and_selects_new_remote_defaults 经实际配置层迁移选中新代，旧代字节及用户设置保留，重复升级无变化。均通过。 对应验收底稿见 runtime.md、deploy.md。 |
| **R97** · P3 | 默认参数探测为了读取配置而启动临时线程，也拉起无关 MCP<br>[service.ts](../../src/runtime/service.ts) | 真实 CLI 在读取临时默认值时通过等效的配置逐服务禁止启动，标准输入 MCP 的启动记录保持为 0。普通会话仍启动并发现工具。 对应验收底稿见 runtime.md。 |
| **R98** · P3 | 手动工具预检 detail:full 会额外请求资源及模板列表<br>[mcp.ts](../../src/runtime/mcp.ts) | 工具/认证页在直接事件、补同步与重载后均只取 toolsAndAuthOnly，资源页仍用 full。对继承的 stdio 和 HTTP 均验证仅指定一项与版本提交，旁系不受影响，保存后可进入服务管理。已保存停用/当前启用→重启后两者停用→恢复继承后当前仍停用→再重启两者启用。以独立真实运行时进程的实证另见 runtime.md。web-effective-final.log。 目录与工具调用预检使用轻量详情，用户明确查看资源时按需查询。真实慢调用通过的同时对照工具、资源分页。见 `mcp-native.test.ts`。 |
| **R99** · P2 | 网页的用户层编辑器不能单独停用系统层注入的智谱 MCP<br>[mcp-configuration.ts](../../src/runtime/mcp-configuration.ts) | 继承服务的启用偏好按执行身份和来源保存，可启用、停用或撤销。Debian 专用机上，固定原生 CLI 对系统服务切换四轮，每轮另写一条无关原生设置，重启后核对真实生效值和原服务传输配置。原生密钥保留在服务所属配置层。正式独立测试产生有效用例回执。见 rt-linux-system-ci.log、rt-ordinary-system-mcp.log、web-effective-final.log。 |

### F-P0-04　运行时附件存储 · 跨层历史索引与生命周期

**工作包补充验收。** 原生 SQLite 队列实际保存普通附件及缺 MIME 的 PNG。退出并重启后，消费端能打开两个路径，字节一致；各来源独立计量，真实旧 v3 数据经三次冷启，单个会话历史损坏期间，其他会话的新旧无引用附件均能独立回收。未核清的旧版原件留在来源会话，在来源会话可单独查看及下载。去目标会话、重复迁移及错误文件身份均不能取走原件。见 deploy-actual-v3-download.log、deploy-candidate-download.log。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R101** · P0 | 启动对账会删除已排队的本地附件<br>[service.ts](../../src/runtime/service.ts) [thread_history.py](../../deploy/thread_history.py) [attachments.ts](../../src/runtime/attachments.ts) | 真实 CLI 将普通文件、缺 MIME 的 PNG 和一个可取消附件加入原生队列。取消独立项，退出并重启，已取消附件释放，其余两项可消费且字节匹配。再查 CLI 将图片写成内联数据的相反方向。两个方向分别在原队列仍在、未保存副本，以及确认删除原项、服务重启后核对恢复。模型收到原文件或字节完全相同的 PNG，再次恢复没有重复投递。再从原始标签实际生成宽图队列，针对 CLI 重编码导致两份字节摘要不同，核对旧版升级后原件保留、另存版本与 SQLite 相同、再次冷启可恢复。新版有投递证据时可找回对应原件。另用四张各约 2.4 MiB 图片，让真实 CLI 保存超过 12 MiB 的单条队列记录。跨附件同名、多个重启及反复恢复均校验文件身份和投递次数。旧版未证实的候选原件可在来源会话列出和单独下载，跨会话读取被拒。证据见 upgrade-actual-accept.log、rt-wide-image-cold-known.log、rt-inline-image-reconciliation.log、deploy-candidate-download.log、web-queue-native-verified.log。 |
| **R102** · P2 | 全库共享扫描预算会把未核实的关联扩散至其他会话并妨碍回收<br>[thread_history.py](../../deploy/thread_history.py) [attachments.ts](../../src/runtime/attachments.ts) | 按实际附件的旧版归属、引用检查点和未决复制作业核对。用原版创建三个真实会话，只让其中一个历史不可读。连续三个冷启动，修复版仍能释放其他会话已取消的旧附件和升级后新增的附件，保留故障会话的旧文件及真正仍在队列里的宽图。恢复缺失的历史记录后，该会话无引用附件也被回收。旧版未记录复制目标或已无具名归属的个别文件保守等待首次核验时不可读的来源，新出现的无关故障不延长这段保护。见 deploy-r102-v3-seed.log、deploy-r102-v3-upgrade.log、deploy-r102-scoped-regression.log。 |

### F-P1-01　运行时原生 RPC · MCP 手动工具调用隔离

**工作包补充验收。** 原生 MCP 故意延时 35 秒，另一个会话同时读成功。按请求类型分别验证界面、网关、原生超时与已发请求的回执。手动工具按会话的实际配置决定等待时间。默认 300 秒，另留 20 秒收取回执。可配置至 1,800 秒，超过会在派发前提示。模型在对话里自行调用仍走原生回合。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R04** · P1 | 正常的慢速 MCP 手动调用会在约 30 秒时断开整个共享原生运行时<br>[mcp.ts](../../src/runtime/mcp.ts) [service.ts](../../src/runtime/service.ts) [native.ts](../../src/runtime/native.ts) | 普通请求保留短期限。手动 MCP 调用从已加载会话的原生配置取得该服务的 tool_timeout_sec，默认 300 秒，另给回执 20 秒余量。实际短时限、默认值、600 秒、超过 1,800 秒的配置均有对照。超上限在发起工具前说明原因。网关和浏览器允许完成所支持的最长请求，插件和模型自主调用各按原有路径计时。实际工具延时 35 秒返回，其间另一读取正常。到期与来源不明的派发结果保持未知且不自动重发。见 rt-dynamic-tool-timeout-final.log、rt-native-slow.log、rt-linux-confirmed.log。 |

### F-P1-02　多模态附件路由 · 视觉 MCP 自主调用、受管媒体后缀与跨项目门禁

**工作包补充验收。** 多模态直传、文本模型直接回答、选工具后拒绝、获准后传原文件四种路径分别计数。JPEG、PNG、MOV、MP4、GIF、WebP 对照固定版本视觉工具的真实处理；覆盖无 MIME、原版无扩展名、排队重启及首轮未发。已经入队的消息按原方式保存，改变传图方式时可保存副本、确认移除原项，再显式恢复。跨供应商只移交选中副本；发生移交故障时保留已建成的新会话身份，详见图片一节。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R165** · P1 | 模型不支持原生图片时，含图消息无法进入可自主选用视觉 MCP 的普通回合<br>[input-modalities.ts](../../web/lib/input-modalities.ts) [Composer.tsx](../../web/components/Composer.tsx) [attachments.ts](../../src/runtime/attachments.ts) | 原生图片模型关掉视觉 MCP 仍直接收图。文本工具模型得到受管文件引用，是否调用由模型决定。未配置、禁用、模型自行跳过或审批拒绝时，视觉端零请求。获准时智谱软件包读取原始字节并将结果交回同一回合。对上游 503 另验诊断。两种传图方式间切换时，原生队列实际保存为文件引用或内联图片，逐个保存副本、确认移除并显式恢复，验证进程重启后双向还原且无重复。见 rt-visual-selected-final.log、deploy-queue-handoff-native.log、web-queue-ui.log。 |
| **R166** · P2 | 新建会话先建空线程再拒绝图片，未决回执可能阻断其他项目新建会话<br>[service.ts](../../src/runtime/service.ts) [ledger.ts](../../src/core/ledger.ts) [dispatch.ts](../../src/gateway/dispatch.ts) | 创建前校验。如线程已建、首轮可证明未送达，保留原线程编号、回执与草稿，后续读取不会重复创建。两独立项目的正常入口验证 A 首轮未发、项目 B 文本仍可发送。真正未知仍阻挡相关操作。见 deploy-cross-r166.log、gateway-new.log。 |
| **R167** · P3 | 缺少 MIME 类型的有效 PNG 被当作文本文件路径发送<br>[Composer.tsx](../../web/components/Composer.tsx) [attachments.ts](../../src/runtime/attachments.ts) | 浏览器与运行时用有界字节特征判断图片。无 MIME、无可靠后缀的 PNG 在多模态路径内联，在仅文本路径提供原字节可读的会话附件。两个真实 CLI 端点分别核对收到的内容。见 vision-normal-entry.log、rt-visual-queue.log。 |
| **R168** · P2 | 受管 JPEG、PNG 的无后缀文件名被视觉 MCP 拒绝，MOV 的媒体类型被错标<br>[attachments.ts](../../src/runtime/attachments.ts) [thread_history.py](../../deploy/thread_history.py) | 实际智谱软件包通过有后缀的受管路径读取真实 JPEG/PNG/MOV/MP4，原字节逐一核对。测试加入 MOV/MP4 的交叉错标、二者 MIME 为空以及旧版无后缀 MOV 恢复。GIF/WebP 留在工具自身明确拒绝的分支。又用符合经典 QuickTime 媒体轨道结构、没有 ftyp 或 MIME 的 MOV，通过实际解码器及智谱工具，普通轨道且容器身份不明时保留一般文件。七份小型媒体随仓保存。见 vision-normal-entry.log、qt-frame-decode.log、qt-media-runtime.log。 |

### F-P1-03　网关准入控制 · 跨层控制面健康检查

**工作包补充验收。** 健康与账户证明均绑定实例、只读路径以及本机连接。普通资源、匿名写入和受信探针各有容量。正常配置提交后，用真实 Manager 对另一离线候选连续探测 30 次，回退上一配置成功，恢复日志与后续准入同时核对。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R103** · P2 | 控制面健康检查与公开匿名请求共用准入，可能把健康服务判为异常<br>[server.ts](../../src/gateway/server.ts) [manager.py](../../deploy/manager.py) | 匿名读写与受信探针分开计量，管理器的签名绑定路径与实例。经真实本机 HTTP 与工作进程套接字验证，健康候选 B 提交，离线候选 C 连续 30 次真实健康探针失败后自动回到 B，恢复日志落盘并解除阻挡。见 deploy-cross-control-http.log、gateway-accepted.log。 |

### F-P1-04　网关事件通道 · 前端实时同步与审批到达

**工作包补充验收。** 原事件类型随补同步传递。会话、审批、工作流及宿主四处按类型重新取权威状态；在此期间收回旧就绪标志，过大的状态事件让连接按 1013 重连。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R104** · P2 | 收到补同步信号后，审批列表与会话就绪标志没有重新核对<br>[server.ts](../../src/gateway/server.ts) [useEvents.ts](../../web/hooks/useEvents.ts) [usePrompts.ts](../../web/hooks/usePrompts.ts) | 补同步立即撤销可写证明，四处各自重读。① Workspace 重新核对项目、模型/设置与当前会话归档选择，app-lifecycle 观测 project/list、model/list、prompt/list、thread/read、thread/history。② 工作流 revision 刷新。③ 审批空窗期间旧请求不可答，重读与撤销事件对账后只可答新增项。④ 会话已展示的历史窗口直到新活动证明完成均禁写。web-resync-final.log（6 套 / 125 例）。 |

### F-P1-05　网关操作账本 · 多标签页恢复同步

**工作包补充验收。** 两个并发对账及一次随后重读只产生一条回执通知与一条就绪通知。广播使用初始操作所有者，服务端证明不符合时仍显示未知。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R105** · P2 | 系统操作已通过对账转为成功，却没有向其他标签发布回执与就绪状态<br>[dispatch.ts](../../src/gateway/dispatch.ts) | 对账只有在当前会话仍有权、持久账本仍为未知且证明完全匹配时才确认并广播。有效证明与另一个延迟失败或畸形证明交错，所有仍有权的读者最终返回已受理，只有一次 receipt 和 state。中途撤销授权者被拒。见 gateway-r105-final.log。 |

### F-P1-06　工作区编辑器 · 草稿防丢与未发送回执解锁

**工作包补充验收。** 仅在内存的草稿离开编辑器后仍可在设置中导出；页面离开时尝试保存。已发出的保存只凭同操作、方法、项目与文件的本地明确未发送证据解锁；模拟浏览器存储读取也抛错的路径。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R07** · P2 | 文件草稿持久化失败后缺少页面离开保护<br>[FileEditor.tsx](../../web/components/FileEditor.tsx) [WorkspacePanel.tsx](../../web/components/WorkspacePanel.tsx) [useDraft.ts](../../web/hooks/useDraft.ts) | 在设置中切离编辑器后仍可列出仅存内存的草稿，导出所有未保存内容，或明确放弃。26 万字符输入的最后一个字、写失败、恢复存储后成功落盘、关闭提示分别测试。见 last-draft-auth.log、late-storage.log。 |
| **R08** · P2 | 切离编辑器后到达的明确未发送结果未解除文件保存锁<br>[FileEditor.tsx](../../web/components/FileEditor.tsx) | 匹配原操作、方法、项目、路径及活动/有界历史的明确未发送证据才解除锁。已切离且读取浏览器暂存抛错时仍可恢复，晚到的结果不会覆盖重新输入的文字或重发操作。见 late-storage.log。 |

### F-P1-07　受管 Git 工作树 · 工作区事务恢复与两级配额管理

**工作包补充验收。** 用真实 Linux Git 覆盖登记、部分物化、移动、修指针与提交阶段的中断。完整暂存材料核对后发布，残缺字节归档可查；试过前置连续拒绝后仍可领取槽位。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R10** · P2 | 工作树退役移动到 retired 后失败，已有绑定无法通过受支持流程检查或恢复<br>[workspace_worktrees.py](../../deploy/workspace_worktrees.py) [worktree-bindings.ts](../../src/runtime/worktree-bindings.ts) | 工作树已移入退役目录但未完成时仅显示完成退役和原回执核对提示，保留版本、确认与文件。原操作收尾、绑定发布、Linux 文件状态按 runtime.md/deploy.md 验收。 退役结果未知时，通过原始 operationId、摘要、受管绑定与期望修订进行对账。新记录保存原始请求，老记录缺字段时从原生受控状态核回。工作树见证套件逐一测试两种记录，成功后仅释放所属绑定。真实 Git 跨位置收尾见部署底稿。 reader 按托管绑定核对活动、归档、退役三处状态，依据原始回执扫描退役记录，恢复原请求时核对摘要、checkout 身份及修订。test_retire_repairs_moved_checkout_using_original_operation、test_pending_retire_after_lock_and_after_registration_repair_is_retryable 向实际 Git 注入锁后、移动后修指针前、修指针后三种中断。能够检查、幂等完成或验证原回执。支持原版不含请求正文的收尾。均通过。 对应验收底稿见 web.md、runtime.md、deploy.md。 |
| **R11** · P2 | 工作树 phase 日志遗留完整 .state-next 后，后续归档/恢复/退役持续被拒绝<br>[workspace_worktrees.py](../../deploy/workspace_worktrees.py) [workspace_store.py](../../deploy/workspace_store.py) | 状态文件发布中断由原生部署模块收尾。主管能够重新读取原操作，保持绑定和版本一致。相关用例见 `worktree-witness.test.ts` 及部署的状态文件恢复用例。 phase 日志单独验证原操作、绑定、HEAD 与观测阶段后发布。test_phase_receipt_completes_only_with_original_operation_and_real_phase 覆盖完整待发布、终态、不同操作、截断保护及后续恢复，通过。 对应验收底稿见 runtime.md、deploy.md。 |
| **R111** · P2 | 部分工作树无副作用前置失败被记为 unknown，并占用有限记录槽<br>[workspace.py](../../deploy/workspace.py) [workspace_worktrees.py](../../deploy/workspace_worktrees.py) [workspace_store.py](../../deploy/workspace_store.py) | 确认未发出的操作只释放匹配的预约，已知有可能生效的保留，核对原生受理、已提交结果和回执。见 `worktree-witness.test.ts` 和部署的无副作用断言。 工作树运行记录在首个可能改变工作树的步骤才计副作用，重复收尾保留原不确定性。test_preflight_failures_release_capacity_and_safe_relative_links_survive_archive 在两槽限制下连续五次拒绝不存在的引用，均明确未发送且新操作仍获准。中断于 Git 登记后的样本保留 unknown。通过。 对应验收底稿见 runtime.md、deploy.md。 |
| **R112** · P2 | 工作树创建在注册之后、物化完成之前中断会遗留占用<br>[workspace_worktrees.py](../../deploy/workspace_worktrees.py) [worktree-bindings.ts](../../src/runtime/worktree-bindings.ts) | 原始创建已受理但回复丢失时从原 operationId+digest 找回，完成一次私有绑定与公开回执的事务提交。重复核对不再创建或重复绑定，错误摘要不产生成功结果。 按原操作及请求摘要重新认领已登记工作树，早期记下 inode 和 HEAD，继续物化前逐个核对现有文件、权限及暂存索引。test_registered_creation_recovers_original_binding_with_partial_files 在登记后、部分文件已写、索引就绪时恢复，同一原回执反复查询一致。遇意外文件保留原字节并拒绝覆盖。通过。 对应验收底稿见 runtime.md、deploy.md。 |
| **R113** · P3 | 创建前和创建回执阶段的同类名额错误分别使用中英文<br>[worktree-bindings.ts](../../src/runtime/worktree-bindings.ts) | 创建前的数量上限与回执确认时的数量上限均返回中文。后者提示原目录可能已建，应核对原有回执。验证在切换 native home、已有 32 个绑定、存在未知预约时对同实例正确限制。 对应验收底稿见 runtime.md。 |
| **R141** · P3 | 截断的 .state-next 没有可用的一般性收尾手段，恢复读取可能看不到新状态<br>[workspace_store.py](../../deploy/workspace_store.py) [workspace_recovery.py](../../deploy/workspace_recovery.py) | 回收材料在网页按字节恢复。超过预览大小与 JSON 转义超预算分别说明。准备发布和已保留的恢复记录展示先前状态、字节数、摘要和动作，不据此把未知原操作判为成功。 recovery/read 在原项目锁下核对发布状态和临时字节，返回前一状态、摘要及发布/保留处置。不完整或冲突材料原样留证。已确认回执清理时将异常临时材料移入有界独立存档。test_unpublished_receipt_and_archived_evidence_are_visible_without_overwriting_published 覆盖完整、截断、摘要冲突和没有旧回执，均保持预期状态并可继续新操作。通过。 test_ack_after_interrupted_publication_archives_raw_evidence_and_releases_capacity 用一个槽位验证异常字节归档可检索且后续操作能继续。test_completed_receipt_can_publish_interrupted_ack_without_changing_result 验证中断于回执确认落盘时只能追加确认标记，原结果逐字段一致。 对应验收底稿见 web.md、deploy.md。 |

### F-P1-08　部署构建沙箱 · 失败归档与挂载清理

**工作包补充验收。** 独立 Linux 镜像中用普通及 DNS 两个真实 ext4 卷走失败归档，并读出卷内原字节；归档前核实挂载、设备、生产者及全部 DNS 重试单元，旧单元归属不明时保留现场。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R107** · P2 | 普通和 DNS 构建在已挂载阶段失败后，自助归档会因挂载仍在而拒绝<br>[build.py](../../deploy/build.py) [dns_caddy_build.py](../../deploy/dns_caddy_build.py) [candidate_archive.py](../../deploy/candidate_archive.py) | 归档先证明生产者停止、cgroup 空，再核对挂载地址、ext4、loop 后端文件、权限、实际设备和挂载选项。test_failed_archive_verifies_and_unmounts_ordinary_image_after_preparation、test_dns_retry_units_and_loop_image_cleanup_match_producers 使用两个真实 16 MiB ext4 loop 镜像，经正式普通/DNS 归档后通过 debugfs 逐字节读出镜像中保留的文件。前者还含已写成功准备记录但来不及卸载的情形。未知挂载、停止不明、归档中断和重试另由原有 candidate_archive 测试覆盖，均通过。 对应验收底稿见 deploy.md。 |
| **R108** · P3 | 候选列表和菜单未体现失败候选、DNS 构建的可恢复操作<br>[operator.py](../../deploy/operator.py) [candidate_archive.py](../../deploy/candidate_archive.py) | 候选列表可识别成功、失败、DNS 及未完成归档。test_optional_archive_digest_and_exact_failed_or_dns_archive_choice 走真实菜单和参数解析器，失败普通候选带 --failed，DNS 调用专门恢复命令。列表读取不移动镜像。通过。 对应验收底稿见 deploy.md。 |
| **R109** · P2 | DNS 拉取重试的随机单元标识未纳入事后归档的停止检查<br>[dns_caddy_build.py](../../deploy/dns_caddy_build.py) [dns_archive.py](../../deploy/dns_archive.py) | DNS 创建构建时持久绑定全部派生单元名，每次启动前更新已尝试记录。归档同时核对固定单元名、实际重试及控制组。test_fetch_retry_preserves_cache_and_uses_one_runtime_budget、test_fetch_stops_after_three_failed_attempts 和真实 loop 测试通过。原版无清单、存在身份不明的活动拉取时停止归档，等待其结束，避免停止别的任务。 test_legacy_unbound_active_dns_fetch_is_retained 对没有旧重试绑定、同实例仍有未知历史抓取单元运行的状态执行清单及归档，正确保留原目录，未停止任何无关单元。生产记录登记真实重试前落盘，保留完整确定性编号并复核已发起序列。 对应验收底稿见 deploy.md。 |

### F-P1-09　前端模型目录状态 · 跨供应商草稿续接与终端切换

**工作包补充验收。** 草稿可只重选模型。仅在旧目录无歧义时保留模型及强度。普通导航保留活跃终端，新建 PTY 失败保留当前输出，跨程序切换单独确认。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R114** · P2 | 缺失草稿供应商且目录有其他供应商警告，进入同会话时阻断发送和恢复<br>[Workspace.tsx](../../web/Workspace.tsx) [provider-models.ts](../../web/lib/provider-models.ts) | 草稿供应商未知时新增只清模型/强度的恢复动作。已知别名延续。旧无供应商目录按唯一模型+支持强度显式装入 resume 请求。provider-catalog、model-picker、resume、execution-drafts。 对应验收底稿见 web.md。 |
| **R115** · P3 | 完整无供应商标签的旧模型选项在续接时静默消失<br>[provider-models.ts](../../web/lib/provider-models.ts) [ModelPicker.tsx](../../web/components/ModelPicker.tsx) [Workspace.tsx](../../web/Workspace.tsx) | 草稿供应商未知时新增只清模型/强度的恢复动作。已知别名延续。旧无供应商目录按唯一模型+支持强度显式装入 resume 请求。provider-catalog、model-picker、resume、execution-drafts。 对应验收底稿见 web.md。 |
| **R119** · P2 | 普通切回聊天或点击另一顶栏终端入口会切换活跃 PTY 程序，使其仅可关闭<br>[Workspace.tsx](../../web/Workspace.tsx) [TerminalPanel.tsx](../../web/components/TerminalPanel.tsx) | 会话/项目终端展示状态与 PTY 程序分离，有活动 PTY 的跨程序切换明确确认。已确认新 PTY 后才清屏和重放缓冲，创建失败保留原屏。terminal、workspace-handoff 检查 PTY、请求丢失、身份切换、关闭和确认。 对应验收底稿见 web.md。 |
| **R120** · P3 | 新终端打开请求失败前先复位显示，原保留输出可能丢失<br>[TerminalPanel.tsx](../../web/components/TerminalPanel.tsx) | 会话/项目终端展示状态与 PTY 程序分离，有活动 PTY 的跨程序切换明确确认。已确认新 PTY 后才清屏和重放缓冲，创建失败保留原屏。terminal、workspace-handoff 检查 PTY、请求丢失、身份切换、关闭和确认。 对应验收底稿见 web.md。 |

### F-P1-10　移动端手势、软键盘与弹窗焦点管理

**工作包补充验收。** 普通导航不主动聚焦输入；主动重命名进入名称框。顶层取消、输入法、抽屉项目/会话选择、断线和返回设置分别测。四种 Edge 视口包含缩放后的矮屏，仍能读消息、操作最后一个设置并发送一次。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R62** · P2 | 打开重命名会话后，直接打字无效，按 Enter 会关闭窗口<br>[RenameDialog.tsx](../../web/components/RenameDialog.tsx) [Dialog.tsx](../../web/components/Dialog.tsx) | 明确选择重命名时才主动聚焦名称输入。对话框原生取消和叠层处理看 dialog、sidebar-management。 对应验收底稿见 web.md。 |
| **R92** · P2 | 普通返回聊天会主动聚焦输入框，手机 Edge 反复弹出软键盘<br>[Workspace.tsx](../../web/Workspace.tsx) | 返回聊天主动聚焦阅读区。普通 dialog 关闭避免原生还原为文本控件。独立 Edge 触屏模拟逐步检查加载、删除弹窗取消、工具进入、返回聊天、新建均未把焦点放进文本框。主动点输入框则有焦点。此为桌面 Edge 移动模拟，不等同手机实际软键盘弹出次数。 对应验收底稿见 web.md。 |
| **R121** · P2 | 只产生原生 cancel 的系统关闭动作被通用对话框吞掉<br>[Dialog.tsx](../../web/components/Dialog.tsx) | 原生独立 cancel 仅触发最上层对话框。Escape 后紧跟原生 cancel、内层已消费 cancel、IME 组合中及结束同一动作的 cancel 均不会再关闭一层。dialog.test.tsx 实测这些动作和嵌套、后台失活。web-resync-final.log。 |
| **R122** · P3 | 在抽屉内选另一个项目后立即关闭，会话列表需重新打开<br>[Workspace.tsx](../../web/Workspace.tsx) | 手机上只切项目保留抽屉，侧栏确认、设置项目管理的来源分别记录，完成/取消可返回项目设置。当前抽屉显示真实执行身份限制。sidebar-management、workspace-handoff、project-handoff。 对应验收底稿见 web.md。 |
| **R123** · P2 | 展开执行设置后聊天区域被挤至零高度<br>[styles-usability.css](../../web/styles-usability.css) [styles.css](../../web/styles.css) | 真实桌面 Edge 触屏模拟在 390×844、844×390、390×480、740×290 展开执行设置，末两种根字号为 24px。聊天消息区实测依次为 296.48、93.81、143.61、134px，最后一项可选择、发送按钮可触达，关闭设置后真实轻点发送恰产生一次 turn/start。viewport 告知支持的手机浏览器按键盘调整布局。缩小的浏览器视口覆盖键盘占位条件，物理手机系统键盘尚待验收。web-short-sent.log。 |
| **R124** · P3 | 从设置执行项目重命名/移除后原设置页被卸载，取消也不能回原处<br>[Workspace.tsx](../../web/Workspace.tsx) | 手机上只切项目保留抽屉，侧栏确认、设置项目管理的来源分别记录，完成/取消可返回项目设置。当前抽屉显示真实执行身份限制。sidebar-management、workspace-handoff、project-handoff。 对应验收底稿见 web.md。 |
| **R150** · P3 | 连接中断后，从移动导航选择会话的身份错误藏在当前弹窗下<br>[Workspace.tsx](../../web/Workspace.tsx) | 手机上只切项目保留抽屉，侧栏确认、设置项目管理的来源分别记录，完成/取消可返回项目设置。当前抽屉显示真实执行身份限制。sidebar-management、workspace-handoff、project-handoff。 对应验收底稿见 web.md。 |

### F-P1-11　CI/CD 发布授权与供应链门禁

**工作包补充验收。** 普通 PR、授权文件改动、正式发布分别验证。受信源与证据要求直接绑定，授权损坏可见。临时 Git 有两个真实父提交，各类不符证据均被拒；未操作远端发布。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R47** · P3 | 可信非 PR 流程遇到损坏的授权文件时静默回退<br>[ci-checks.mjs](../../scripts/ci-checks.mjs) | 即使授权已成历史，也先核对字段、批准时间、版本结构与摘要。显式发布授权必须匹配当前源码。合法旧授权不阻断小改。篡改日期/校验和和强制错源均被拒。extra-five.log。 |
| **R126** · P2 | PR 授权仓库变量保留非空旧值时，新源码摘要失配会令普通 PR 计划提前失败<br>[ci-checks.mjs](../../scripts/ci-checks.mjs) [affected.yml](../../.github/workflows/affected.yml) | 普通 PR 遇陈旧授权变量仍可按变更范围运行。只要 PR 更改授权文件，就必须与受信内容完全匹配。覆盖变量为空、非空陈旧、有效、授权损坏及显式发布等组合。见 ci-final.log、tooling-accepted.log。 |
| **R127** · P2 | 发布入口没有把当前源码摘要与同一源码已通过完整验证的证据绑定<br>[publish-release.mjs](../../scripts/publish-release.mjs) [ci-checks.mjs](../../scripts/ci-checks.mjs) | 发布入口匹配同一 Git HEAD 的成功运行、固定产物身份、源码摘要、跨平台集、授权文件摘要和无缺口结果，取证不符由本地发布夹具拒绝。parent-more.log / publish-release。没有向 GitHub 实际发布。 |
| **R128** · P3 | 发布标题固定为此次版本主题<br>[publish-release.mjs](../../scripts/publish-release.mjs) | 从目标版本的受审发布说明生成标题，缺标题时按版本标签回退。publish-release 临时 Git 与测试服务检查最终请求。未发布远端版本。 对应验收底稿见 parent-evidence.md。 |

### F-P1-12　运行时会话转换与只读诊断互斥

**工作包补充验收。** 使用原生双供应商及受控缺通知场景验证默认协作模式可转换、重读确认已保存设置及源线程恢复。只读 doctor 另有容量，并按原约束清理进程。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R133** · P2 | 原会话已成功取消订阅，第二次只读预检明确拒绝，仍对全局标记未知并遗留复制保护<br>[thread-conversion.ts](../../src/runtime/thread-conversion.ts) [service.ts](../../src/runtime/service.ts) [attachments.ts](../../src/runtime/attachments.ts) | 原会话已取消订阅后再次只读预检失败，回执明确为目标未建、未发送输入，并结束原先的复制预约。见 `source close followed by reinspection failure records that no target was created`。 对应验收底稿见 runtime.md。 |
| **R134** · P3 | 只读 doctor 执行依赖全实例空闲并持有配置互斥<br>[cli-diagnostics.ts](../../src/runtime/cli-diagnostics.ts) [service.ts](../../src/runtime/service.ts) | 固定只读 doctor 不持有原生配置写互斥。从专属流程启动和收尾，并保留私有输出。受控 doctor 与独立新会话并行用例、Linux 真实 CLI doctor/目录诊断两条均已执行。 对应验收底稿见 runtime.md。 |
| **R163** · P2 | 默认新会话未显式保存协作设置，供应商转换在复制目标后报错<br>[thread-conversion.ts](../../src/runtime/thread-conversion.ts) | 跨供应商转换有独立目标 ID。用户可选择特定 ready 副本（默认皆未选），在转换完成后整组移交。普通转换、未选和失败的转换不会移动副本。正式 CLI + 两个本机供应商端点已验证成功、另一页同时弃置及存储写入与再读同时失败。结果为 moved、not_moved 或 unconfirmed，三种情况下只要转换已成功便返回实际新 ID，可打开目标并核对源、目标与原操作。详见 web-handoff-provider-native.log。 原始快照没有协作设置时，从同源会话权威原生 resume 的元数据补齐，核对相同 cwd、会话、供应商后才创建新目标。显式与缺省设置两组转换均通过。 |
| **R164** · P2 | 合法会话的设置更新没有通知时，供应商转换超时并留下待核实目标<br>[thread-conversion.ts](../../src/runtime/thread-conversion.ts) | 跨供应商转换有独立目标 ID。用户可选择特定 ready 副本（默认皆未选），在转换完成后整组移交。普通转换、未选和失败的转换不会移动副本。正式 CLI + 两个本机供应商端点已验证成功、另一页同时弃置及存储写入与再读同时失败。结果为 moved、not_moved 或 unconfirmed，三种情况下只要转换已成功便返回实际新 ID，可打开目标并核对源、目标与原操作。详见 web-handoff-provider-native.log。 设置写入后以重新打开目标读取到的持久设置核对，合法幂等写不要求再收到可省略的设置更新通知。测试实跑无通知及带通知两种情况。 |

### F-P2-01　部署控制面安全 · Root 特权降权与 Sudoers 校验

**工作包补充验收。** 旧普通 HTTPS 验证在实际低权限 UID/GID 运行；配置层与执行模式的向前完成、回滚均检查候选 sudo 配置后再发布。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R110** · P2 | 旧普通 HTTPS 实例迁移客户端标识时以控制进程身份运行 Caddy 配置校验<br>[https.py](../../deploy/https.py) | 旧普通 HTTPS 客户端标识迁移与正常安装复用同一低权限校验器。test_client_identity_upgrade_preserves_stopped_edge_and_persisted_state 跟踪正式迁移的 UID/GID 参数。test_plain_edge_validator_executes_as_the_unprivileged_edge_identity 实际启动校验程序，验证非 root uid/gid、补充组和 NoNewPrivs。通过。 对应验收底稿见 deploy.md。 |
| **R129** · P2 | 配置层和执行模式的中断恢复路径未重新预检即发布 sudo 策略<br>[config_layer.py](../../deploy/config_layer.py) [execution_mode.py](../../deploy/execution_mode.py) | 配置层/执行身份的候选应用与回滚均使用同一发布函数，两次 visudo 分别检查私有候选与发布文件。test_invalid_sudo_candidate_retains_existing_policy 实际运行 visudo，错误候选无法替换现行文件。test_partial_publication_recovers_with_mixed_old_new_sudo_and_config 与配置层双向恢复组覆盖失败及重试，均通过。 对应验收底稿见 deploy.md。 |

### F-P2-02　视觉可访问性 · 深色与浅色主题对比度

**工作包补充验收。** Edge 阻塞 React 主包，验证首帧已用保存的深色主题。检查浅深配色、三种欢迎图标、发送提示与占位符的实际颜色。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R26** · P2 | 手机浅色界面的输入提示和占位文字对比度过低<br>[styles.css](../../web/styles.css) | Edge 390×844 浅色实际计算的输入提示与底色对比 5.39:1。深色与手动主题另作验证。 对应验收底稿见 web.md。 |
| **R73** · P3 | 欢迎卡片的三种装饰图标在深色模式仍使用浅色底<br>[styles.css](../../web/styles.css) [styles-responsive.css](../../web/styles-responsive.css) | Edge 实测三张欢迎卡的主题图标有三种独立颜色，light 与 dark 六个计算色值见 web-edge.log。 |
| **R125** · P3 | 保存手动主题与系统相反、加载较慢时，刷新先显示错误颜色的空白背景<br>[index.html](../../web/index.html) [App.tsx](../../web/App.tsx) [styles-responsive.css](../../web/styles-responsive.css) | 解析头部时由同源 theme.js 应用已存主题。Edge 在亮色系统启动并使用已存 dark，实际颜色正确。另在真实 Edge 阻塞 React 主包，在根节点未挂载、系统浅色时直接观测储存的 dark 已在 HTML 上生效。 对应验收底稿见 web.md。 |

### F-P2-03　前端长会话渲染与大文件序列化性能

**工作包补充验收。** 长会话量了消息行重绘和预算临界点。行数、耗时、导出内存与账本响应数据见测量表；离开页面前跟踪聊天及文件草稿最后一次中文输入。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R48** · P3 | 流式增量仍反复遍历并序列化完整历史<br>[useConversation.ts](../../web/hooks/useConversation.ts) [history.ts](../../web/lib/history.ts) | 缓存按变更行维护历史预算，覆盖流式增量、400 万字符上下 1 字符与精确序列化对照。初次建立预算后，修改一行不再读取未改行。见 history-delta.log、history-browser.json。 |
| **R49** · P3 | 每次聊天草稿写入仍同步遍历其他草稿、写入并回读<br>[useDraft.ts](../../web/hooks/useDraft.ts) [drafts.ts](../../web/lib/drafts.ts) | 连续修改先记内存，一批按 120ms 合并。离页、提交、导航、卸载强制刷新。drafts、draft-navigation、execution-drafts 覆盖保存失败、离开、重试、旧回执、草稿清理。 对应验收底稿见 web.md。 |
| **R56** · P2 | 文件草稿输入仍同步序列化整份文件并回读存储<br>[FileEditor.tsx](../../web/components/FileEditor.tsx) [file-drafts.ts](../../web/lib/file-drafts.ts) | 文件草稿按短窗口落盘，切换文件、卸载及离开立即保存。26 万字符加四次连续编辑，切离前避免反复同步写入，切离后最后一个中文字节仍在。见 last-draft-auth.log、late-storage.log。 |
| **R84** · P2 | 浏览器导出较大回执归档时，渲染进程工作集显著增长<br>[receipt-archive.ts](../../web/lib/receipt-archive.ts) | 浏览器分块构造 Blob 并增量校验 SHA-256。真实 Edge 导出 4、32、80、128 MiB 并验证完整性，另在 24 MiB 时取消 80 MiB 导出。记录 JS 堆、渲染进程内存与取消清理。见 archive-browser.jsonl、archive128.jsonl。 |
| **R85** · P2 | 长历史中不变的消息行反复渲染，正常输入和流式更新出现秒级停顿<br>[Workspace.tsx](../../web/Workspace.tsx) [Messages.tsx](../../web/components/Messages.tsx) [MessageItem.tsx](../../web/components/MessageItem.tsx) | 稳定历史区域和独立行的输入属性。真实 Edge 在约 70 万字符会话中输入草稿，历史消息行重绘 0 次，8 次流式更新各只重绘 1 行。同一台 Edge 对同一份 40 回合、1,612,211 UTF-16 码元历史，各输入 35 键。原标签与修复后的同步输入处理 p95 在正常 CPU 下分别为 201.6 ms 和 4.7 ms，四倍限速下分别为 827.8 ms 和 9.0 ms。原版两组按键共重绘 2800 个历史行，修复后为 0。独立工作区从 v2.4.0 标签提取网页做对照。见 history-browser.json、history-original.json、history-keys.json。 |

### F-P2-04　前端工作区监测 · 后台标签页恢复

**工作包补充验收。** 按项目、代际、路径保留上一份完整基线。覆盖后台、暂停恢复、删除、换项目及部分失败；没有变更的轮询不更新整个面板。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R12** · P2 | 文件监测暂停后重新启用会丢失版本比较基线<br>[useWorkspaceWatch.ts](../../web/hooks/useWorkspaceWatch.ts) | 文件观察基线绑定 API、项目、世代及监测路径。同范围暂停或标签隐藏后仍能发现文件删除，无变化轮询沿用原状态。workspace-watch 的隐藏、恢复、慢读、部分失败、注销 8 种路径见 parent-new-regressions.log。 |

### F-P2-05　工作区 Git 索引与引用校验

**工作包补充验收。** 同一真实 Git 仓库对照暂存后的模式，涵盖属主/仅组执行位、新增与已跟踪文件。实际配置包含合法大写节名及非 UTF-8 注释。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R09** · P2 | 网页暂存用文件系统任一执行位计算 Git 模式，忽略 core.filemode 与 Git 的属主执行位语义<br>[workspace_git_view.py](../../deploy/workspace_git_view.py) [workspace_index.py](../../deploy/workspace_index.py) | 网页暂存尊重 Git core.filemode，开启时只依据属主执行位，关闭时保持已跟踪模式。test_git_mode_and_unrelated_reference_count_follow_selected_git_paths 覆盖 0654、0744、0644 及已跟踪可执行文件。通过。 对应验收底稿见 deploy.md。 |
| **R140** · P3 | Git 配置中大小写合法的节名或非 UTF-8 注释导致网页暂存配置被忽略或读取失败<br>[workspace_git_view.py](../../deploy/workspace_git_view.py) | 针对受控配置副本通过 Git 自身无 include 布尔查询解析。上述 Git 模式测试同时使用大写节/键、非 UTF-8 注释及标准 Git ls-files 对照，通过。 对应验收底稿见 deploy.md。 |

### F-P2-06　运行时跨平台进程控制 · macOS 本地开发与进程终止确认

**工作包补充验收。** macOS 已退出的空组可正常收尾；仍有子进程和身份或权限无法证明时走独立分支。具体受控与实机证据见 R13。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R13** · P2 | macOS 本地开发模式把已经正常退出的原生进程判成清理失败<br>[native.ts](../../src/runtime/native.ts) [posix-native.ts](../../src/runtime/posix-native.ts) | Darwin 用未收割的进程组身份与成员观察确认关闭，避免已经退出的组被误报。真机 Darwin 的进程组带后代自然退出和主动关闭均通过。故障注入另测进程组仍有活成员时的真实拒绝分支，以及权限错误返回时成员已经消失的分支。见 `posix-native.test.ts`。 对应验收底稿见 runtime.md。 |

### F-P2-07　前后端 JSON Schema 校验一致性与协议加载

**工作包补充验收。** 同一组方言、格式、普通数据中的 $ref 与深度预算由网页及主管共同校验，区分表单、提交与手动调用。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R14** · P2 | MCP 表单标为受支持，填写有效值后却因 Schema 方言被后台拒绝<br>[prompt-validation.ts](../../web/lib/prompt-validation.ts) [Prompts.tsx](../../web/components/Prompts.tsx) [validation.ts](../../src/runtime/validation.ts) | 运行时和浏览器认可同一组 draft-07 声明，编译前仅规范化 schema 节点上的方言。嵌套的受支持与未知方言、名为 `$schema` 的数据属性分别验证，见 `service.test.ts`。 对应验收底稿见 runtime.md。 |
| **R16** · P3 | JSON Schema 中合法的 $ref 数据字段被误当成引用，阻止 MCP 参数校验及结构化输出<br>[schema-budget.ts](../../src/runtime/schema-budget.ts) [mcp-schema.ts](../../src/runtime/mcp-schema.ts) [structured-output.ts](../../src/runtime/structured-output.ts) | 结构化输出和手动 MCP 校验共用按节点角色遍历的预算函数。属性命名为 `$ref` 与 const 数据中的 `$ref` 均可提交，真正指向外部的 schema 引用仍受限制。测试对同一对象调用两种入口，见 `mcp-schema.test.ts`。 对应验收底稿见 runtime.md。 |
| **R21** · P3 | MCP 表单的邮箱和 URI 在输入端通过，提交端拒绝<br>[prompt-validation.ts](../../web/lib/prompt-validation.ts) [Prompts.tsx](../../web/components/Prompts.tsx) [validation.ts](../../src/runtime/validation.ts) | 邮箱、绝对 URI 在网页端采用相同版本 Ajv 的 full 格式实现。主管经过有效邮箱、mailto URI、不合法域名及相对引用的对照，见 `service.test.ts`。 对应验收底稿见 runtime.md。 |
| **R136** · P3 | 手动 MCP 的 2019/2020 方言标识带空片段 # 时拒绝与规范形式内容相同的参数<br>[mcp-schema.ts](../../src/runtime/mcp-schema.ts) | 先规范 2019-09/2020-12 末尾空片段，分别通过带/不带 # 的有效值、越界值和本地引用对照，保留原有 draft-07 支持。见 `mcp-schema.test.ts`。 对应验收底稿见 runtime.md。 |

### F-P2-08　运行时会话组织 · 并发删除容错

**工作包补充验收。** 所有者列表只跳过明确不存在的会话并通知列表变化，其他已知所有者可读，其他服务或权限错误向调用方报告。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R71** · P2 | 一个所有者在刷新途中被删除会让整页附件所有者读取失败<br>[organization.ts](../../src/runtime/organization.ts) [native.ts](../../src/runtime/native.ts) | 对真正 CLI 返回的精确 `-32600 thread not loaded: <id>` 与明确不存在进行局部处理，其余返回错误保持可见。测试复现同页一个所有者被卸载，同时验证存活同伴、分页标志、错误引用其他 ID 时的传播。见 `organization.test.ts`。 对应验收底稿见 runtime.md。 |

### F-P2-09　网关反代身份分桶 · 登录防爆破限流

**工作包补充验收。** IPv4 映射地址及 IPv6 /64 实际归并，SQLite 注入 1,024 个来源检验只淘汰最老单次记录和无法腾出容量两种情况。已登录身份、登录限流与反代来源分别处理。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R130** · P2 | IPv6 客户端归并策略及全局限流表可能误伤新登录<br>[server.ts](../../src/gateway/server.ts) [auth.ts](../../src/gateway/auth.ts) | IPv6 /64 与 IPv4 映射地址统一，满 1024 个来源时只淘汰最旧的单次桶。对注入数据库存量的受控测试验证限额、同前缀共用及无可回收行时拒绝。last-draft-auth.log。 |

### F-P2-10　网关自动化调度器 · 并发启动与重连超时

**工作包补充验收。** 慢启动的项目和另一个独立项目并行；重连按原始开始时间挂回剩余时限，停止未发还原原状态。项目删除的中途失败回滚且可重试。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R23** · P2 | 一个自动任务启动等待会阻塞其他到期任务启动，可能错过五分钟窗口<br>[automation-scheduler.ts](../../src/gateway/automation-scheduler.ts) | 同轮到期的独立项目可并发领取与启动，同一项目保持串行，总并发受限。真实账本调度器使用一个刻意悬挂的启动和另一个正常启动检查独立进展。见 core-additions.log / automation-scheduler。 |
| **R87** · P2 | 自动化重连已读到原回合仍在运行，运行时限仍不会生效<br>[automation-scheduler.ts](../../src/gateway/automation-scheduler.ts) | 已运行任务在重连核对到原回合后按原 startedAt 恢复超时。过期任务可按原线程和回合发出停止，仍在审批或证据不明时保留相应状态。core-additions.log / automation-scheduler。 |
| **R131** · P2 | 明确未发送的停止会把待处理审批退回 running<br>[automations.ts](../../src/core/automations.ts) | 停止请求明确未派发时恢复停止前的真实状态及待审批标志，不将任务退成 running。含旧数据与账本重开，见 core-additions.log。 |
| **R132** · P2 | 删除项目时自动化暂停、排队清理和项目删除未原子提交<br>[ledger.ts](../../src/core/ledger.ts) [automations.ts](../../src/core/automations.ts) | 项目删除、计划暂停、排队运行取消以及关联回执在一个事务完成，成功提交后才发布事件。注入操作中段失败验证回滚和可重试。core-additions.log。 |

### F-P2-11　网关并发作用域 · 跨项目与同项目互斥粒度

**工作包补充验收。** Linux 的真实 Git 仓库、子目录、链接工作树与独立仓库分别核对身份；独立仓库并行，同源保持互斥，提示说明实际占用。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R34** · P3 | 部分非 Git 工作树操作因其他活动被拒绝时仍收到泛化的配置提示<br>[feature-methods.ts](../../src/core/feature-methods.ts) [dispatch.ts](../../src/gateway/dispatch.ts) | 独立仓库可并行。本机助手核对 Git common-directory 后根据设备号和 inode 生成共享资源身份，并在原写入助手中再次核对。真实 Debian/Linux 两个 Git 仓库 + linked worktree，通过同源同身份、独立异身份、写入时身份变更拒绝。见 web-r34-linux.log。workspace-service 同时挂起两笔独立工作树写，验证两笔都到达各自执行点，同源第三笔在写前拒绝。真机运行模型生成与文件实际同时修改未执行。 |

### F-P2-12　运行时故障隔离与同世代有界容量表

**工作包补充验收。** 语音及预测异常按会话隔离，敏感信息先脱敏。分别核对在途和已结清对象，结案指纹可用来防止重放；独立评估短秘密、普通数字及状态。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R35** · P2 | 同一运行世代的预测来源耗尽后，只能重启以恢复新增来源<br>[predictions.ts](../../src/runtime/predictions.ts) | 已完成并过期的预测释放活跃对象。同一运行世代仅保存不可重放的身份散列。连续 2,050 个不同来源完成并过期后可继续执行，最早来源仍拒绝重复受理。见 `predictions.test.ts`。 对应验收底稿见 runtime.md。 |
| **R36** · P2 | 同一运行世代的诊断凭据登记表用满后，新增登记需要重启<br>[redaction.ts](../../src/runtime/redaction.ts) [device-login.ts](../../src/runtime/device-login.ts) [mcp-oauth.ts](../../src/runtime/mcp-oauth.ts) | 临时设备码、一次性 OAuth 与配对凭据按各自失效时间回收，长期配置值保留。测试登记 320 个到期值后加入新凭据，核对新旧有效凭据的脱敏，以及单字符配置值对独立字段和普通数字的不同结果。 对应验收底稿见 runtime.md。 |
| **R38** · P2 | Guardian 身份表达到限额或发生冲突后停止捕获后续事件<br>[guardian.ts](../../src/runtime/guardian.ts) | Guardian 的历史身份散列与活跃审批分开，冲突只影响对应 review。单世代超过 2,048 次仍能捕获最后一次，已淘汰的旧 review 也不能重新产生审批能力。见 `guardian.test.ts`。 对应验收底稿见 runtime.md。 |
| **R64** · P2 | 单个预测结果长时间未返回，会阻塞其他会话的操作<br>[predictions.ts](../../src/runtime/predictions.ts) [service.ts](../../src/runtime/service.ts) | 预测超时或返回未知状态归到该会话。实测一条预测请求结果未知后，另一条会话完成历史读取并获得新回合 ID。见 `predictions.test.ts`。 对应验收底稿见 runtime.md。 |
| **R68** · P2 | 实时语音通知的局部校验异常仍会结束共享运行时<br>[realtime.ts](../../src/runtime/realtime.ts) [service.ts](../../src/runtime/service.ts) [native.ts](../../src/runtime/native.ts) | 语音帧局部验证失败时只停止该语音会话，停止证据不明时仅隔离该线程。畸形 PCM、会话中止、原生关闭通知和重新加载均有用例。见 `realtime.test.ts`。 对应验收底稿见 runtime.md。 |
| **R100** · P3 | 实时语音的原生错误字符串在所有者定向事件发出前也未使用统一诊断脱敏<br>[realtime.ts](../../src/runtime/realtime.ts) [service.ts](../../src/runtime/service.ts) | 在语音错误转发到归属连接前进行统一脱敏。实际正常格式错误事件中的 bearer 测试值由 SDK 接收后被隐藏，原始语音帧和普通聊天不走该替换。 对应验收底稿见 runtime.md。 |

### F-P2-13　运行时扩展与项目信任边界

**工作包补充验收。** 真实 CLI 判定主仓库和链接工作树配置来源；外部祖先、伪仓库标记与精确覆盖分别实测。技能预览另按当前项目权限判断。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R65** · P2 | 项目界面无法显示从父路径继承后实际生效的信任状态<br>[project-trust.ts](../../src/runtime/project-trust.ts) [ProjectTrustSettings.tsx](../../web/components/ProjectTrustSettings.tsx) | 并列提供精确偏好、有效值、来源和证据类型。实跑 Codex 本地配置层：普通祖先的信任不能启用仓库配置，linked checkout 或其主仓信任均可启用。无本地配置文件时由已核验 Git 根路径与实际原生 projects 配置联结。部署执行账号对工作树双向元数据进行校验。见 `rt-trust-linked.log`、`project-trust.test.ts` 和 `test_project_trust_roots.py`。 |
| **R82** · P2 | 从另一个项目看到的本地市场技能能选择却无法预览<br>[extensions.ts](../../src/runtime/extensions.ts) [dev-resources.ts](../../src/runtime/dev-resources.ts) [workspace_resources.py](../../deploy/workspace_resources.py) | 将预览权限从市场来源细分至具体技能，界面按当前项目授权展示或说明切换来源项目。技能原生层及网页 skill-library 回归分别核实。 本地插件技能返回 `skillPreviewAllowed`，查询和实际预览复用相同的受控资源读取判断。原生本地市场、技能来源和受限路径在扩展与资源测试覆盖。界面处理见网页底稿。 对应验收底稿见 parent-evidence.md、runtime.md。 |
| **R154** · P3 | 技能祖先路径判定仅检查 .git 是文件或目录，未验证实际仓库边界<br>[workspace_resources.py](../../deploy/workspace_resources.py) | 已注册项目的祖先技能访问需核实真实 Git 元数据与关联方向，受限开发运行方式也核验 Git 根及 linked backlink。见资源测试及对应部署底稿。 上级技能根只纳入真实的最近 Git 工作树，使用常规仓库检查，固定全局或本项目范围独立识别。test_catalog_ancestor_skill_is_limited_to_nearest_git_worktree 先拒绝空 .git 标记，随后 git init 验证真实上级目录。外部目录及普通同名标记未获授权。通过。R82 的合法跨项目市场授权由运行时路由验收。 对应验收底稿见 runtime.md、deploy.md。 |

### F-P2-14　部署 HTTPS 与控制面恢复路由

**工作包补充验收。** 真实与合成遗留状态分别覆盖中断下载、获授权的配置迁移和已识别缓存；对真实内容变化、缺失迁移见证或不可信文件保留拒绝。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R63** · P2 | 普通 HTTPS 下载中断后残留文件会阻断重试，缺少核对和恢复入口<br>[https.py](../../deploy/https.py) [operator.py](../../deploy/operator.py) | 通过同一 HTTPS 配置入口处理旧残缺归档，按 SHA256 有界保留，复用有效官方摘要归档，并仅认领与归档相符的旧可执行文件。test_plain_edge_recovers_interrupted_download_and_only_adopts_pinned_binary 覆盖连接中断、重复坏内容、错误摘要、恢复成功、丢失 manifest、已经存在不同二进制，验证安装文件和保留材料。通过。测试用固定合成发行包及离线下载替身。 对应验收底稿见 deploy.md。 |
| **R137** · P2 | 旧 prepared 快照遇合法实例迁移后可能失去自动复位路径<br>[https.py](../../deploy/https.py) [config_layer.py](../../deploy/config_layer.py) | 旧 prepared 元数据须与原已恢复首配事务逐字节相符。通过 root 私有且已提交的配置层、执行身份、代理快照按允许字段追溯至当前 HTTP 实例。test_legacy_prepared_reset_requires_matching_recovered_evidence 和 test_prepared_reset_accepts_only_an_attested_committed_instance_migration 覆盖无迁移、合法迁移、记录缺失、错误端口及未提交变更。证书与事务保留。通过。 test_prepared_reset_accepts_only_an_attested_committed_instance_migration 增测连续两次真实格式的配置演进证明。缺少第二段的场景拒绝处理，补全后成功只重置 HTTPS 准备标记。 对应验收底稿见 deploy.md。 |
| **R139** · P3 | 合法老控制目录残留 Python 缓存时相同版本可能误创建新代<br>[control_update.py](../../deploy/control_update.py) | 代际校验与同版本检测采用同一旧缓存过滤。test_identical_control_material_verifies_without_restart_or_generation 向旧目录加入残留字节码，相同材料复用原代且不重启。已有控制目录变化/回滚测试通过。 对应验收底稿见 deploy.md。 |

### F-P2-15　工作区大文件、符号链接工作树与历史扫描预算

**工作包补充验收。** 大文件以大小与 SHA-256 确认，内部相对链接、大型 .git 元数据、深历史目录分开测。旧回执、越界路径及未核清来源保留原有保护。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R24** · P2 | 常见符号链接使受管工作树可读取却无法绑定或归档<br>[workspace_worktrees.py](../../deploy/workspace_worktrees.py) | 工作树 manifest 对普通相对链接核对目标仍在工作树，记录链接自身及目标字符串。test_preflight_failures_release_capacity_and_safe_relative_links_survive_archive 使用实际 node_modules/.bin 相对链接进行绑定、归档和还原，并读回目标字节。逃逸链接、外部共享锁及嵌套仓库仍保守处理。通过。 对应验收底稿见 deploy.md。 |
| **R40** · P2 | 超出 512 KiB 的文件仍不能从网页复制或删除<br>[workspace.py](../../deploy/workspace.py) [workspace_paths.py](../../deploy/workspace_paths.py) [workspace_store.py](../../deploy/workspace_store.py) | 回收材料在网页按字节恢复。超过预览大小与 JSON 转义超预算分别说明。准备发布和已保留的恢复记录展示先前状态、字节数、摘要和动作，不据此把未知原操作判为成功。 将复制/移除与编辑预算分开，小文件仍可编辑，至 8 MiB 的文件可流式校验、复制、删除、备份、按原字节恢复。超过上限在元数据中显示不可执行。test_large_binary_copy_remove_restore_and_stale_revision 对 720000 字节含 NUL 文件逐字节比对，旧修订拒绝。通过。 对应验收底稿见 web.md、deploy.md。 |
| **R41** · P2 | 较大 Git 仓库的元数据超过固定遍历预算后，网页拒绝写入<br>[workspace_commit.py](../../deploy/workspace_commit.py) [workspace_index.py](../../deploy/workspace_index.py) | 核对写入涉及的 HEAD、引用链、reflog、压缩引用、对象写入目录，避免无关引用数构成全库上限。test_git_mode_and_unrelated_reference_count_follow_selected_git_paths 实际建立 4210 个无关 Git 引用，再暂存并提交，git rev-parse HEAD 一致。通过。 对应验收底稿见 deploy.md。 |
| **R42** · P2 | 大型历史目录超过索引扫描上限后，无法定位会话祖先<br>[thread_history.py](../../deploy/thread_history.py) | 精确查找使用目标会话 ID。用 10,050 个其他实际目录项与目标 rollout 验证祖先查找。超出独立预算分支仍返回具体原因。见 `test_thread_history.py`。 对应验收底稿见 runtime.md。 |

### F-P2-16　前端断线重连对账与紧急恢复批处理

**工作包补充验收。** 混合批次部分成功、超时、授权丢失、归档和第二标签介入分别核对。原系统成功凭据与各子项的关闭依据独立，持久保存剩余成员。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R53** · P2 | 重连对账会把服务端仍在处理的回执记为结果未知<br>[Workspace.tsx](../../web/Workspace.tsx) [operations.ts](../../web/lib/operations.ts) [Recovery.tsx](../../web/components/Recovery.tsx) | 服务端 pending、dispatching 均为本地 pending。延迟结果不能覆盖 accepted/not_sent。operations 定向用例验证 unknown→pending、去重阻止重发、迟到 dispatching 保留 not_sent。 对应验收底稿见 web.md。 |
| **R66** · P3 | 紧急恢复批处理无法说明单项失败是超时还是回执状态不符<br>[emergency-recovery.ts](../../web/lib/emergency-recovery.ts) [EmergencyRecovery.tsx](../../web/components/EmergencyRecovery.tsx) | 紧急恢复逐项区分正在处理、未登记、超时、授权失效和回执身份不符，保留未完成的成员。parent-new-regressions.log、recovery-late.log 及既有 emergency-recovery 两类用例。 |
| **R116** · P2 | pending/unknown 的紧急恢复回执被归档，会报“身份不匹配”<br>[EmergencyRecovery.tsx](../../web/components/EmergencyRecovery.tsx) | 已归档的未知恢复主记录单列，允许人工核对后关闭原记录。没有重试系统恢复或将原操作写成成功。parent-new-regressions.log / emergency-recovery。 |
| **R117** · P3 | 部分旧操作核对未完成后，确认紧急恢复会丢失本次批次快照<br>[EmergencyRecovery.tsx](../../web/components/EmergencyRecovery.tsx) | 主记录由事务持久保存尚待核对的原始子集。部分完成、关闭后重开、其他窗口已受理并人工归档均可继续，仅查询原号。parent-new-regressions.log 与 recovery-late.log。 真实归档标识、编号与作用域全部匹配时，凭同一子操作已关闭的本地历史可收尾。子操作仍活跃则保留并指向人工核对，不匹配的归档仍拒绝。retires a correctly archived captured member only with its own durable local closure 同批检验上述三种情况、剩余编号和逐笔只读请求。 |
| **R118** · P3 | 持续打开的紧急恢复窗口未跟踪另一窗口产生的 system/recover 本地记录<br>[EmergencyRecovery.tsx](../../web/components/EmergencyRecovery.tsx) | 第二标签开启时订阅本地变动。准入事务同时检查未关闭恢复和首次确认所见操作。真实 Edge 两页共享 IndexedDB，分别在旧恢复已受理和刚刚关闭时提交旧确认，均未重复重启。显式重新核对后能开始新的恢复。见 deploy-r118-real-edge.log、deploy-recovery-cross.log。 |

### F-P2-17　前端高影响操作防误触

**工作包补充验收。** 删除队列、清除目标、退出模型账号和停止进程都显示当前目标；首击、取消与确认分别检查，产生请求数量可核对。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R57** · P2 | 队列删除、清除目标等高影响操作可被单次点击直接执行<br>[TaskPanel.tsx](../../web/components/TaskPanel.tsx) [ProcessPanel.tsx](../../web/components/ProcessPanel.tsx) [AccountSettings.tsx](../../web/components/AccountSettings.tsx) | 队列删除、清除目标、退出模型账号和停止进程需确认目标。设备退出第一击请求数 0，第二击仅退出一次，还覆盖读账户失败的路径。见 ui-item-direct.log、parent-ui-finalcheck.log 中的 device-login、workflows 和 process-remote 的定向测试。 |

### F-P2-18　仓库凭据防护与 PR 合并预检门禁

**工作包补充验收。** 敏感文件名变体由 Git 与发布扫描一致拒绝，公开示例和公钥仍可进仓。使用真实临时分叉仓库验证两个父提交的合并态。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R43** · P2 | 默认 Git 忽略规则漏掉原报告点名的凭据文件名变体<br>[.gitignore](../../.gitignore) | Git 和发布源文件检查一致识别 credentials*.json、SSH 私钥及变体、.env.*，保留 .env.example 与公开 SSH 公钥。真实临时 Git 及发布检查核对 7 个私有名和 4 个公开名，见 extra-five.log。 |
| **R46** · P2 | PR 校验覆盖源分支，缺少与最新目标分支合并后的测试<br>[affected.yml](../../.github/workflows/affected.yml) [ci-checks.mjs](../../scripts/ci-checks.mjs) | PR 以目标和源分支的精确合并提交执行，校验两个父提交。在临时 Git 仓库构造分叉并实际合并，普通源提交被拒，合并版只选对应主题改动。extra-five.log / ci-checks。 |

### F-P2-19　运行时 Linux 进程控制器与网关热路径开销

**工作包补充验收。** 受管 Linux 进程的启动、取消、自然退出及控制丢失见 R135。另测 8 个本地会话共 1,600 次鉴权，p95 为 0.061 ms；原生目录 20 次热读 p95 为 0.57 ms，22 次调用各自产生 model/list。保留逐请求身份复核；目录仅合并并发读取，主动刷新后可立即复核模型能力。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R135** · P3 | Linux 回环控制通道存在未验证候选争用，可能令已启动的正常进程无法证明受控<br>[linux-process.ts](../../src/runtime/linux-process.ts) | Linux 控制器直接独占正式 `process/spawn` 句柄继承的匿名 stdin/stdout。受管目标获得另一组单独的 stdio 或真实 PTY，握手、控制、输出与归属经不同管道隔离。实跑同 UID 两个并行控制器、在初始握手前断开控制输入，以及握手完成后断开、停止、自然结束、超时、撤销、PTY 输入与尺寸、独立 stderr，以及 UID 1000 控制器。没有文件系统 socket、TCP listener 或候选连接池。 对应验收底稿见 runtime.md。 |

### F-P2-20　前端跨会话/跨项目状态隔离与会话内定位

**工作包补充验收。** 在不同会话之间、未登记目录重新登记、同会话后台重读与已消费的搜索定位之间切换，分别核对 diff、筛选、错误消除及重复刷新次数。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R80** · P3 | 丢响应后对账确认同一次操作时，工作流刷新两次<br>[useWorkflow.ts](../../web/hooks/useWorkflow.ts) | 工作流确认按操作号合并，已知他人会话回执按正式 scope 过滤。无归属旧回执保守更新。workflows、v240-audit-regressions 覆盖成功、未知后确认、外会话与归属不明回执。 对应验收底稿见 web.md。 |
| **R81** · P3 | 其他会话的正式回执仍触发当前任务面板重读<br>[contracts.ts](../../src/core/contracts.ts) [dispatch.ts](../../src/gateway/dispatch.ts) [useWorkflow.ts](../../web/hooks/useWorkflow.ts) | 工作流确认按操作号合并，已知他人会话回执按正式 scope 过滤。无归属旧回执保守更新。workflows、v240-audit-regressions 覆盖成功、未知后确认、外会话与归属不明回执。 对应验收底稿见 web.md。 |
| **R93** · P3 | 主动回到最新后，再从工具返回聊天会重新跳到上次定位的旧消息<br>[Workspace.tsx](../../web/Workspace.tsx) [Messages.tsx](../../web/components/Messages.tsx) | 搜索定位只有一次消费，保留当前行可见高亮。主动回到最新不重播旧定位。后台终端定位命中只清除此定位错误。render-budget 涵盖初次、窗口外定位，thread-terminals 包含有效和失效定位。 对应验收底稿见 web.md。 |
| **R94** · P3 | 会话终端首次定位提示历史未加载，重试成功后仍显示同一错误<br>[Workspace.tsx](../../web/Workspace.tsx) | 搜索定位只有一次消费，保留当前行可见高亮。主动回到最新不重播旧定位。后台终端定位命中只清除此定位错误。render-budget 涵盖初次、窗口外定位，thread-terminals 包含有效和失效定位。 对应验收底稿见 web.md。 |
| **R142** · P2 | 从已就绪的 A 打开 B 的历史分支草稿，会用 A 的回合判断 B 的目标是否存在<br>[Workspace.tsx](../../web/Workspace.tsx) [useConversation.ts](../../web/hooks/useConversation.ts) | 跨会话切换同步屏蔽旧加载身份，分支仅检查已读到的目标会话。截断窗口的目标缺失提示与已完整读取的确实缺失区分。conversation、workspace-handoff。 对应验收底稿见 web.md。 |
| **R146** · P3 | 已注册项目后台刷新会使供当前工作区使用的项目在读取期间消失<br>[Workspace.tsx](../../web/Workspace.tsx) [useResource.ts](../../web/hooks/useResource.ts) | 同范围刷新保留项目快照，文件/排序使用与当前会话 cwd 对应的项目身份，重新登记后随正式项目消除错误。完整重读后撤销缺失回合 diff/筛选。截断窗口保留不确定项。conversation、workspace-management、workspace-handoff。 对应验收底稿见 web.md。 |
| **R147** · P2 | 未注册 cwd 下组织面板收到上次项目的 ID，用于文件链接或同项目排序<br>[Workspace.tsx](../../web/Workspace.tsx) [OrganizationPanel.tsx](../../web/components/OrganizationPanel.tsx) | 同范围刷新保留项目快照，文件/排序使用与当前会话 cwd 对应的项目身份，重新登记后随正式项目消除错误。完整重读后撤销缺失回合 diff/筛选。截断窗口保留不确定项。conversation、workspace-management、workspace-handoff。 对应验收底稿见 web.md。 |
| **R148** · P3 | 重新注册缺失目录后旧的“未注册”错误可能留在页面<br>[Workspace.tsx](../../web/Workspace.tsx) | 同范围刷新保留项目快照，文件/排序使用与当前会话 cwd 对应的项目身份，重新登记后随正式项目消除错误。完整重读后撤销缺失回合 diff/筛选。截断窗口保留不确定项。conversation、workspace-management、workspace-handoff。 对应验收底稿见 web.md。 |
| **R149** · P3 | 同会话回退并重读后保留已删除回合的 diff 和筛选 ID<br>[useConversation.ts](../../web/hooks/useConversation.ts) | 同范围刷新保留项目快照，文件/排序使用与当前会话 cwd 对应的项目身份，重新登记后随正式项目消除错误。完整重读后撤销缺失回合 diff/筛选。截断窗口保留不确定项。conversation、workspace-management、workspace-handoff。 对应验收底稿见 web.md。 |

### F-P3-01　受管工作树项目命名一致性

**工作包补充验收。** SQLite 上改名、归档、恢复后核对两个列表，再重放旧成功回执，自定义名称及相邻工作树符合预期。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R15** · P3 | 重命名受管工作树项目后，工作树列表仍显示旧名，归档再恢复会丢失自定义名称<br>[ledger.ts](../../src/core/ledger.ts) [worktrees.ts](../../src/core/worktrees.ts) | 项目与工作树显示名同事务修改，旧库恢复时从已登记项目修正旧名称。真实 SQLite 建库、模拟旧名分歧、重启、归档、恢复和重放，并核对相邻工作树未改名。gateway-new.log / worktrees。 |

### F-P3-02　前端分页目录与自动化列表刷新

**工作包补充验收。** 三页范围的第二页失败后同范围重试；自动化运行目录另查新增、旧行状态变化、成员增删和旧服务器响应。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R17** · P3 | 多页目录刷新中途失败会缩小下一次刷新范围<br>[usePaged.ts](../../web/hooks/usePaged.ts) | 多页刷新仅在所有页验证成功后替换游标和已取页数。paged-threads 定向测试以三页、第二页出错、再次刷新逐页重读核对。 对应验收底稿见 web.md。 |
| **R58** · P3 | 自动化运行列表刷新时仍从第一页顺序重读已加载的记录，最多 20 页<br>[useAutomationRuns.ts](../../web/hooks/useAutomationRuns.ts) | 自动化运行目录使用成员版本和重点跟踪的活动行。多页稳定列表只读一页仍得到中间行新状态，增删后的列表按顺序重建。兼容旧后端没有 membership 的响应。extra-five.log / automations。 |

### F-P3-03　前端损坏草稿清理与新建首项目/欢迎建议草稿交接

**工作包补充验收。** 损坏的聊天/文件草稿可原位处理；首屏建议与已有目标草稿保持独立。勾选导入后从真实设置导航关闭/取消/丢弃，未意外触发导入。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R18** · P3 | 丢弃损坏聊天草稿后当前输入区仍保留恢复错误<br>[drafts.ts](../../web/lib/drafts.ts) [useDraft.ts](../../web/hooks/useDraft.ts) [Workspace.tsx](../../web/Workspace.tsx) | 丢弃损坏草稿传播实际逻辑键，真正无法解析键时重读。drafts、v240-audit-regressions 覆盖损坏记录辨识、精确删除和原输入区。 对应验收底稿见 web.md。 |
| **R19** · P3 | 丢弃损坏文件草稿后当前编辑器不能就地恢复<br>[FileEditor.tsx](../../web/components/FileEditor.tsx) [file-drafts.ts](../../web/lib/file-drafts.ts) | 丢弃损坏记录带上原始存储键与内容，当前编辑器只在对应记录被移除后重新读取服务端文本并恢复保存。workspace-ui 带损坏数据的挂载后编辑用例见 parent-new-regressions.log。 |
| **R20** · P3 | 新账号创建首个项目成功，却提示聊天草稿未安全保存<br>[useWorkflow.ts](../../web/hooks/useWorkflow.ts) [ProjectDialog.tsx](../../web/components/ProjectDialog.tsx) [Workspace.tsx](../../web/Workspace.tsx) | 新项目确认后按当前草稿所有者执行导航，并识别等待新登记出现的旧目录快照。project-create、project-handoff 覆盖新增、已有、保存失败、身份切换。重新跑 4/4。 对应验收底稿见 web.md。 |
| **R91** · P3 | 初次载入已有项目时，提前点选的欢迎建议会从当前输入区消失<br>[Workspace.tsx](../../web/Workspace.tsx) | 项目加载前欢迎页输入和附件优先迁移到空目的草稿。已有草稿时保留双方和提示。production Edge 故意阻塞 project/list，在没有项目时点欢迎建议，待项目上线，实测文字完整迁移并且输入框未获得焦点。project-handoff、drafts 保护保存失败。 对应验收底稿见 web.md。 |
| **R143** · P3 | 仅存在损坏草稿时，草稿设置同时显示没有未处理草稿<br>[DraftsSettings.tsx](../../web/components/DraftsSettings.tsx) | 损坏草稿、内存文件草稿与有效聊天草稿均参与空态判断。发生读取错误时不展示“没有草稿”。已验证损坏隔离及写入失败后设置仍有备份按钮。last-draft-auth.log、parent-new-regressions.log。 |
| **R145** · P3 | 导入面板选择未接设置草稿守卫，关闭后丢失已选清单<br>[ImportPanel.tsx](../../web/components/ImportPanel.tsx) [Settings.tsx](../../web/components/Settings.tsx) [ExtensionsPanel.tsx](../../web/components/ExtensionsPanel.tsx) | 真实设置页进入扩展导入、勾选后关闭，取消关闭保留选择，确认放弃仅关闭一次，未调用导入。已有导入成功/失败状态继续由原回执决定。见 ui-extras.log。 |

### F-P3-04　前端导出下载、键盘焦点与输入法守卫一致性

**工作包补充验收。** 三个下载入口共用文件名清理与 60 秒释放；测普通文本/文件粘贴、IME 选词与 229、展开/关闭弹层的 Escape 和 Tab。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R60** · P3 | 三个导出入口仍在 1 秒后释放下载地址，各入口保存条件不一致<br>[download.ts](../../web/lib/download.ts) [HistoryTools.tsx](../../web/components/HistoryTools.tsx) [McpPanel.tsx](../../web/components/McpPanel.tsx) | 回执、诊断、导出等共用 downloadBlob，文件名清洗后发起下载，60 秒后释放 URL。导出回归见 receipt-maintenance、sharing-diagnostics 等受影响套件。手机操作系统的下载交接不在桌面计时断言内。 对应验收底稿见 parent-evidence.md。 |
| **R61** · P3 | 模型与用量面板收起后仍截获 Escape，焦点移出时也不收起<br>[ModelPicker.tsx](../../web/components/ModelPicker.tsx) [UsagePopover.tsx](../../web/components/UsagePopover.tsx) | ModelPicker、UsagePopover 按仅展开时截获 Escape，焦点离开后收起。model-picker、usage 回归。 对应验收底稿见 web.md。 |
| **R78** · P3 | 消息输入区静默忽略剪贴板里的普通文件<br>[Composer.tsx](../../web/components/Composer.tsx) | 普通文件/混合内容粘贴进入同一数量/大小和上传通道，文件字节识别 PNG/JPEG/GIF/WebP 不依赖后缀。mediaAdmission 按最终真实目录，普通文件和音频原有行为保留。服务端字节识别和历史路径见 runtime.md。 对应验收底稿见 web.md。 |
| **R83** · P3 | 工作区搜索等原报告点名的表单仍缺少中文输入法回车保护<br>[types.ts](../../web/lib/types.ts) [ThreadOrganization.tsx](../../web/components/ThreadOrganization.tsx) [WorkspaceSearch.tsx](../../web/components/WorkspaceSearch.tsx) | 工作区搜索与 Workspace 子树的表单对正在组合的 Enter/229 禁止隐式提交。搜索可选依赖/生成目录快捷排除，保留自定义名并去重。取消后恢复原输入。workspace-search 验证显式按钮、IME、请求实参、范围与返回所有者。搜索恰满 limit 的 Linux 夹具见 deploy.md。 对应验收底稿见 web.md。 |

### F-P3-05　前端表单凭据保留与导航拦截细节

**工作包补充验收。** 同账号重连与真正换身份分开，前者保留未交凭据。取消或放弃草稿后核对原路由、前进历史和目标面板。自动化还原能采用后台新保存版本。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R32** · P3 | 设置面板状态变化会清掉尚未提交的凭据，用户需要重填<br>[ProviderSettings.tsx](../../web/components/ProviderSettings.tsx) [RemoteSettings.tsx](../../web/components/RemoteSettings.tsx) [McpConfiguration.tsx](../../web/components/McpConfiguration.tsx) | 同一身份和供应商的普通刷新、后台不可用及重连保留未提交的密钥草稿。供应商被移除或被恢复档替换后，在显示缺失提示的同一帧屏蔽密钥，绘制前清空内存。未提交的名称与目录保留原归属。API、登录身份或目标切换分别验证，确认不会把草稿发到另一供应商。见 provider-secret-final.log、web-detail-final.log。 |
| **R52** · P3 | 项目被外部移除时，自动切换会弹出草稿导航守卫，未说明触发原因<br>[Workspace.tsx](../../web/Workspace.tsx) | 当前项目被移除时说明原因，保留草稿，包括移除至零项目。project-handoff、draft-navigation 保护原输入。 对应验收底稿见 web.md。 |
| **R76** · P3 | 撤销其他设备登录会清空未提交的改密表单<br>[SecuritySettings.tsx](../../web/components/SecuritySettings.tsx) | 撤销其他设备只清该操作的确认状态。实际组件输入新密码和确认值后撤销另一会话，核对仅传该会话号与账号修订，两个输入仍保留。ui-item-direct.log / builtin-auth。 |
| **R90** · P3 | 草稿保护拦截浏览器后退后会丢失已有的前进记录<br>[Workspace.tsx](../../web/Workspace.tsx) | 同页历史索引记录，后退/前进被拦截时用 history.go 复位，确认才消费原导航及打开面板、清筛选等后续动作一次。draft-navigation、workspace-handoff、project-handoff。 对应验收底稿见 web.md。 |
| **R144** · P3 | 后台进程身份不变而 CPU/内存值更新，终止确认丢失<br>[ThreadTerminals.tsx](../../web/components/ThreadTerminals.tsx) [thread-terminals.test.tsx](../../web/tests/thread-terminals.test.tsx) | 同一项目/原生进程身份的 CPU/RSS 刷新保留行终止确认，不同命令、PID 或所有者撤销。thread-terminals 测试同源刷新、另页对象替换及全局清理确认失效。 对应验收底稿见 web.md。 |
| **R156** · P3 | 编辑已有自动化缺少恢复到保存值的操作<br>[AutomationForm.tsx](../../web/components/AutomationForm.tsx) | 编辑原计划可取消还原或确认恢复最新已保存版本，即使后台版本发生冲突仍可放弃本地修改。两条路径均不调用 automation/update。ui-item-direct.log。 |
| **R157** · P3 | 限额更新时清空已展示配额卡片并在读回前闪动<br>[AccountSettings.tsx](../../web/components/AccountSettings.tsx) | 额度刷新时同一身份保留旧卡，延迟读回后只替换为新值。明确退出后移除额度。ui-item-direct.log / device-login。 |
| **R160** · P3 | 用户放弃草稿恢复导航后，发起方的后续开面板或清筛选动作可能漏掉<br>[Workspace.tsx](../../web/Workspace.tsx) | 同页历史索引记录，后退/前进被拦截时用 history.go 复位，确认才消费原导航及打开面板、清筛选等后续动作一次。draft-navigation、workspace-handoff、project-handoff。 对应验收底稿见 web.md。 |

### F-P3-06　前端提示优先级、断线入口与媒体/归档解析兼容性

**工作包补充验收。** 草稿错误、离线能力刷新、重连宽限各自验证；媒体与回执按格式分别处理。伴随项 F12 保留独立“重新读取审批请求”，综合“重新读取并核对”同时更新会话与审批。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R27** · P3 | 同一供应商的模型目录错误遮住阻止发送的草稿错误<br>[useModelCatalogRefresh.ts](../../web/hooks/useModelCatalogRefresh.ts) [Workspace.tsx](../../web/Workspace.tsx) | 草稿阻塞优先显示，模型目录告警仍保留。provider-catalog、workspace-handoff、input-modalities 检查目录警告与可操作入口。 对应验收底稿见 web.md。 |
| **R28** · P3 | 音频格式识别仍将 Matroska 容器一律标作 WebM 音频<br>[media.ts](../../web/lib/media.ts) | 限定范围解析 EBML 的 DocType，仅 webm 认作 WebM。Matroska、截断头被拒。message-media 以相同的 EBML 容器头分别送三类输入。ui-item-direct.log。 |
| **R51** · P3 | 短暂断线时页面立即显示强制停止并恢复入口<br>[useEvents.ts](../../web/hooks/useEvents.ts) [Workspace.tsx](../../web/Workspace.tsx) | 短暂掉线和后台未就绪使用 3 秒宽限。恢复连接有独立 polite status。设置仍提供明确主动恢复。events、app-lifecycle 核对网络状态源。读屏软件实际朗读未在机上测试。 对应验收底稿见 web.md。 |
| **R59** · P3 | 损坏的回执归档分片仍可能直接抛出浏览器解码错误<br>[receipt-archive.ts](../../web/lib/receipt-archive.ts) | 畸形 base64 分片返回中文可操作错误，未触发下载。断续分片、校验和不匹配和离开页面同样阻止轮换。ui-item-direct.log / receipt-maintenance。 |
| **R67** · P3 | 断线时仍能点击媒体错误提示中的“重新核对模型能力”<br>[Composer.tsx](../../web/components/Composer.tsx) [ModelPicker.tsx](../../web/components/ModelPicker.tsx) [Workspace.tsx](../../web/Workspace.tsx) | 媒体能力提示中的刷新按钮绑定真实目录操作权限。明确禁用时不发送请求。input-modalities、provider-catalog。 对应验收底稿见 web.md。 |
| **R79** · P3 | 浏览器可解码的折行 base64 媒体在产品预览中被拒<br>[media.ts](../../web/lib/media.ts) [MessageMedia.tsx](../../web/components/MessageMedia.tsx) | 在输入总量受限的前提下容许 base64 ASCII 空白。折行与空格解出的 4 字节逐一对照，过大输入和无效格式仍报错。ui-item-direct.log / message-media。 |

### F-P3-07　界面中文化统一、无障碍朗读与字号可读性

**工作包补充验收。** 中文操作名保留未知方法原值。可访问状态播报与历史错误分开，已加载失败正文仍可读；工作区新旧失败回执的阶段、投递状态与中文错误一起核对。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R33** · P3 | 插件面板仍直接显示可用性与安装策略的英文协议值<br>[PluginSettings.tsx](../../web/components/PluginSettings.tsx) [PluginSharing.tsx](../../web/components/PluginSharing.tsx) | 插件可用性与安装策略按操作员可读名称显示，未知枚举带原值便于核查。组件回归见 extensions 套件，以及 R55 状态专项。 对应验收底稿见 parent-evidence.md。 |
| **R39** · P3 | 中文界面的部分工作区错误回执仍直接显示英文<br>[workspace_store.py](../../deploy/workspace_store.py) [operator.py](../../deploy/operator.py) | deploy/workspace_errors.py 把即时失败、原生持久回执及原 ID 重读统一为中文，保留稳定 code、delivery 和受限的异常类型/errno。已有英文原生回执按读转换，原文件字节保留。浏览器兼容网关已保存的旧英文回执，从真正接口和操作记录进入均给出同一原因。Linux 用例 test_immediate_retained_and_legacy_workspace_failure_share_chinese_code_and_delivery 在真实已存在目录上核对即时、回读、重放和旧回执。test_explicit_errors_preserve_their_code_and_generic_failures_hide_internal_paths 与 test_missing_resource_code_never_reclassifies_a_dispatched_mutation 核对诊断及副作用边界。deploy-r39.log 共 103 项通过。浏览器用例 shows the same localized explanation for immediate and historical native workspace failures 核对提示、原编号、可重试与真实请求次数。deploy-r39-ui.log 五文件 88 项通过。 |
| **R50** · P3 | 窄屏界面仍有需要阅读的文字被设为 9 像素<br>[Sidebar.tsx](../../web/components/Sidebar.tsx) [styles-extensions.css](../../web/styles-extensions.css) [styles-usability.css](../../web/styles-usability.css) | 9px 可读标签增至 11px，Edge 实测不同断点的 CSS（见浏览器记录）。 对应验收底稿见 web.md。 |
| **R54** · P3 | 恢复列表的若干 Git、工作树和 MCP 操作仍以原始方法名显示<br>[Recovery.tsx](../../web/components/Recovery.tsx) [mcp.ts](../../src/runtime/mcp.ts) | 工作区、Git、MCP 与恢复操作在真实本地操作日志的显示改为中文。组件对已知及未知方法分别核对标签和原始方法名，使用 Object.hasOwn 处理未知值。见 ui-mapping.log。 |
| **R55** · P3 | 扩展、建议和恢复页面仍直接显示面向用户的英文状态<br>[status-labels.ts](../../web/lib/status-labels.ts) [SkillSettings.tsx](../../web/components/SkillSettings.tsx) [ExtensionsPanel.tsx](../../web/components/ExtensionsPanel.tsx) | 建议、额度套餐、扩展安装/认证策略与实验阶段、钩子事件/执行模式/来源/输出及两种工作区恢复详情采用中文枚举。未知协议值保留原值，空值显示未提供。实测建议未知值禁插入、额度原始 JSON 保留、实验未知状态禁修改、恢复与钩子中文展示。web-detail-final.log。 |
| **R74** · P3 | 小屏已有连接状态文字，但恢复成功缺少可访问的状态通知<br>[Workspace.tsx](../../web/Workspace.tsx) | 短暂掉线和后台未就绪使用 3 秒宽限。恢复连接有独立 polite status。设置仍提供明确主动恢复。events、app-lifecycle 核对网络状态源。读屏软件实际朗读未在机上测试。 对应验收底稿见 web.md。 |
| **R75** · P3 | 守护审查的菜单名称和弹窗标题仍不一致<br>[Workspace.tsx](../../web/Workspace.tsx) [GuardianReviewPanel.tsx](../../web/components/GuardianReviewPanel.tsx) | 入口与对话框可访问标题均为“守护审查（Guardian）与重试”。guardian-review 检验实际审查与单次重试。 对应验收底稿见 web.md。 |
| **R86** · P3 | 加载历史失败回合时同时建立多条紧急无障碍提示<br>[Messages.tsx](../../web/components/Messages.tsx) | 历史错误保留可读段落，无历史 alert 群发。实时失败由当前会话单条提示。render-budget、conversation。实际读屏播报未实测。 对应验收底稿见 web.md。 |
| **R155** · P3 | 断网退出时原始 fetch 错误直接显示<br>[api.ts](../../web/lib/api.ts) [Settings.tsx](../../web/components/Settings.tsx) | 退出的网络错误中文显示。两个终端入口独立图标/可访问名。进程 stdout/stderr 为独立具名 region，不用 label 包 pre。terminal、process-remote、session。 对应验收底稿见 web.md。 |
| **R161** · P3 | 两个不同终端入口同用一个终端图标<br>[Workspace.tsx](../../web/Workspace.tsx) | 退出的网络错误中文显示。两个终端入口独立图标/可访问名。进程 stdout/stderr 为独立具名 region，不用 label 包 pre。terminal、process-remote、session。 对应验收底稿见 web.md。 |
| **R162** · P3 | 进程输出仍用 label 包裹 pre<br>[ProcessPanel.tsx](../../web/components/ProcessPanel.tsx) | 退出的网络错误中文显示。两个终端入口独立图标/可访问名。进程 stdout/stderr 为独立具名 region，不用 label 包 pre。terminal、process-remote、session。 对应验收底稿见 web.md。 |

### F-P3-08　部署运维脚本、恢复文档与日志脱敏细节

**工作包补充验收。** 实际菜单核对打包前置、非法名重试、代理主副端口地址族。短秘密、常规数字、AWS region、安全不可读旧代日志分别测试。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R29** · P3 | 仅余初始化日志时，安装菜单先生成包，之后才报告不可安装<br>[operator.py](../../deploy/operator.py) [transactions.py](../../deploy/transactions.py) | 安装菜单在准备依赖和打包前检查初始化日志及配置完整性。test_pending_initialization_precedes_any_install_preparation 检查正式菜单的先后关系，初始化中断时打包前止步。通过。 test_completed_install_record_without_instance_file_stops_before_operations 覆盖初始化完成记录和配置目录仍在但 instance.json 缺失，依赖准备与打包均未运行。 |
| **R30** · P3 | 恢复手册的操作对照表漏列配置层恢复命令<br>[RECOVERY.md](../../deploy/RECOVERY.md) [operator.py](../../deploy/operator.py) | RECOVERY.md 首表增加“修复 / 恢复 / 回滚 → 恢复中断的配置层迁移”，列出默认旧版本、显式完成同一次候选两个方向。逐字对照 deploy/operator.py、deploy/cli.py 选择和参数。配置层恢复回归通过。 对应验收底稿见 deploy.md。 |
| **R31** · P3 | 短历史凭据按全文替换，诊断中的普通数字和状态也会被遮盖<br>[manager.py](../../deploy/manager.py) [redaction.ts](../../src/runtime/redaction.ts) | 用已知秘密、凭据上下文和短 token 边界脱敏，保留可以区分的状态、IP、编号等。test_public_region_short_state_and_incomplete_credential_inventory 对同一个数字 1 在密钥、HTTP 状态、IP、区域号中的表现做对照，通过。 对应验收底稿见 deploy.md。 |
| **R138** · P3 | 代理错误要求只在 IPv4 监听的 HTTP 副端口也可绑定 IPv6<br>[service_proxy.py](../../deploy/service_proxy.py) | 监听生成和占用检查共用真实监听列表。test_secondary_ipv6_port_can_already_be_bound 实际占用 IPv6 副端口并通过检查。占用真正监听的 IPv4 副端口被拒。通过。 对应验收底稿见 deploy.md。 |
| **R151** · P3 | 日志脱敏把非秘密的 AWS region 普通文本也替换<br>[diagnostic_secrets.py](../../deploy/diagnostic_secrets.py) [manager.py](../../deploy/manager.py) | 受认可的 Route53 region 不属于秘密，其他未知字段继续按敏感值处理。test_public_region_short_state_and_incomplete_credential_inventory 中的 us-east-1、示例访问凭据与相同字符的短值对照通过。 对应验收底稿见 deploy.md。 |
| **R152** · P3 | 单个旧提供商代际数据损坏会令整个日志查询不可用<br>[manager.py](../../deploy/manager.py) | 单个旧代损坏时日志接口返回安全摘要、可保留的 HTTP 状态统计及具体代际，未核实原文不外发。上述测试损坏真实 settings.json 后仍成功获取结果，未泄露合成标记。通过。 |
| **R153** · P3 | 交互入口传非法实例名时未进入原有中文重试提示<br>[operator.py](../../deploy/operator.py) | manage 初始名称无效时提示中文，转入原选择循环。test_invalid_initial_name_can_be_corrected_or_cancelled、test_manage_requires_interactive_terminal_and_does_not_mutate 验证改正、取消和非交互拒绝。通过。 对应验收底稿见 deploy.md。 |

### F-P3-09　网关预览阻塞、登录会话说明、反馈包路径与已加载会话标题

**工作包补充验收。** 用两份真实 SQLite 账本与并发网关请求复验响应；反馈保存路径、分页外标题、登录期间与标签页草稿生命周期分别核对。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R69** · P3 | 较大的回执导出预览同步占用网关事件循环<br>[receipt-maintenance.ts](../../src/gateway/receipt-maintenance.ts) [operation-retention.ts](../../src/core/operation-retention.ts) | SQLite 读取置于独立一致性快照，序列化与 SHA-256 分块让出事件循环。预览期间并发写不会改变已创建归档。8.44 MB 和 24.12 MB 预览实测期间均可继续访问实际网关并核对文件字节。见 preview-latency.jsonl、deploy-cross-r69.jsonl。 |
| **R70** · P3 | 保存反馈包默认在项目根生成普通 Git 可见文件<br>[feedback.ts](../../src/runtime/feedback.ts) [DiagnosticsPanel.tsx](../../web/components/DiagnosticsPanel.tsx) | 在当前项目的私有 .harness-feedback 目录保存反馈，并创建本目录的 Git 排除规则。独立的真实 CLI 导出路径、权限与启用后的原生反馈交互对照见 rt-feedback-final.log。 |
| **R72** · P3 | README 遗漏聊天草稿关闭标签后可能丢失的条件<br>[drafts.ts](../../web/lib/drafts.ts) [README.md](../../README.md) [DraftsSettings.tsx](../../web/components/DraftsSettings.tsx) | README 写明标签关闭后草稿可能丢失、标签内可恢复以及备份入口。与存储失败后的编辑器组件、草稿设置实测对照。last-draft-auth.log。 |
| **R77** · P3 | 已加载会话列表对侧栏目录之外的可命名会话只显示 ID<br>[LoadedThreadsPanel.tsx](../../web/components/LoadedThreadsPanel.tsx) | 受限的合法 thread/read 补全当前 50 行、最多 3 个并发，含已删和未命名负缓存。loaded-threads 验证未选中的第二页允许显示名称、选择后重新核对实时状态、没有 thread/resume。 对应验收底稿见 web.md。 |
| **R88** · P3 | 登录页未说明未勾选保持登录时会话仍会跨浏览器关闭保留 12 小时<br>[auth.ts](../../src/gateway/auth.ts) [Login.tsx](../../web/components/Login.tsx) | 登录表单与文档明确普通会话有效 12 小时，跨浏览器关闭也可能保留，勾选保持登录后按 30 天处理。固定时间的真实认证存储与 Cookie 测试见 extra-five.log / auth。 |

### F-P3-10　测试选择器、本地依赖补丁与 CI 构建效率

**工作包补充验收。** 全仓 Python 测试依赖图核对 17 条直接导入关系并追踪多跳；含中文路径实编 Go、并发结果轮转、明确强制跟踪缓存及两套仅前端/测试故意引入类型错误的门禁均单独验证。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R22** · P3 | 普通受影响测试选择遗漏直接使用改动夹具的用例<br>[select-tests.mjs](../../scripts/select-tests.mjs) [test_proxy_transaction.py](../../tests/deploy/root/test_proxy_transaction.py) [test_execution_mode.py](../../tests/deploy/root/test_execution_mode.py) | Python AST 构造反向依赖图并取多跳闭包，仓内 17 条直接导入关系逐一与选择器输出比对。检查别名、嵌套、同一夹具独立归属两组、跨测试目录及新原生测试路由。原生身份读历史的 Python 适配器会选中真实队列、附件、转换与视觉集成用例。系统级配置从普通服务入口的变更也能选中 Linux 特权用例。两种历史消息样式在正式测试回执中各有独立编号，防止网页断言全部通过但缺少可复查身份。见 ci-wiring-verified.log、web-case-identities-final.log、tooling-accepted.log。 |
| **R44** · P3 | TypeScript 构建元数据未被默认忽略，会干扰源码快照<br>[.gitignore](../../.gitignore) [snapshot.mjs](../../scripts/snapshot.mjs) [release-audit.mjs](../../scripts/release-audit.mjs) | 在独立小型 Git 仓分别造未跟踪缓存、修改源码和显式跟踪的生成文件。第一种快照摘要不变，第二种摘要改变，第三种被源清单防护拒绝。见 generator-gates.log。 |
| **R45** · P3 | 每次隔离 Go 测试仍重新复制整份模块缓存<br>[go-tests.mjs](../../scripts/go-tests.mjs) | 经认证的共享模块缓存封存只读，编译缓存、源码、输出每次独立。官方 Go 1.26.10 在含中文的路径离线同时编译两次并再跑一次，三次 mod verify 和二进制结果一致，共享的 9 个文件摘要不变，模块缓存复制 0 字节。go-concurrent.log 与 tooling 的 go-tests。此实机负载为小型依赖包。 |
| **R158** · P3 | 本地逐次生成的 .work/test-results 没有保留上限<br>[test-retention.mjs](../../scripts/test-retention.mjs) [run-tests.mjs](../../scripts/run-tests.mjs) [select-tests.mjs](../../scripts/select-tests.mjs) | 运行中和其他用途的目录保留。新格式按成功/失败分别留最近 6 个完成记录。独立两进程实际同时落盘与轮换，不丢当前输出。不含所有权标记的旧目录保守保留一次，避免误删旧证据。见 deploy-cross-ci.log、tooling-accepted.log。 |
| **R159** · P3 | 发布检查文档的当前操作说明仍写旧 CLI 版本<br>[RELEASE-CHECKS.md](../../verification/RELEASE-CHECKS.md) [package.json](../../package.json) | 现行发布检查步骤按 package.json 的 0.169.0 CLI 编写，历史报告版本保持原值。path-check.log。 |
| **R169** · P3 | 持续集成在同一任务中重复检查服务端 TypeScript 源码<br>[affected.yml](../../.github/workflows/affected.yml) [package.json](../../package.json) [build-server.mjs](../../scripts/build-server.mjs) | 服务端完整编译同时生成 dist 产物，网页与测试工程各有独立严格门禁。两个隔离小工程分别沿用真实前端/测试配置故意制造类型错误，各被 TS2322 拦截。见 generator-gates.log、integrated-checks-final.log。 |

### F-P3-11　网关安全防御纵深加固

**工作包补充验收。** 合法、错误、缺失与长度不同的 CSRF 请求头均走已有鉴权逻辑，固定长度摘要使用等时比较。

| 编号及原级 | 原问题与对应实现 | 修改及核验结果 |
| --- | --- | --- |
| **R89** · P3 | CSRF 凭据的比较未使用项目已有的等时比较方式<br>[auth.ts](../../src/gateway/auth.ts) | CSRF 两侧 SHA-256 转成等长字节后用 timingSafeEqual。以正确、空、错误凭据及已撤销会话验证接受与拒绝。extra-five.log / auth。 |

### F-INF-01　部署与宿主机纵深防御建议

**工作包补充验收。** 源码祖先所有权及可写性、菜单可选 SHA、两个独立单元的网络上线顺序已落地。Debian 实际冷启动且网卡故意延迟约 6 秒；network-online 在开机后约 7.70 秒就绪，两个单元约 7.72 秒才启动探针，另测各自独立启动。


### F-INF-02　工作区搜索体验与生成目录默认策略

**工作包补充验收。** 按项目相对路径搜索，仅在出现第 limit+1 个真实命中时提示截断。检查恰满、额外不匹配条目、额外命中、时间耗尽，网页可快捷排除生成目录。


### F-INF-03　前端样式维护与防御性归一化

**工作包补充验收。** 四处按钮样式归并为桌面与窄屏规则，两条导入兼容路径统一处理失败项。组件与浏览器回归检查外观及旧记录。


### F-INF-04　仓库体积治理、TypeScript 严格度与依赖覆盖范围

**工作包补充验收。** 按可恢复性归档 874 份历史证据，另保留直接引用的文件。核对 1,109 份原始文件、166 条文档引用和全部还原字节。7 项依赖覆盖收窄到实际消费者；从包声明发现编译器及构建器；三套类型检查开启同一严格选项。


## 验收批次

以下数字按各自的执行批次列出。同一问题在不同环境和不同故障条件下可能反复执行。

| 验收面 | 通过情况与证据 |
| --- | --- |
| 网页交互 | 最终冻结源码上，网页全部 99 个测试文件、1,375 个具名用例通过，正式测试回执按文件和用例名逐条核对。见 web-case-identities-final.log。另用 Edge 和 WebKit 实测触屏操作、焦点及窄屏布局。最终前端构建在 Edge 再走长列表删除、取消、窄屏发送与显式聚焦，均通过。见 web-edge-source-final.log、web-edge.log、web-edge-extended.log、web-webkit.log。 |
| 网关与回执 | 冻结源码上的网关目录 16 个文件、276 项通过，覆盖本地认证、受理记录、去重、广播、并发、设备恢复、转换结果及迟到处理。见 gateway-delivery-final.log。 |
| 运行时 | macOS 定向组合 23 个文件、265 项通过，3 项带平台限制。Debian 上另执行 Linux 权限、进程与终端测试，使用普通 UID 的原生完整进程、PTY 和诊断对照 3 项通过。在冻结源码上重新执行视觉路由、超长会话、队列和跨供应商转换的 4 个原生文件，17 项全过。见 native-delivery-frozen.log。另跑 15 个直接受影响的核心及运行时文件，175 项通过、1 项受平台限制。见 runtime-macos-accepted.log、affected-neighbors-final.log、rt-linux-confirmed.log、rt-linux-ordinary-native.log。 |
| 部署与恢复 | 独立 Debian 上特权部署组合 479 项、普通身份组合 121 项均通过。另跑工作区相关 103 项、系统 MCP 真实 CLI 四轮开关的正式独立用例。在冻结提交上再次开机实跑 MCP 工具时限和进程关闭，3 个文件 41 项全部通过，含管道饱和的两个 Linux 专属情形。关机后再次核实测试虚拟机进程退出。见 deploy-verified.log、deploy-native-user.log、deploy-r39.log、rt-linux-system-ci.log、rt-linux-frozen-mcp.log、dedicated-vm-final-r04-boot.log、dedicated-vm-final-r04-poweroff.log。 |
| 测试覆盖与构建 | 构建、覆盖选择及发布治理组合 11 个文件、134 项通过。正式服务编译、网页和测试工程严格类型检查及生产网页构建均通过。Vite 对主脚本给出体积提示，压缩前 954.13 kB，gzip 后 289.49 kB。测试计划和 CI 路由另跑 3 个文件、55 项通过，同时验证 Ubuntu x64 官方 CLI 压缩档的实际摘要和内部可执行文件名。见 tooling-accepted.log、ci-wiring-verified.log、linux-ci-package.log。 |
| 真机与外部服务边界 | 手机端使用桌面浏览器触屏模拟。视觉使用实装 MCP 与本机可控端点，保留模型选择调用、审批拒绝、成功和上游错误的区别。Windows 平台专用断言和公开托管 CI 的执行留在对应环境。 |

## 证据与复验环境

配套的《codex-harness-v240-修复验收证据.zip》收录定向测试输出、原生 CLI／Linux 结果、浏览器观测、正式构建记录和逐文件摘要。包内 probes 目录附长会话输入、归档导出和双窗口恢复确认的复测脚本。各测试批次存在重叠，报告保留批次原数。同一用例在精确定位后再跑一次不会增加独立修复项数。

- 修复依据为用户提供的最终版审计报告，SHA-256 为 `aea3ed6607e507328c18762877a1a7c7cdb027d23e89893c0cc250ac3dee0bac`。逐项底稿 SHA-256 为 `d02d8922f68cd70277fc94b37b9ec1f4ae4947362126b2c29d44a4ecc5c24b04`。51 个包的正文和 169 个单项分别核对，参考材料里已结案的历史编号保留在输入文档。
- 使用包含中文的独立目录，分支 `luoyehe/repair-v240`。Git、Node、Python 子进程和固定 CLI 实测解析到同一项目路径。TypeScript、网页构建和 Go 离线并发编译也在该中文目录执行。见 chinese-path-final.log、go-concurrent.log。Linux 使用本次专用 Debian 12 ARM64 虚拟机。此次交付只产生本地提交。仓库有独立 .git，基线取自公开 v2.4.0 标签；代码、构建和验收均在本工作区及其专属测试虚拟机进行。
- 工程治理采用仓内可离线恢复的历史压缩包。874 份原始材料从 52,081,448 字节压至 11,735,472 字节，保留 SHA-256 和 Git 对象身份。直接被 Markdown 链接引用的材料保留原路径，166 条相对链接核对无缺失。抽取后全部 874 份逐字节与标签对照，连同保留原位置的共 1,109 份均吻合。[历史材料恢复说明](../history/README.md)
- 本轮验收范围为本地实现和可复现环境。实体手机上的系统输入法、用户智谱账户的真实配额或云端推理、Windows 原生运行，以及公网 ACME 的完整签发仍属于外部验收边界。仓库规定的正式全平台发布验证须具备同一源码三轮独立完整审计、跨平台证据和发布授权。本次没有远端发布或线上实例迁移。

媒体验收中的经典 MOV 按轨道处理器识别，格式判断参考 Apple 对 QuickTime 媒体处理器字段的定义。[Apple QuickTime 格式说明](https://developer.apple.com/documentation/quicktime-file-format/handler_reference_atom/component_type)

**交付源码与上游复核。** 实现提交为 `historical-commit-019`。冻结源码清单共 2,178 个文件，SHA-256 为 `f48fd21d97ed7f1b8ee0e67b9e8400a73cc5b042ffd6aa13eac76d6bf0a2d153`。复核智谱官方四份中文文档及固定版、最新版软件包元数据，六个来源均可读，固定版与最新版均为 0.1.6；项目锁定的完整性摘要吻合。保存的官方核对原始 JSON SHA-256 为 `a54373294140f575eb9eb2aa0c1172e878e83b5f64fa3f6915553aaa7e205764`。见 mcp-final-evidence.json、mcp-doc-review.log、snapshot-final.json、integrated-checks-final.log、source-final.log。
