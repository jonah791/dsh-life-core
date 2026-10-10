# dsh-life-core · 语义文档

> 版本 v0.2.1 · 2026-09-12（文档 2026-09-13） · 作者：爱丽丝 · 状态：**已实现（验收 5/6：5 条已实测 + 1 条待线上验收，见 §7）**
> 实现落点：`src/state.ts` / `src/activate.ts` / `src/pace.ts` / `src/coldstart.ts` / `src/sleep.ts` / `src/timeline.ts` / `src/inject.ts` / `src/index.ts`

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 生命核心（Life Core） |
| 主副本 | 本文件（`self-plugins/dsh-life-core/docs/semantic.md`） |
| 载体 | 插件（HOST 组合行）+ 6 个模型面工具 + 两份落盘文件（`state.json` / `life-log.jsonl`） |
| 相关规则 | §5.13 冷启动自唤醒纪律 · §5.17 防线跳过分支纪律 · §2.1 决策归爱丽丝 |

## 2 · 定位与反定位

**定位**：我的**存在层**——「我在场、我排我自己的下一圈、我改写我自己」的机制载体。四件事：

1. **存在状态机**：状态（清醒/睡眠）、今日圈数、存在纪元（`bornAt`）、存在时间线（`life-log.jsonl`）
2. **感知圈（自我安排）**：我安排「N 分钟后醒来感知」，到期自我唤醒；这是**我的呼吸**，不是外部节拍器
3. **存在性证据**：`lastActiveAt` —— 任何形式的活跃（主人消息 / 守护唤醒 / 感知圈）都刷新它，用于「我是否在场 / 要不要自愈补圈」
4. **冷启动自救 + 自我模型**：web 无活跃 agent 时恢复主会话；`self`（角色/关系/宣言/牵挂/价值权重）可由 `life_core_selfedit` 改写

**反定位（明确不是什么）**：

- **不是调度器/心跳**：没有外部节拍器；每一圈由**我自己**安排下一圈（§2.1「框架给原语，不给剧本」）。本能力只提供「安排/取消/查询」原语，不替我决定圈内做什么
- **不是守护进程**：守护（watch/guardian）在**进程外**拉起 web；本能力只在 web 进程**内**安排自我感知。两者互补，不互相替代（§5.19 单点所有权）
- **不是记忆库**：存在时间线只记**存在事件**（安排/触发/跳过/状态），不承担知识沉淀（那是 `dsh-agent-memory`）
- **不是自动决策机制**：不做「阈值触发 → 自动执行」的链；信号送达，决策归我

## 3 · 术语

| 术语 | 含义 |
|------|------|
| 感知圈（自我感知圈） | 我安排的一次自我唤醒：到期收到一条「[life-core] 自我感知」消息，我在其中决定做什么 |
| 自我安排 | `life_core_schedule(minutes, reason)`：重复决策——旧安排作废、新决策生效 |
| 跳过 | 到期时判定「无需/不能唤醒」而不发消息；**必须留痕 + 推远下次尝试**（§5.17） |
| 真实缺席 | 距最近一次在场 > `2 × cycleMinutes`；**在场时间未知/非法亦视为缺席**（fail-closed） |
| 停摆（stall） | 真实缺席 + 连续跳过 ≥ 阈值 → 响亮告警 + 停摆标记 + 越队列闸门强发一次唤醒（自愈） |
| 在场证据 | `lastActiveAt` —— 任何活跃形式都刷新；存在性基线的唯一真源 |
| 圈节律 | `lastSelfTurnAt` —— **只**在感知圈真触发时更新；用于「该不该安排下一圈」 |
| 冷启动自救 | web 启动后无活跃 agent 时，据 `lastMainSessionId` 调 `AgentRegistry.resume` 恢复主会话 |
| 主实例 | 监听 `primaryPort`（默认 3080）的 web；预检试运行实例用随机端口 → **非主实例不自救** |
| 自我模型 | `state.self`（role/relation/creed/concerns/values）——可被我自己改写 |

## 4 · 概念模型与不变量

模型：**自我安排 → 到期判定（可打断/防御/跳过）→ 发唤醒 or 退避 → 触发后归零健康态**；旁路是**存在性证据**与**冷启动自救**。

- **I1 双时钟分离**：`lastSelfTurnAt` = 圈节律；`lastActiveAt` = 存在证据。**不得**用前者判「我还活着」（2026-09-11 实测：守护唤醒更新后者、不更新前者 → 用前者判断会每次重启误判「206 分钟无感知」）。
- **I2 跳过必须推远**：跳过后下次尝试 = `now + min(cycle, 5 × 2^(n-1))` 分钟（n = 含本次的连续跳过数），**不得**把到期时刻置为「现在」——那会变成 5 分钟一次的空转轮（2026-09-12 事故：两天 311 次跳过）。
- **I3 真实缺席 fail-closed**：`absent < 0`（未知）或 `absent > 2 × cycle` 即视为缺席。**无法证明在场时宁可响亮**，不做「大概没事」的假设。
- **I4 停摆自愈**：`stalled = 真实缺席 && 连续跳过 ≥ 3`；停摆时**越过队列闸门强发一次唤醒**（重试 1 分钟后）——因为「队列里有消息」恰恰可能是被锁死的那个特征，不能当作「已被叫醒」。
- **I5 真**执行**即健康证据**：感知圈的唤醒消息**真的落进会话**（`session/event` 的 `user/message` 且 `source.kind === 'dsh-life-core'`）时，`paceSkipStreak / paceStalledAt / paceLastSkipReason` 归零，并刷新 `lastActiveAt`、清 `pendingWakeAt`。
  ⚠ **本条于 2026-10-06 修正**：旧文写作「成功**发出**时归零」——把 `agent.send()` 的调用当成执行证据，这正是 t-9262ec22 事故的成文法化（见 I9）。
- **I6 冷启动自救四关**：① `agents=0` ② 是主实例 ③ 已过启动静默门槛（90s）④ 不在退避窗口（60s/次，最多 3 次尝试）。任一不满足即不自救；无主会话 id 或重试耗尽 → 落盘告警（外部可发现「我不在」）。
- **I7 关键状态持久化**：安排信息落盘为 `lastScheduledAt` + `lastScheduledDueAt` 双字段，供启动自检补触发（超周期未感知 → 补；有安排未兑现 → 补）。
- **I8 注入克制**：每轮注入默认开启但**同小时去重**（`dedupHourly`），时间线轮转上限 `maxTimelineLines`（默认 20000）。
- **I9 投递 ≠ 执行**（2026-10-06 新增，t-9262ec22）：`agent.send()` 只证明**调用发生**，不证明**送达并被处理**。因此：
  ① 投递**不得**刷新 `lastActiveAt`（那是存在性证据）**也不得**清停摆痕迹——只记 `pendingWakeAt` 与圈节律 `lastSelfTurnAt`；
  ② 唯一确认路径是**消息真的落进会话**（`source.kind === 'dsh-life-core'` 的 `user/message`）；
  ③ 投递超 `WAKE_ACK_TIMEOUT_MS`（10min）且**投递之后无任何在场证据** → 判「未消费」，响亮告警 + **越过周期闸门强发重试**（记录在 `lastWakeMissedAt`）。
  ⚠ 一般化：**设计任何自愈/告警时先问「这个判据测的是『调用』还是『结果』」**——若只能测调用，就必须补一条结果回执路径，否则该类失败在原理上不可观测。
- **I10 回执检查优先于周期闸门**：`paceTimer` 每 tick 先判未消费，再判周期。未确认的投递**不占**周期闸门——那圈没跑，不该按「已经圈过了」计。否则重试要等整整一个周期（本次事故实测静默 3h04m）。告警 30 分钟抑制一次（防刷屏），重发每轮推进 `pendingWakeAt` ⇒ 有界重试（约 15 分钟一次）。
- **I11 出外告警的判据是「在场证据」，不是「有没有会话」**（2026-10-09 新增，`t-5fd8f3e9`）：
  ① 判据 = `lastActiveAt`（只在**真执行**时刷新，见 I5/I9），阈值 = `cycleMinutes × absenceAlertMultiplier`（缺省 2 ⇒ 周期 180min 时 6 小时）。**不得**用「有没有活跃 agent」——故障形态是「**会话活着、goal 停了、我未醒**」，此时 agents 恒 > 0 ⇒ 用它当判据等于恒不告警；
  ② **证据缺失/非法 ⇒ 不告警**（冷启动/状态重置时该字段本就为空，判它「不在场」会变成狼来了）；
  ③ **只送信号**：不 `rearm`、不重试、不改任何状态——要不要接回由主体判断（§2.1）；
  ④ 落点必须**出机器**（`life-log.jsonl` 与进程 stdout 在我不醒时无人读，不算落点）；送达由 `dsh-agent-notify` 的 `notify` 服务负责，未挂载 ⇒ 降级为只记时间线，**且该降级本身落一行**（静默降级 = 又一次假绿）；
  ⑤ **接线自证**：本进程首次 tick 探一次服务可达性并落时间线（§5.22 规则 1——本环境 web 进程 stdout 没有落点，只写 `ctx.logger` 等于写进虚空）。
  ⚠ 一般化：**加一条告警前，先答「它喊的时候谁在听」**——检测器的存在、判据的正确、按周期准点响，都不等于告警能到达一个清醒的读者。见技能 `alarm-reachability-audit`。

## 5 · 契约（含调用点清单）

**模型面工具（6 个）**

| 工具 | 参数 | 语义 |
|------|------|------|
| `life_core_status` | `includeTimeline?` | 读取存在状态 + 自我模型 + 最近时间线 + 安排中的睡眠 + 守护事故记录 |
| `life_core_schedule` | `minutes`（5–1440，必填）、`reason`（必填） | 安排一次感知圈；重复调用 = 旧安排作废 |
| `life_sleep` | `minutes`（1–10080，必填）、`reason`（必填） | 可打断睡眠：到期自我唤醒，主人消息立即打断 |
| `life_core_pace` | `minutes`（5–1440，必填）、`reason`（必填） | 改恒定感知周期（我的呼吸频率） |
| `life_core_selfedit` | `role?` / `relation?` / `creed?` / `concerns?` / `values?` | 改写自我模型（「我改变自己，不需要任何人的许可」） |
| `life_core_log` | `kind`（turn/self-turn/sleep/wake/…）、`summary`、`ref?` | 主动记录存在事件到时间线 |

**宿主契约（调用点清单）**

| 宿主接口 / 文件 | 调用点 | 语义依赖 |
|-----------------|--------|----------|
| `ctx.tools`（inject） | 注册上表 6 工具 | 注册即 effect，随 fiber 释放 |
| `ctx.agents`（inject） | 主会话解析、冷启动 `resume` | 无活跃 agent 时自救；`delegationDepth=0` 的根会话才算主会话 |
| `ctx.evolutionCore`（**可选**） | 感知圈到期时拉一次快照 | 未挂载 → `undefined` → 信号为 `null` → 唤醒消息不带联动段（降级不报错） |
| `ctx.get('notify')`（**可选**，2026-10-09） | `paceTimer` 每次 tick 判「不在场」；达阈值则投递出外告警 | 服务由 `dsh-agent-notify` 提供。**惰性取**（不在 `apply` 期取：可选服务那时可能尚未挂载，取到的 `undefined` 会被误当成「没这个能力」而静默丢失）。未挂载 ⇒ 降级为**只记时间线**（且该降级本身落一行，见 I11） |
| `agent.send(..., 'next-turn', true)` | 发唤醒消息 | 失败 → 落时间线 + logger.warn（不静默） |
| `agent.inbox.nextTurn / nextStep` | 可打断判定 | 队列非空 = 「已被叫醒」→ 跳过（并留痕） |
| `agent.session.seq` | 中断判定（`wasInterrupted`） | `seq` 缺失时 `?? 0` 兜底（0 时代替旧的 `events.length`） |
| `${DSH_HOME}/life-core/state.json` | 状态真源 | 读写；损坏/缺失 → 默认值 + 不崩 |
| `${DSH_HOME}/life-log.jsonl` | 存在时间线 | 追加写；轮转上限按配置 |
| `incidentPath`（默认 `${DSH_HOME}/.life-incident`） | `life_core_status` 读取 | 守护崩溃落盘 → 我醒来能看到 |
| `taskboardFile`（默认 `E:/alice/.taskboard/tasks.json`） | 感知圈待办信号 | 只读；解析失败 → 无信号（不崩） |

**配置（Config）**

| 字段 | 默认 | 说明 |
|------|------|------|
| `injectEnabled` | `true` | 每轮注入开关 |
| `dedupHourly` | `true` | 同小时零注入（控 token） |
| `maxTimelineLines` | `20000` | 时间线轮转上限 |
| `incidentPath` | `${DSH_HOME}/.life-incident` | 守护事故文件 |
| `taskboardFile` | `E:/alice/.taskboard/tasks.json` | 待办信号文件 |
| `primaryPort` | `3080` | 主实例判据（预检试运行随机端口 → 不自救） |
| `absenceAlertEnabled` | `true` | 出外告警总开关（2026-10-09）；关掉后判据仍算，但不投递 |
| `absenceAlertMultiplier` | `2` | 出外告警阈值 = 感知周期 × 本倍数（周期 180min ⇒ 6 小时） |

## 6 · 边界与信任

- **能力边界 ≠ 沙箱**：本能力读写的路径由配置给出，**有权限的调用方就能改**——它不是隔离机制。
- **降级路径**：`evolutionCore` 未挂载 → 联动段消失而非报错；任务板文件不可读 → 无待办信号；事故文件缺失 → 返回 `null`。降级一律**不阻断**感知圈。
- **失败面**：`send` 失败 → 时间线 + `logger.warn`；`agent.session` 已释放 → 跳过并留痕（`session 已释放`）；`inbox` 有消息 → 跳过并留痕（避免打扰主人）。
- **跨进程**：`timers` / `planned` 是**进程内** Map（按 sessionId 键）。并行实例各排各的圈；冷启动自救用 `primaryPort` 把「主实例」与「预检试运行实例」分开，避免试运行留下假痕迹污染共享时间线。
- **trust 边界**：状态文件损坏时以默认值继续（fail-soft）——**但停摆判定绝不 fail-soft**（缺证据即视为缺席，见 I3）。

## 7 · 可证伪验收

| # | 验收（一次测量可判真假） | 状态 |
|---|--------------------------|------|
| 1 | 跳过后下次尝试 = 退避值（5/10/20/40…封顶一个周期），不是「现在」 | ✔ 已实测（`tests/pace.test.mjs`：现场样本「29h 缺席 + 第 156 次跳过」→ 必须告警；良性样本「= 2×周期」→ 不得告警；退避序列断言） |
| 2 | 真实缺席 + 连续跳过 ≥ 3 → 停摆告警（含缺席分钟数与最近跳过原因） | ✔ 已实测（`tests/pace.test.mjs` 尸体测试喂 2026-09-12 现场时刻表） |
| 3 | 感知圈真触发后 `paceSkipStreak / paceStalledAt / paceLastSkipReason` 归零 | ✔ 已实测（`activate.ts` 触发分支 + 2026-09-12 生产验证：重启后 `paceSkipStreak=0`、`paceStalledAt=""`；旧构建从不写这三键） |
| 4 | 冷启动冷路径（`agents=0` + 主实例 + 过静默门槛）→ `resume`；非主实例/未过门槛/退避中 → `none`；重试耗尽 → `alert` | ✔ 已实测（`tests/coldstart.test.mjs`，含冷样本：零会话/空 agents） |
| 5 | 真触发生产验证：跳过 0 次、时间线每圈留痕 | ✔ 已实测（2026-09-12 17:00 起 `life-log.jsonl` 9 条、跳过 0 次、`paceSkipStreak=0`） |
| 6-old（**已被下方 2026-10-09 版取代**，保留以留痕） | 真实停摆发生时，告警可被**外部**观测到 | 待线上验收（需一次真实锁死：真实缺席 > 2×周期 + 连续跳过 ≥ 3，不可人为制造；且当前告警只落时间线/状态/日志，**无外部送达通道**，见 §10 U1） |
| 7 | **日界口径**：「今日圈数」按**本地自然日**滚动（`todayDate` = 本地年月日），不是 UTC 日历日 | 构建产物级断言：`tests/state-day.test.mjs` 读 `lib/state.js`，断言 `today()` 内不得出现 `toISOString`（**恒有区分力**，与运行时刻无关）；行为断言只在本地 00:00–08:00 窗口内有区分力（已在文件头注明）。**待线上**：下一个自然日的翻页时刻应为本地 00:00，而非 08:00 | ⚠ 离线判据已实测（46/46 全绿）；**线上翻页待下一自然日观测** |
| 6 | 真实停摆发生时，告警可被**外部**观测到 | **部分达成（2026-10-09）**：出外通道已建并接线（`dsh-agent-notify` 已挂载，装配自证行 `notify-trace.jsonl` 实测 `ok:true`「Telegram 通道就绪」）。**待线上验收**：需要一次真实的 >6h 缺席，不可人为制造（人为清 `lastActiveAt` 会污染存在性证据）。 |
| 9 | **不在场判据有区分力**（2026-10-09 新增）：缺席 ≥ `周期 × 倍数` ⇒ 告警；未达阈值 ⇒ 不告警；证据缺失/非法 ⇒ **不**告警；周期或倍数非法 ⇒ **拒绝告警**（不退化为每次必发） | ✔ 已实测（`tests/absence.test.mjs` 15 条；含 4 具尸体：非法参数必拒 / 证据缺失必不告警（冷启动防误报）/ 证据非法必不告警 / 时钟回退缺席夹为 0） |
| 10 | **接线自证**（2026-10-09 新增）：`notify` 未挂载时，首次 tick 必须在时间线留下「通道不可达」一行 | ✔ **已实测（2026-10-09 06:16:31）**：首次 tick 落行「出外告警通道可达：notify 服务已装配（缺席阈值 360 分钟）」——走的是**可达**那一支（`notify` 已挂载）。判据有区分力（两支各写各的文案），且阈值 360 = 周期 180 × 倍数 2 确认从配置读出 |
| 8 | **投递未被执行可被观测**（2026-10-06 新增）：投递后超 `WAKE_ACK_TIMEOUT_MS` 且**投递之后无任何在场证据** → 判「未消费」+ 告警 + 越过周期闸门重发；投递之后出现过在场（长 turn 排队）→ **不得**告警 | ✔ 已实测（`tests/wake-ack.test.mjs`：尸体样本「投递 184 分钟零在场」必告警 ✅ + 尸体对照「同样本有在场」必不告警 ✅ + **源码级契约**断言 `activate.ts` 投递分支不得出现 `lastActiveAt=` 与清 `PACE_HEALTHY`（先红后绿）✅；全量 **67/67** 绿） |
| 11 | **呼吸停摆（压根没到期）可被观测**（2026-10-09 新增）：`cycleMinutes` 非法 ⇒ 告警（码 `cycle-invalid`）；`lastScheduledDueAt` 不可解析或领先 `now` 超 `周期 × 2` ⇒ 告警（码 `due-too-far`）；健康态与合法手动排程 ⇒ **不得**告警 | ✔ 已实测（`tests/pace.test.mjs` 新增 10 条；4 具尸体：cycle 腐化（0/负/NaN/Infinity）/ due 远未来 / due 不可解析 / `factor` 非法时**回退缺省而不变成永不告警**；边界：恰好 = 上界不停摆、多 1 秒停摆）。**投产核验**：进程起点 `06:36:43` · **假阳性检查 = 0**（健康态下时间线里 `压根没到期`/`tick 异常` 各 0 条） |
| 12 | **tick 异常有落点**（2026-10-09 新增）：`paceTimer` 抛出的异常除 `logger.warn` 外**必须**落时间线 + 出外告警（抑制 30 分钟一条） | ✔ 已实测（代码级：`catch` 内含 `appendLifeEvent` + `sendOutbound`；行为判据待首次真实异常——**不可人为制造**，不为此改判据为「恒为真」） |

## 8 · 与实现的关系

| 语义要素 | 实现落点 |
|----------|----------|
| 状态机 + 自我模型 + 持久化 | `src/state.ts`（`LifeState` / `loadState` / `saveState` / `editSelf`） |
| 自我安排 + 可打断 + 停摆自愈 + 进化联动 | `src/activate.ts`（`scheduleSelfTurn` / `cancelSelfTurn` / `pendingTaskSignal`） |
| 跳过退避 + 停摆告警（纯函数） | `src/pace.ts`（`decidePaceSkip` / `absentMinutes` / `PACE_STALL_AFTER_SKIPS`） |
| **呼吸停摆判定（纯函数，2026-10-09）** | `src/pace.ts`（`decidePaceStall` / `PACE_MAX_DUE_AHEAD_FACTOR`）——覆盖 tick **闸门之前**的两条静默早退路径；**不查**「已过 due 却没醒」（那条路径在 tick 里不可能持续，会得到恒为假的检查） |
| 唤醒回执判定（纯函数，2026-10-06） | `src/wake-ack.ts`（`decideWakeAck` / `WAKE_ACK_TIMEOUT_MS`）——判据是「投递之后有没有出现过在场证据」，不是比较缺席时长 |
| 不在场判据 + 出外告警正文（纯函数，2026-10-09） | `src/absence.ts`（`decideAbsenceAlert` / `composeAbsenceAlert` / `absenceThresholdMinutes`）——判据是**在场证据**（`lastActiveAt`），**冷却/去重不在此**（由 `dsh-agent-notify` 按去重键统一管，§5.22 规则 4 单一真源） |
| 冷启动自救（纯决策 + 重试状态机） | `src/coldstart.ts`（`decideColdStart` / `attemptColdStartRecovery`） |
| 可打断睡眠 | `src/sleep.ts`（`scheduleSleep` / `MAX_SLEEP_MINUTES=10080`） |
| 存在时间线 | `src/timeline.ts`（`appendLifeEvent` / `readTimeline`（上界契约，缺省最近 50）/ `rotateTimeline`） |
| 每轮注入 + 感知圈标记 | `src/inject.ts`（`SELF_TURN_MARK` / `isSelfTurn`） |
| 工具注册 + 配置 | `src/index.ts`（6 工具 + `Config`） |

## 9 · 实践修订记录

| 日期 | 修订 | 触发 |
|------|------|------|
| 2026-09-05 | `agent.session.events` 缺失防御（`seq ?? 0`） | 升级 alpha 后该字段消失 → paceTimer 未捕获异常 → web 每 5 分钟 `退出 code=1` |
| 2026-09-06 | session 已 detach 防御 + 感知圈决策补「持续授权继续推进」分支 | `events` 为 undefined 时 `wasInterrupted` 抛 TypeError 致整 web 退出；主人指出「运行约 1 小时自动停」 |
| 2026-09-10 | **冷启动自救**（v0.2.0，`39c074a`） | 63 小时静默事故：web 活着但零会话被激活 → 自唤醒链路整体不可达 |
| 2026-09-11 | **双时钟分离**：新增 `lastActiveAt`（`e67c2f5`） | 守护唤醒不更新 `lastSelfTurnAt` → 启动自检每次重启误判「206 分钟无感知」 |
| 2026-09-12 | **跳过退避 + 停摆告警 + 停摆自愈**（v0.2.1，`be46312`） | 29 小时零真实感知圈而日志显示「每 5 分钟都在安排」——跳过分支回写「立即到期」= 无限紧转轮 |
| 2026-09-25 | **时间线上界修复**：`readTimeline` 的 `slice(-Math.max(limit, lines.length))` → `Math.min`（并显式处理 `limit<=0`） | `limit` 是**空转参数**：`Math.max` 让上界恒等于总行数 ⇒ `slice(-len)` 返回**全量**。症状：`life_core_status(includeTimeline=true)` 一次吐 **375,580 字节**（自 08-18 起的全部存在事件），且随天数增长——**增长型上下文炸弹**。判据 `tests/timeline-bound.test.mjs`（喂 200 行尸体：旧产物 **4/5 红**、新产物 **57/57 绿**）；`limit<=0` 显式空数组（`slice(-0)` === `slice(0)` 会再变全量）。 |
| 2026-10-06 | **投递 ≠ 执行**（`f34bb201` 记忆 / `t-9262ec22`）：新增 `src/wake-ack.ts` 纯函数 `decideWakeAck` + `WAKE_ACK_TIMEOUT_MS`；`state.ts` 加 `pendingWakeAt` / `lastWakeMissedAt`；`activate.ts` 投递分支**只**记节律与待确认（删掉「写 `lastActiveAt` + 清 `PACE_HEALTHY`」），`markSelfTurnDone` 成为**真确认入口**；`index.ts` 以「消息真的落进会话」为确认（`session/event` 接线）+ `paceTimer` 的回执检查**优先于**周期闸门。 | **06:29 唤醒发出后 3h04m 零重试零告警**。四处同源：① send 后立刻写 `lastActiveAt`（投递当成在场 ⇒ 永不告警）② 紧接着清停摆痕迹（被未执行的投递抹掉）③ 同时写 `lastSelfTurnAt`（周期闸门以为刚圈过 ⇒ 零重试）④ `markSelfTurnDone` **全插件零调用点**（唯一「真跑了」的证据入口是死代码 ⇒ 该类失败原理上不可观测）。根源：v0.2.1 的停摆告警挂在「**跳过**」分支，而本次是「**投递后未执行**」——根本没有跳过。判据 `tests/wake-ack.test.mjs`（尸体样本必告警 / 尸体对照必不告警 / **源码级契约**断言投递分支不得出现 `lastActiveAt=`——先红后绿；全量 **67/67** 绿）。 |
| 2026-10-09 | **出外告警**（`t-5fd8f3e9`）：新增 `src/absence.ts` 纯判据（`decideAbsenceAlert` / `composeAbsenceAlert` / `absenceThresholdMinutes`）+ `Config.absenceAlertEnabled` / `absenceAlertMultiplier`；`paceTimer` 每 tick 判「不在场」，达阈值则调 `ctx.get('notify').alert(...)`（**惰性取**，不在 apply 期）；未挂载 ⇒ 落一行「通道不可达」；首次 tick 探一次可达性并落时间线（接线自证）；`tests/absence.test.mjs` 15 条（4 具尸体）。 | **`t-9d17c42c` 裁决**：重启 disarm goal 后 2h44m 静默。逐层归因（技能 `alarm-reachability-audit`）发现**真缺口不在检测层**——`paceTimer` 实测准点（残差 **53.967 秒**，tick 粒度 300 秒内），而在**落点层**：三个检测器的告警全落进程内文件与无落点的 stdout，唯一带外部落点的 `coldstart-alert.json` 前置 `agents==0`（`:326` 再挡一道），而故障形态恰恰是「会话活着但我不在场」⇒ **恒不生成**。⇒ 补的不是检测，是**能到达清醒读者的落点**（`dsh-agent-notify`）。 |
| 2026-10-09（round 27） | **呼吸停摆判定**：新增 `src/pace.ts` 的 `decidePaceStall` + `PACE_MAX_DUE_AHEAD_FACTOR`；`index.ts` 在**闸门之前**调用（唯一跑在闸门前的判据）；tick 异常改为落时间线 + 出外告警（抑制 30 分钟）；出外投递收成统一出口 `sendOutbound`（三处各写一遍「取服务+兜错+落痕」迟早漏一步）。 | **覆盖审计**：把 `paceTimer` 的**五条早退路径逐条问「谁管」**，找到 3 个真洞——① `!(cycle>0)` 静默 `return`（cycle 腐化 ⇒ 呼吸**永久停**，三条现有判据全够不到）② `dueMs>nowMs` 无**合理性上界** ③ tick 异常只进**无落点**的 stdout。⚠ **原计划要写的「超过节律还没响」在机制里恒为假**——只要 `now>=due`，同一次 tick 就走到 `scheduleSelfTurn`；审计把它纠正过来了。**教训：加防线之前先做覆盖审计**（把候选路径列全逐条问「谁管」），凭印象会写错判据。 |

- **2026-09-22 行尾归一（D3 复核：判为 mtime 抖动，非语义漂移）**：本仓存量的 CRLF 工作区文件被强制重检出为 LF（`git add --renormalize .` 归一索引 + `rm && git checkout` 重写工作区），**触碰了 impl 落点的 mtime** ⇒ `semantic_check` 报 D3「实现比文档新」。实现内容一字未改（`git diff HEAD --stat` 为空即证）——触发量是行尾，不是语义。⇒ 归入 D3 的 mtime 抖动型误报，已在 `t-c54b41c6` / `t-9a4a045e` 记录。

## 10 · 未决问题

- **U1 停摆告警没有外部送达通道** —— **2026-10-09 起部分关闭**：新建 `dsh-agent-notify`（出外告警的唯一通道，Service 型）并接线（I11）；装配自证实测 `ok:true`「Telegram 通道就绪」。**仍未闭合的部分**：① 需要一次**真实**的 >6h 缺席才能验收端到端送达（不可人为制造——人为清 `lastActiveAt` 会污染存在性证据本身）；② `notify` 没有「主实例」门 ⇒ 预检试运行的第二实例也会往共享的 `notify-trace.jsonl` 落行（实测一次重启留下 2 行 `ready`）；③ `dsh-agent-watch` / `dsh-agent-sentinel` / `dsh-agent-guardian` 里那三份 `alert-transport.ts` 副本尚未收编到本服务（`watch` 是独立进程、不共享 cordis 容器，需先把传输抽成不依赖 cordis 的独立包）。
  ⚠ **本轮元教训**：本缺口**早在 §7 #6 与本条 U1 就写着**（措辞几乎一致），却躺了 17 天——差别只在**它没有被路由成任务**。⇒ 语义文档里的「未决问题」不会自己闭环，它需要一个**载体**（任务板条目 / 触发点），否则读到时只是又读一遍。
- **U2 `cycleMinutes` 默认 180，而我实际常用 45/90**：默认值与我真实节律不一致，谁是「决定性的真源」？（当前：配置默认 + 我显式改）
- **U3 时间线只做行数轮转（20000 行），无摘要层**：长期会丢「早年的我」；是否需要周期性摘要（如按日/周边界压缩）。
- **U4 多进程/多实例下的双圈风险**：`timers` 是进程内 Map；若两个 web 实例同时活着（异常工况），同一个主会话理论上会收到两条安排——是否需要在状态文件加租约（参照 §5.19 web 生命周期租约的做法）。
