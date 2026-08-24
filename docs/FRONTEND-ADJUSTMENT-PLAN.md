# DSH Trace Insight 前端调整建议（代码核对版）

状态：P0 已于 0.4.0 实施；P1/P2 已于 0.5.0 实施，0.5.1/0.5.2 完成真实 DSH 初始化修复与旧 Host 会话隔离，0.5.3/0.5.4 完成时间线优先的单列首屏重构与真实完成态归并修复；1.0.0 移除批注/书签/独立裁决的公开入口并保留旧数据只读兼容；1.1.0 将右侧检查器补丁改为 Windows、macOS 和 Linux 共用的事务式安装核心；1.1.1 增加 Turn 与 Turn 内独立排序并修复分页加载期间的纯排序竞态；1.2.0 增加 DSH 0.1.0-rc.8 壳层兼容与跨版本补丁状态清理；1.2.1 修复成功读取跨平台文档时的能力误报，并自动重建旧分析器记录；1.2.2 对齐正式复盘与运行对比，隔离补充分析，并清理无依据的推断、统计与空成员入口
范围：用户体验、信息架构、交互状态机、前后端契约
依据：当前 `src/` 实现、本地 LLM Wiki、GPT-5.6 Sol Pro 独立代码审计

## 1. 总体裁决

当前产品已经不是“缺一个漂亮界面”，而是后端分析能力已经较丰富，前端仍主要表现为“时间线 + 运维侧栏”。首要问题是用户无法可靠回答以下问题：

1. 现在分析到了哪里，为什么停在这里，下一步什么时候发生？
2. 当前 Session 实际使用哪个模型和策略，修改设置会影响谁？
3. 某条结论依据哪些原始 Seq、Turn、工具调用或模型运行？
4. 手动运行究竟是在补主覆盖水位，还是只做一次旁路比较？
5. 一次手动运行会分几段、调用几次、消耗多少输入，失败后如何恢复？

因此调整顺序应当是：

> 先补齐状态、分段、证据和恢复闭环，再做比较、研究视图和高级运营能力。

最重要的五项修正：

1. 明确“全局默认、Session 覆盖、本次运行选择”三者的作用域，但只持久化前两级。
2. 把手动分析拆成“主覆盖回填”和“补充比较”，不能继续都叫“回填”。
3. 把同步 `analysis/run` 改为可预览、可追踪、可取消的后台 Job。
4. 用轻量状态与 revision/delta 代替 3/15 秒整份 `insight/read` 轮询。
5. 把已有 evidence 变成可下钻的调查入口，并给 raw 导出增加明确的隐私闸门。

## 2. 代码核对后的真实问题

### 2.1 设置作用域对用户具有误导性

- 前端在单个 Session 的侧栏中显示“默认分析模型”，并向 `settings/update` 同时传入 `sessionId`：`src/client-template.js:509`、`src/client-template.js:746`。
- 服务端实际调用的是全局 `store.updateSettings()`，并没有 Session override：`src/analysis-service.mjs:515`。
- 结果是用户以为自己在改当前 Session，实际可能改变所有 Session 的默认策略。

结论：`全局默认 + Session 覆盖` 对这个产品是合理的，不是过度设计；但 UI 默认只显示“当前有效配置”，Session 覆盖放进渐进披露区域。不要继续增加项目级、Turn 级等持久化层级。

### 2.2 “手动回填”与实际水位语义不一致

- 自动分析以 `coverageRole: 'primary'` 推进 `semantic.coveredThroughSeq`：`src/analysis-service.mjs:709`、`src/analysis-service.mjs:876`。
- 手动分析固定写成 `coverageRole: 'supplemental'`：`src/analysis-service.mjs:901`、`src/analysis-service.mjs:935`。
- 因此现有手动运行不会补齐主覆盖缺口，只会增加一条补充分析记录。

结论：UI 必须明确提供两个动作：

- 主覆盖回填：填补缺口并推进 primary 水位；
- 补充比较：不改主水位，可按段换模型重新分析。

### 2.3 手动分析缺少 Job 状态机

- 前端 `runManual()` 同步等待整个 RPC 返回：`src/client-template.js:533`。
- 服务端按 segment 串行执行，直到完成或失败：`src/analysis-service.mjs:901`。
- 当前没有 preview、job id、进度、取消或定向重试接口。

这会把“长时间无响应、局部失败、重复点击、刷新后丢失进度”全部混成一个模糊的等待状态。

### 2.4 单一 `busy` 字符串会产生真实并发错误

- 所有设置、手动分析和导出共用一个 `busy` 字符串：`src/client-template.js:412`。
- 三类异步操作都会在各自 `finally` 中无条件 `setBusy('')`：`src/client-template.js:509`、`src/client-template.js:533`、`src/client-template.js:553`。

如果两个操作重叠，先结束的操作会清除另一个仍在运行的 busy 状态，使按钮过早恢复可点击。这不是美化问题，而是操作正确性问题。

### 2.5 刷新模型过重，且不是纯状态读取

- 运行中每 3 秒、其余每 15 秒调用一次 `refresh()`：`src/client-template.js:444`。
- `refresh()` 每次读取完整 `insight/read`：`src/client-template.js:434`。
- `readInsight()` 会读取 Observation、恢复遗留运行、补程序化检查点、重新生成 report，并读取完整 history/settings/catalog：`src/analysis-service.mjs:489`。

这不是轻量状态刷新。长 Session 下会放大 CPU、I/O、序列化和竞态风险；前端也没有 request revision、AbortController 或 in-flight 合并来防止旧响应覆盖新状态。

### 2.6 历史并非只加载 80 条，而是“全量拉取后只显示 80 条”

- `visibleCount` 初始为 80：`src/client-template.js:414`。
- 前端先拿到全部 history，再通过 `slice()` 只渲染最后 80 条：`src/client-template.js:475`。
- “显示更早”只是每次多渲染 100 条：`src/client-template.js:621`。

正确方向是后端游标分页与 delta，同步显示“已加载/总数”；不是把 80 改成更大的常量。

### 2.7 Evidence 已存在，但时间线几乎没有消费

- 程序化报告已有 Seq、Turn、Step、Tool、excerpt 等证据字段。
- `ProgrammaticEntry` 只展示 finding 标题、摘要和前几项结果，并把主要动作做成“选择此段换模分析”：`src/client-template.js:294`。
- 这使时间线更像分析列表，而不是可以追根溯源的调查工具。

第一阶段无需等待全新的证据系统：先用现有 `report.findings[*].evidence` 做抽屉；需要大段原文或上下文窗口时，再增加按需读取接口。

### 2.8 模型路由在前端丢失 `reasoningEffort`

- 服务端路由比较和校验包含 `reasoningEffort`：`src/analysis-service.mjs:48`、`src/analysis-service.mjs:191`。
- 前端 `routeKey()` 只序列化 provider 和 model：`src/client-template.js:182`。

这会让同一 provider/model 的不同推理档位在 UI 中不可区分，也可能保存错误的有效路由。

### 2.9 手动范围的前后端边界不一致

- 前端强制 `manualTo <= closedThroughSeq`：`src/client-template.js:478`、`src/client-template.js:485`。
- 后端 `validateRange()` 允许到最后一个事件 Seq：`src/analysis-service.mjs:178`。

必须明确产品语义并统一契约。推荐默认只允许已关闭 Turn；若支持尾部开放事件，必须明确标记“结果可能变化”，不能由前后端各自决定。

### 2.10 导出把 raw 风险暴露为普通按钮

- raw 与 bundle 直接包含完整 Observation：`src/analysis-service.mjs:948`、`src/analysis-service.mjs:962`。
- 语义模型输入的压缩与脱敏不等于导出脱敏。
- 当前前端三个导出按钮直接下载，没有范围预览、大小估计或隐私确认：`src/client-template.js:697`。

raw 导出必须默认关闭、显式选择，并在执行前说明将包含的内容。

## 3. 目标信息架构

默认页面服务“复盘”，低频配置服务“运维”，两者不能混成同一视觉层级。

| 区域 | 默认显示 | 主要任务 |
|---|---|---|
| 顶部状态带 | 当前有效模型、覆盖水位、最新成功、运行/退避/暂停、下一触发 | 3 秒内判断系统是否正常 |
| 主时间线 | 按分析段组织的程序化与模型结果、缺口、失败 | 找到发生了什么 |
| 证据抽屉 | Seq/Turn/Step/Tool、excerpt、规则或 prompt/analyzer 版本 | 证明结论从哪里来 |
| 运行抽屉 | preview、队列、分段进度、取消、重试 | 执行一次受控分析 |
| 设置/导出 | 全局默认、Session 覆盖、导出范围与隐私 | 低频运维和研究 |

不要再把模型策略、手动运行和导出长期挤在默认复盘视图右侧；重要运行状态常驻，低频表单进入抽屉或二级页。

## 4. 核心用户旅程

### 4.1 日常查看

进入“解读”后只做纯读取：看到当前水位、最新异常、最后成功和下一自动触发。仅查看页面绝不触发付费模型分析。

### 4.2 从结论回到证据

点击 finding 或模型结论，打开证据抽屉；可按证据项跳到 Seq/Turn，查看工具、摘录、分析层与版本限制。能够接入原生轨迹时提供“在轨迹中定位”。

### 4.3 故障恢复

当分析失败、退避、暂停或进程中断时，状态带必须显示原因、影响范围、下一次重试时间和可用动作。刷新失败时保留旧数据并标注“数据可能已陈旧”，不能把旧数据清空成空状态。

### 4.4 手动补充比较

从时间线选择一个或多个连续段，选择本次模型，预览真实切段、调用数、输入量和缓存；启动后进入 Job，允许取消或只重试失败段。结果写成 supplemental，不推进 primary 水位。

### 4.5 历史主覆盖回填

系统先显示未覆盖区间，再按主水位连续生成批次。用户选择范围与模型后启动 primary backfill；成功段连续推进水位，失败处停止并可从断点恢复。

### 4.6 导出研究包

先选择范围、分析层、模型运行和是否包含 raw；显示预计大小、schema/version、范围与隐私提示。导出完成后给出明确成功/失败和可重试状态。

## 5. 优先级与验收标准

### P0：形成可信的最小闭环

#### P0.1 有效设置与作用域

- 交互：默认显示 Effective Settings；提供“使用全局默认/覆盖当前 Session”；本次手动运行的模型只属于 run，不持久化。
- 契约：新增全局更新、Session override 更新/清除和 effective settings 读取；响应携带 revision。
- 验收：在 Session A 保存覆盖不会改变 Session B；清除覆盖后立即回落到全局默认；UI 能完整显示 `reasoningEffort`。

#### P0.2 区分主回填与补充比较

- 交互：两个动作使用不同名称、说明和结果标识；预览必须显示是否推进主水位。
- 契约：启动分析时显式传 `coverageRole: primary | supplemental`，服务端验证 primary 必须从当前水位连续开始。
- 验收：supplemental 成功后主水位不变；primary 从缺口起点连续成功后主水位推进；跳过缺口的 primary 请求被拒绝。

#### P0.3 异步 Job 工作流

- 交互：`Preview → Start → Queued/Running → Succeeded/Failed/Cancelled/Interrupted`；显示总段数、当前段、已完成段和取消。
- 契约：`analysis/preview`、`analysis/start`、`analysis/job`、`analysis/cancel`；Job 状态持久化并带 revision。
- 验收：刷新页面后仍能恢复当前 Job；取消不会把已完成段伪装为未发生；失败可以只重试失败段或换模重试。

#### P0.4 轻量状态与 revision

- 交互：状态带显示最后更新时间、陈旧标记、自动触发原因和下一时间点。
- 契约：新增纯读 `insight/status`，只返回 coverage、active jobs、retry/backoff、revisions；`history/delta` 按 revision 获取增量。
- 验收：空闲轮询不读取完整 Observation/history/catalog；旧响应不能覆盖新 revision；同时只允许一个同类请求 in flight。

#### P0.5 Evidence Drawer

- 交互：finding/根因/结论可展开证据；展示 Seq/Turn/Step/Tool/excerpt、规则或 prompt/analyzer 版本与限制。
- 契约：第一阶段直接消费已有 evidence；第二阶段增加 `evidence/read` 获取前后文和大摘录。
- 验收：任一高严重度 finding 至少能回到一条原始证据；没有证据的结论明确标记“推断/未验证”，不能伪装为事实。

#### P0.6 安全导出

- 交互：导出前预览范围、类型、大小和隐私；raw 默认不选；bundle 明确包含 raw 时再次提示。
- 契约：`export/preview` 返回 manifest、范围、估计大小和敏感类别；实际导出保留 schema/version/hash。
- 验收：用户不可能一次误点就下载 raw；分析历史导出不自动夹带 raw；失败有可见错误和重试。

#### P0.7 当前代码的正确性修补

- 用独立 operation/job 状态替代单一 `busy`。
- `routeKey()/parseRouteKey()` 保留 `reasoningEffort`。
- 统一手动范围规则。
- 所有后台失败保留旧数据、显示最后成功时间和错误，不吞错。

### P1：让长历史真正可调查

#### P1.1 游标分页与增量时间线

- 后端 `history/page` 返回 cursor、total、revision；前端按需加载、保持滚动与展开状态。
- 搜索/筛选条件包括 Seq、Turn、严重度、状态、触发来源、模型和分析层。
- 验收：数千条运行记录下首次加载不取全量；刷新不把用户跳回顶部；显示“已加载/总数”。

#### P1.2 同段运行比较

- 同一范围可比较不同模型、推理档位、prompt/analyzer 版本的 verdict、根因、建议、usage 和缓存。
- 允许置顶某次结果或标记过时，但绝不重写原始记录。
- 先做两次运行的差异比较，不做任意数量的研究矩阵。

#### P1.3 资源与成本可见性

- 直接展示已有 token、耗时、输入字符、缓存来源。
- 只有 provider 提供可靠价格版本时才估价；否则显示资源量，不显示伪精确金额。
- 软预算与调用上限后移到有稳定计费契约时实现。

#### P1.4 复盘与运维分层

- 默认复盘页聚焦目标、状态、关键问题、时间线和证据。
- 设置、回填、导出与诊断进入运维抽屉/二级页。
- 运行中、失败、暂停等关键状态始终常驻，不能因“简化界面”而隐藏。

#### P1.5 基础无障碍与响应式闭环

- Job 进度使用语义 progressbar，状态变化使用 aria-live。
- 状态不只靠颜色；完整时间提供时区；键盘可完成筛选、开关抽屉、取消与重试。
- 验证窄屏、触控、焦点恢复和长文本折行。

### P2：研究增强，不阻塞核心闭环

- 0.5.x 曾提供人工批注、书签和裁决；1.0.0 起不再公开这些操作，旧记录仅为无损历史与导出兼容保留。
- 程序化与模型、不同模型或版本之间的冲突/漂移提示。
- 按阶段、问题类型、工具、模型和触发来源汇总的研究视图，所有图表必须能回钻证据。
- prompt/analyzer 高级比较与预算策略。

## 6. 建议的后端契约

接口名称可以调整，但语义边界应保持。

| 接口 | 最小返回/输入 | 必须性质 |
|---|---|---|
| `settings/effective` | global、sessionOverride、effective、revision | 纯读，明确来源 |
| `settings/update-global` | patch、expectedRevision | 乐观并发控制 |
| `settings/update-session` | sessionId、patch/reset、expectedRevision | 不影响其他 Session |
| `analysis/preview` | mode、range、route → segments、calls、input estimate、cache、watermark impact | 无模型调用、无持久化副作用 |
| `analysis/start` | preview token/参数 → jobId | 幂等键，拒绝重复启动 |
| `analysis/job` | job、segments、progress、error、usage、revision | 纯读，可恢复 |
| `analysis/cancel` | jobId、expectedRevision | 明确已完成段与取消边界 |
| `insight/status` | coverage、activeJobs、retry、nextTrigger、revisions | 便宜、纯读 |
| `history/page` | cursor、filters、limit → items、next、total、revision | 服务端分页 |
| `history/delta` | sinceRevision → added/updated/removed | 增量同步 |
| `evidence/read` | finding/run/ref → excerpt + context | 延迟读取、大小受限 |
| `export/preview` | scope/options → manifest、size、privacy flags | 无下载副作用 |

现有 `insight/read` 可暂时保留用于首次装载，但不应继续承担高频状态轮询。

## 7. 最小完整首轮调整范围

首轮不是把所有候选功能都做完，而是完成一个可闭环版本：

1. Effective Settings：全局默认 + Session 覆盖 + run-time 临时选择。
2. Manual Preview 与异步 Job：包括取消、失败、刷新恢复。
3. Primary Backfill 与 Supplemental Compare 分流。
4. 轻量 Status/Revision，停止整份高频轮询。
5. Evidence Drawer，先消费已有证据。
6. Export Preview 与 raw 隐私闸门。
7. 修复 busy、reasoningEffort 和范围校验三项确定性缺陷。

这七项共同构成最小闭环；只做其中的界面外壳而没有契约，会制造新的假功能。

## 8. 明确不做项

- 不做独立 Dashboard；继续嵌入 DSH 会话“解读”标签。
- 不做通用任务编排、告警平台或大而全的 Agent 运维中心。
- 不在首轮做 prompt 编辑器、任意模型矩阵、复杂批注系统或研究图表墙。
- 不在缺乏可靠计费数据时显示伪精确费用。
- 不因进入“解读”标签而自动调用模型；查看与付费分析严格分离。
- 不让 raw 默认进入导出包。
- 不用聚合图表替代可追溯时间线和证据。
- 不增加超过“全局、Session、本次运行”三层的模型配置继承。
- 不修改被分析 Session、Skill 或全局记忆来保存分析结论。
- 不允许所谓“读取接口”暗中启动模型、重置调度或产生不可见副作用。

## 9. 验收场景

### 正向场景

一个旧 Session 有 Seq 0–900，primary 水位停在 420。用户进入解读页不会触发模型；页面显示缺口 421–900。用户选择 Primary Backfill 和模型，preview 显示 4 段、4 次调用和预计输入量。运行到第 3 段失败后，水位只推进到第 2 段末尾；刷新页面仍显示失败段、错误、下一步和“从失败段重试”。

### 反向场景

用户对 Seq 600–700 使用另一模型做 Supplemental Compare。运行成功后新增比较记录，但 primary 水位保持不变；系统不得把“有一条成功结果”误报成“历史已连续覆盖”。

### 导出场景

用户选择“分析历史”时只导出分析层；选择 raw 或 bundle 时必须先看到包含原始工具输入/输出和会话文本的提示、范围与估计大小，明确确认后才生成文件。

## 10. 研究与独立审计来源

本地知识库主要参考：

- `D:\Note\my-llm-wiki\wiki\syntheses\用户体验要素：以用户为中心的产品设计（原书第2版）全书综合.md`
- `D:\Note\my-llm-wiki\wiki\syntheses\简约至上：交互式设计四策略（第2版）全书综合.md`
- `D:\Note\my-llm-wiki\wiki\syntheses\设计心理学1：日常的设计（增订版）全书综合.md`
- `D:\Note\my-llm-wiki\wiki\syntheses\设计心理学2：与复杂共处（修订版）全书综合.md`
- `D:\Note\my-llm-wiki\wiki\syntheses\支付宝体验设计精髓全书综合.md`
- `D:\Note\my-llm-wiki\wiki\topics\信息架构.md`
- `D:\Note\my-llm-wiki\wiki\topics\概念模型.md`
- `D:\Note\my-llm-wiki\wiki\topics\服务恢复.md`
- `D:\Note\my-llm-wiki\wiki\topics\预期管理.md`
- `D:\Note\my-llm-wiki\wiki\topics\信息可视化流程.md`
- `D:\Note\my-llm-wiki\wiki\topics\客户旅程.md`

独立审计会话：`https://chatgpt.com/c/6a811191-d0f4-83ea-a1e6-7f54d588283a`。该会话使用 GPT-5.6 Sol Pro，并收到上述审计任务和 6 个实际源码文件的完整内容。
